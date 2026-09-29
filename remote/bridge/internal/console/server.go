// Package console is the local web console on 127.0.0.1:47831 (embedded single-page app + JSON API).
//
// Protection: every request must carry Host 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding).
// The page load sets a random per-run token as an HttpOnly SameSite=Strict cookie, and /api/* requires that
// cookie plus a same-origin Origin header (when the browser sends one), so other websites can neither read
// nor drive the API. /internal/agents/ (used by the bridge's own helper processes) skips the cookie but is
// still loopback-only and checks its own token inside the agents package.
package console

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"salcara/bridge/internal/agents"
	"salcara/bridge/internal/config"
	"salcara/bridge/internal/hubclient"
	"salcara/bridge/internal/protocol"
)

//go:embed web
var webFS embed.FS

// CookieName holds the per-run console token.
const CookieName = "salcara_console"

// Deps are what the console needs from the rest of the program.
type Deps struct {
	Store   *config.Store
	Hub     *hubclient.Client
	Version string
	Port    int
	LogPath string
	Exe     string
	Dir     string // config / log folder (for "打开文件夹")
	Logger  *log.Logger
	Quit    func()
}

// Server is the console.
type Server struct {
	d     Deps
	token string
	log   *log.Logger

	mgrMu sync.RWMutex
	mgr   agents.Manager

	subMu sync.Mutex
	subs  map[chan sseMsg]struct{}

	pendMu  sync.Mutex
	pending map[string]protocol.Event

	byMu      sync.Mutex
	byDesktop map[string]time.Time

	usageMu   sync.Mutex
	usageAt   time.Time
	usageKey  string
	usageData map[string]any
	usageErr  string
}

type sseMsg struct {
	event string
	data  []byte
}

// New creates the console server.
func New(d Deps) *Server {
	if d.Logger == nil {
		d.Logger = log.New(io.Discard, "", 0)
	}
	return &Server{
		d:       d,
		token:   config.RandomToken(24),
		log:     d.Logger,
		subs:    map[chan sseMsg]struct{}{},
		pending: map[string]protocol.Event{},

		byDesktop: map[string]time.Time{},
	}
}

// SetManager attaches the agents manager.
func (s *Server) SetManager(m agents.Manager) {
	s.mgrMu.Lock()
	s.mgr = m
	s.mgrMu.Unlock()
}

func (s *Server) manager() agents.Manager {
	s.mgrMu.RLock()
	defer s.mgrMu.RUnlock()
	return s.mgr
}

// Token is the per-run cookie value (exposed for tests).
func (s *Server) Token() string { return s.token }

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(static))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: CookieName, Value: s.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		b, err := webFS.ReadFile("web/index.html")
		if err != nil {
			http.Error(w, "missing index", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"service": "salcara-bridge", "version": s.d.Version})
	})
	mux.Handle("/internal/agents/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		m := s.manager()
		if m == nil {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		m.LocalHandler().ServeHTTP(w, r)
	}))
	api := http.NewServeMux()
	s.routes(api)
	mux.Handle("/api/", s.requireAuth(api))

	return s.hostGuard(securityHeaders(mux))
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
		h.ServeHTTP(w, r)
	})
}

// allowedHost reports whether the Host header names this console.
func (s *Server) allowedHost(host string) bool {
	p := strconv.Itoa(s.d.Port)
	return host == "127.0.0.1:"+p || host == "localhost:"+p
}

func (s *Server) allowedOrigin(origin string) bool {
	p := strconv.Itoa(s.d.Port)
	return origin == "http://127.0.0.1:"+p || origin == "http://localhost:"+p
}

func (s *Server) hostGuard(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (s *Server) requireAuth(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" && !s.allowedOrigin(o) {
			writeErr(w, http.StatusForbidden, "来源不被允许")
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeErr(w, http.StatusForbidden, "来源不被允许")
			return
		}
		c, err := r.Cookie(CookieName)
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.token)) != 1 {
			writeErr(w, http.StatusUnauthorized, "控制台会话已过期，请刷新页面")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				writeErr(w, http.StatusUnsupportedMediaType, "需要 JSON")
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

func isLoopback(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ---- live updates ----

// Broadcast forwards an agent event to every open console page and tracks pending approvals.
func (s *Server) Broadcast(ev protocol.Event) {
	if ev.TS == 0 {
		ev.TS = time.Now().UnixMilli()
	}
	switch ev.Type {
	case "approval.request":
		s.pendMu.Lock()
		s.pending[ev.ApprovalID] = ev
		s.pendMu.Unlock()
	case "approval.resolved":
		s.pendMu.Lock()
		delete(s.pending, ev.ApprovalID)
		s.pendMu.Unlock()
	}
	b, _ := json.Marshal(ev)
	s.publish(sseMsg{event: "event", data: b})
}

func (s *Server) markDesktop(id string) {
	s.byMu.Lock()
	defer s.byMu.Unlock()
	for k, t := range s.byDesktop {
		if time.Since(t) > 10*time.Minute {
			delete(s.byDesktop, k)
		}
	}
	s.byDesktop[id] = time.Now()
}

// Attribute marks approvals answered in this console as resolved "by desktop". The agents report every
// Respond() as coming from the phone, so the core passes each event through here before fan-out.
func (s *Server) Attribute(ev protocol.Event) protocol.Event {
	if ev.Type != "approval.resolved" {
		return ev
	}
	s.byMu.Lock()
	if _, ok := s.byDesktop[ev.ApprovalID]; ok {
		delete(s.byDesktop, ev.ApprovalID)
		ev.By = "desktop"
	}
	s.byMu.Unlock()
	return ev
}

// BroadcastStatus pushes a hub status change.
func (s *Server) BroadcastStatus(st hubclient.Status) {
	b, _ := json.Marshal(st)
	s.publish(sseMsg{event: "status", data: b})
}

func (s *Server) publish(m sseMsg) {
	s.subMu.Lock()
	defer s.subMu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- m:
		default: // slow page; it will resync on reconnect
		}
	}
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	ch := make(chan sseMsg, 256)
	s.subMu.Lock()
	s.subs[ch] = struct{}{}
	s.subMu.Unlock()
	defer func() {
		s.subMu.Lock()
		delete(s.subs, ch)
		s.subMu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	if s.d.Hub != nil {
		b, _ := json.Marshal(s.d.Hub.Status())
		writeSSE(w, "status", b)
	}
	fl.Flush()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-ch:
			writeSSE(w, m.event, m.data)
			fl.Flush()
		case <-ping.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func writeSSE(w io.Writer, event string, data []byte) {
	_, _ = io.WriteString(w, "event: "+event+"\ndata: ")
	_, _ = w.Write(data)
	_, _ = io.WriteString(w, "\n\n")
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return errors.New("请求格式有误")
	}
	return nil
}

func ctxTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
