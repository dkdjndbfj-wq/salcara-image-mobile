package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// errUpstream means sub2api could not give a definitive answer (network
// error, 5xx, its own rate limit). Such results are never cached.
var errUpstream = errors.New("sub2api unavailable")

type authEntry struct {
	valid bool
	exp   time.Time
}

type authCall struct {
	done  chan struct{}
	valid bool
	err   error
}

// authenticator validates relay keys against sub2api GET /v1/usage and caches
// the verdict keyed by sha256(key). The key itself is never stored.
type authenticator struct {
	cfg *Config

	mu       sync.Mutex
	cache    map[[32]byte]authEntry
	inflight map[[32]byte]*authCall
}

func newAuthenticator(cfg *Config) *authenticator {
	return &authenticator{cfg: cfg, cache: map[[32]byte]authEntry{}, inflight: map[[32]byte]*authCall{}}
}

// AccountID returns hex(sha256(key))[:24].
func AccountID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:24]
}

// cachedValid reports whether key is cached as valid.
func (a *authenticator) cachedValid(key string) bool {
	h := sha256.Sum256([]byte(key))
	a.mu.Lock()
	defer a.mu.Unlock()
	e, ok := a.cache[h]
	return ok && e.valid && time.Now().Before(e.exp)
}

// check returns whether key is a valid relay key. Concurrent checks of the same
// key share one upstream request.
func (a *authenticator) check(ctx context.Context, key string) (bool, error) {
	h := sha256.Sum256([]byte(key))
	a.mu.Lock()
	if e, ok := a.cache[h]; ok && time.Now().Before(e.exp) {
		a.mu.Unlock()
		return e.valid, nil
	}
	call, ok := a.inflight[h]
	if !ok {
		call = &authCall{done: make(chan struct{})}
		a.inflight[h] = call
		a.mu.Unlock()
		// Detached from the caller's context so one impatient client does not
		// fail the shared lookup for everyone else.
		call.valid, call.err = a.query(key)
		a.mu.Lock()
		delete(a.inflight, h)
		if call.err == nil {
			ttl := a.cfg.InvalidTTL
			if call.valid {
				ttl = a.cfg.ValidTTL
			}
			a.cache[h] = authEntry{valid: call.valid, exp: time.Now().Add(ttl)}
		}
		a.mu.Unlock()
		close(call.done)
		return call.valid, call.err
	}
	a.mu.Unlock()
	select {
	case <-call.done:
		return call.valid, call.err
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func (a *authenticator) query(key string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), a.cfg.AuthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.Sub2APIURL+"/v1/usage", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	resp, err := a.cfg.HTTPClient.Do(req)
	if err != nil {
		return false, errUpstream
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	switch {
	case resp.StatusCode == http.StatusOK:
		return true, nil
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return false, nil
	default:
		// 429 (sub2api's own invalid-auth limiter), 5xx, anything unexpected.
		return false, errUpstream
	}
}

func (a *authenticator) sweep(now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for k, e := range a.cache {
		if now.After(e.exp) {
			delete(a.cache, k)
		}
	}
}

// failLimiter counts failed authentications per client IP in fixed windows.
type failLimiter struct {
	limit  int
	window time.Duration

	mu sync.Mutex
	m  map[string]*failWindow
}

type failWindow struct {
	start time.Time
	count int
}

func newFailLimiter(limit int, window time.Duration) *failLimiter {
	return &failLimiter{limit: limit, window: window, m: map[string]*failWindow{}}
}

func (l *failLimiter) blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.m[ip]
	return ok && time.Since(w.start) < l.window && w.count >= l.limit
}

func (l *failLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.m[ip]
	if !ok || now.Sub(w.start) >= l.window {
		l.m[ip] = &failWindow{start: now, count: 1}
		return
	}
	w.count++
}

func (l *failLimiter) sweep(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for ip, w := range l.m {
		if now.Sub(w.start) >= l.window {
			delete(l.m, ip)
		}
	}
}

// bearerKey extracts the key from "Authorization: Bearer <key>".
func bearerKey(r *http.Request) string {
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// clientIP returns the peer IP, or the right-most X-Forwarded-For entry when
// the hub sits behind a trusted proxy (nginx appends $remote_addr last).
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
