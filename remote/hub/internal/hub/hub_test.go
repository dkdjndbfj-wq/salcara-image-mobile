package hub

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	keyA = "sk-good-key-a"
	keyB = "sk-good-key-b"
)

// fakeSub2API accepts keyA/keyB on GET /v1/usage, 401 otherwise. key "sk-boom"
// makes it return 500.
type fakeSub2API struct {
	*httptest.Server
	calls atomic.Int64
}

func newFakeSub2API(t *testing.T) *fakeSub2API {
	f := &fakeSub2API{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/usage" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		f.calls.Add(1)
		switch r.Header.Get("Authorization") {
		case "Bearer " + keyA, "Bearer " + keyB:
			w.Write([]byte(`{"mode":"unrestricted"}`))
		case "Bearer sk-boom":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":"INVALID_API_KEY"}`))
		}
	}))
	t.Cleanup(f.Close)
	return f
}

type env struct {
	t    *testing.T
	hub  *Hub
	srv  *httptest.Server
	fake *fakeSub2API
}

func newEnv(t *testing.T, mod func(*Config)) *env {
	t.Helper()
	fake := newFakeSub2API(t)
	cfg := Config{
		Sub2APIURL:     fake.URL,
		CommandTimeout: 2 * time.Second,
		PingInterval:   50 * time.Millisecond,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if mod != nil {
		mod(&cfg)
	}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(func() {
		h.Close()
		srv.Close()
	})
	return &env{t: t, hub: h, srv: srv, fake: fake}
}

// do sends a request to /salcara-hub/v1+path and decodes the JSON response.
func (e *env) do(method, path, key string, body any, out any) int {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	if !strings.Contains(path, "/v1/") && !strings.HasPrefix(path, "/salcara-hub/") {
		path = "/salcara-hub/v1" + path
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			e.t.Fatalf("%s %s: bad json %q: %v", method, path, b, err)
		}
	}
	return resp.StatusCode
}

func (e *env) register(key, deviceID string) {
	e.t.Helper()
	dev := map[string]any{
		"deviceId": deviceID, "name": "我的电脑", "os": "linux", "version": "1.0.0",
		"tools":    []map[string]any{{"id": "codex", "name": "Codex", "available": true}},
		"projects": []map[string]any{{"path": "/code/app", "name": "app"}},
	}
	if code := e.do("POST", "/bridge/register", key, dev, nil); code != 200 {
		e.t.Fatalf("register: %d", code)
	}
}

type sseEvent struct {
	Event string
	Data  string
}

type sseClient struct {
	events chan sseEvent
	pings  atomic.Int64
	cancel context.CancelFunc
	closed chan struct{}
}

func (e *env) stream(path, key string) *sseClient {
	e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", e.srv.URL+"/salcara-hub/v1"+path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		e.t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		e.t.Fatalf("stream %s: %d %s", path, resp.StatusCode, b)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		e.t.Fatalf("content-type %q", ct)
	}
	if resp.Header.Get("X-Accel-Buffering") != "no" {
		e.t.Fatal("missing X-Accel-Buffering: no")
	}
	c := &sseClient{events: make(chan sseEvent, 4096), cancel: cancel, closed: make(chan struct{})}
	go func() {
		defer close(c.closed)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 4<<20)
		var cur sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if cur.Event != "" || cur.Data != "" {
					c.events <- cur
				}
				cur = sseEvent{}
			case line == ": ping":
				c.pings.Add(1)
			case strings.HasPrefix(line, ":"):
			case strings.HasPrefix(line, "event: "):
				cur.Event = line[len("event: "):]
			case strings.HasPrefix(line, "data: "):
				cur.Data += line[len("data: "):]
			}
		}
	}()
	e.t.Cleanup(cancel)
	return c
}

// next returns the next SSE event of the given type, skipping others.
func (c *sseClient) next(t *testing.T, event string) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-c.events:
			if ev.Event != event {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal([]byte(ev.Data), &m); err != nil {
				t.Fatalf("bad sse data %q", ev.Data)
			}
			return m
		case <-c.closed:
			t.Fatalf("stream closed while waiting for %q", event)
		case <-deadline:
			t.Fatalf("timeout waiting for %q", event)
		}
	}
}

// nextDevice waits for a device event with the given online state.
func (c *sseClient) nextDevice(t *testing.T, deviceID string, online bool) map[string]any {
	t.Helper()
	for {
		m := c.next(t, "device")
		if m["deviceId"] == deviceID && m["online"] == online {
			return m
		}
	}
}

func waitOnline(t *testing.T, e *env, key, deviceID string, online bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		var out struct {
			Devices []DeviceStatus `json:"devices"`
		}
		e.do("GET", "/app/devices", key, nil, &out)
		for _, d := range out.Devices {
			if d.DeviceID == deviceID && d.Online == online {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("device %s never became online=%v", deviceID, online)
}

// ---------------------------------------------------------------------------

func TestPingAndRoutes(t *testing.T) {
	e := newEnv(t, nil)
	for _, p := range []string{"/salcara-hub/v1/ping", "/v1/ping", "/salcara-hub/v1/ping/"} {
		var out map[string]any
		if code := e.do("GET", p, "", nil, &out); code != 200 {
			t.Fatalf("%s: %d", p, code)
		}
		if out["ok"] != true || out["service"] != "salcara-hub" || out["version"] != Version {
			t.Fatalf("%s: %v", p, out)
		}
	}
	var out map[string]string
	if code := e.do("GET", "/salcara-hub/v2/ping", "", nil, &out); code != 404 || out["error"] != "接口不存在" {
		t.Fatalf("unknown: %d %v", code, out)
	}
	if code := e.do("POST", "/ping", "", nil, &out); code != 405 {
		t.Fatalf("method: %d", code)
	}
	// un-prefixed authenticated route
	if code := e.do("GET", "/v1/me", keyA, nil, &out); code != 200 || out["account"] != AccountID(keyA) {
		t.Fatalf("unprefixed me: %d %v", code, out)
	}
}

func TestCustomPrefix(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.Prefix = "/hub/" })
	var out map[string]any
	if code := e.do("GET", "/hub/v1/ping", "", nil, &out); code != 200 {
		t.Fatalf("custom prefix: %d", code)
	}
	if code := e.do("GET", "/v1/ping", "", nil, &out); code != 200 {
		t.Fatalf("unprefixed: %d", code)
	}
}

func TestCORS(t *testing.T) {
	e := newEnv(t, nil)
	req, _ := http.NewRequest("OPTIONS", e.srv.URL+"/salcara-hub/v1/me", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != "*" ||
		!strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("cors: %d %v", resp.StatusCode, resp.Header)
	}
}

func TestAuth(t *testing.T) {
	e := newEnv(t, nil)
	var out map[string]string

	if code := e.do("GET", "/me", "", nil, &out); code != 401 || !strings.Contains(out["error"], "API Key") {
		t.Fatalf("missing key: %d %v", code, out)
	}
	if code := e.do("GET", "/me", "sk-bad", nil, &out); code != 401 || out["error"] == "" {
		t.Fatalf("bad key: %d %v", code, out)
	}
	if code := e.do("GET", "/me", "sk-bad", nil, &out); code != 401 {
		t.Fatalf("bad key again: %d", code)
	}
	if n := e.fake.calls.Load(); n != 1 {
		t.Fatalf("invalid key should be cached, upstream calls = %d", n)
	}

	for i := 0; i < 3; i++ {
		if code := e.do("GET", "/me", keyA, nil, &out); code != 200 {
			t.Fatalf("valid key: %d %v", code, out)
		}
	}
	if out["account"] != AccountID(keyA) || len(out["account"]) != 24 {
		t.Fatalf("account = %q", out["account"])
	}
	if n := e.fake.calls.Load(); n != 2 {
		t.Fatalf("valid key should be cached, upstream calls = %d", n)
	}

	// upstream failure: 502, not cached
	if code := e.do("GET", "/me", "sk-boom", nil, &out); code != 502 {
		t.Fatalf("upstream 500: %d", code)
	}
	e.do("GET", "/me", "sk-boom", nil, &out)
	if n := e.fake.calls.Load(); n != 4 {
		t.Fatalf("upstream errors must not be cached, calls = %d", n)
	}
}

func TestAuthCacheExpiry(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ValidTTL = 50 * time.Millisecond; c.InvalidTTL = 50 * time.Millisecond })
	e.do("GET", "/me", keyA, nil, nil)
	e.do("GET", "/me", "sk-bad", nil, nil)
	time.Sleep(80 * time.Millisecond)
	e.do("GET", "/me", keyA, nil, nil)
	e.do("GET", "/me", "sk-bad", nil, nil)
	if n := e.fake.calls.Load(); n != 4 {
		t.Fatalf("expired entries should be re-checked, calls = %d", n)
	}
}

func TestAuthUpstreamUnreachable(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.Sub2APIURL = "http://127.0.0.1:1"; c.AuthTimeout = time.Second })
	var out map[string]string
	if code := e.do("GET", "/me", keyA, nil, &out); code != 502 || out["error"] == "" {
		t.Fatalf("unreachable: %d %v", code, out)
	}
}

func TestAuthRateLimit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.AuthFailLimit = 3 })
	e.do("GET", "/me", keyA, nil, nil) // cache the valid key
	for i := 0; i < 3; i++ {
		if code := e.do("GET", "/me", fmt.Sprintf("sk-bad-%d", i), nil, nil); code != 401 {
			t.Fatalf("attempt %d: %d", i, code)
		}
	}
	var out map[string]string
	if code := e.do("GET", "/me", "sk-bad-x", nil, &out); code != 429 || out["error"] == "" {
		t.Fatalf("expected 429, got %d %v", code, out)
	}
	if code := e.do("GET", "/me", keyB, nil, nil); code != 429 {
		t.Fatalf("uncached key from blocked ip should be 429, got %d", code)
	}
	if code := e.do("GET", "/me", keyA, nil, nil); code != 200 {
		t.Fatalf("cached valid key should still pass, got %d", code)
	}
	if code := e.do("GET", "/ping", "", nil, nil); code != 200 {
		t.Fatalf("ping must not be limited, got %d", code)
	}
}

func TestTrustProxyIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 1.2.3.4")
	if ip := clientIP(r, false); ip != "127.0.0.1" {
		t.Fatalf("untrusted: %s", ip)
	}
	if ip := clientIP(r, true); ip != "1.2.3.4" {
		t.Fatalf("trusted: %s", ip)
	}
}

func TestRegisterAndDevices(t *testing.T) {
	e := newEnv(t, nil)
	var bad map[string]string
	if code := e.do("POST", "/bridge/register", keyA, map[string]any{"name": "x"}, &bad); code != 400 || bad["error"] == "" {
		t.Fatalf("missing deviceId: %d", code)
	}
	e.register(keyA, "dev-1")

	var out struct {
		Devices []map[string]any `json:"devices"`
	}
	if code := e.do("GET", "/app/devices", keyA, nil, &out); code != 200 || len(out.Devices) != 1 {
		t.Fatalf("devices: %d %v", code, out)
	}
	d := out.Devices[0]
	if d["deviceId"] != "dev-1" || d["name"] != "我的电脑" || d["online"] != false || d["lastSeen"].(float64) <= 0 {
		t.Fatalf("device: %v", d)
	}
	if tools := d["tools"].([]any); len(tools) != 1 {
		t.Fatalf("tools: %v", d["tools"])
	}

	// other account sees nothing
	e.do("GET", "/app/devices", keyB, nil, &out)
	if len(out.Devices) != 0 {
		t.Fatalf("account isolation broken: %v", out.Devices)
	}

	// online while the bridge stream is open
	br := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	waitOnline(t, e, keyA, "dev-1", true)
	br.cancel()
	waitOnline(t, e, keyA, "dev-1", false)

	// stream for an unregistered device
	var er map[string]string
	if code := e.do("GET", "/bridge/stream?deviceId=nope", keyA, nil, &er); code != 404 {
		t.Fatalf("unregistered stream: %d", code)
	}
}

func TestDeviceBroadcast(t *testing.T) {
	e := newEnv(t, nil)
	app := e.stream("/app/stream", keyA)
	e.register(keyA, "dev-1")
	app.nextDevice(t, "dev-1", false)
	br := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	app.nextDevice(t, "dev-1", true)
	br.cancel()
	app.nextDevice(t, "dev-1", false)

	// a new app stream gets the current device list first
	app2 := e.stream("/app/stream", keyA)
	if m := app2.next(t, "device"); m["deviceId"] != "dev-1" {
		t.Fatalf("initial device: %v", m)
	}
}

func TestBridgeStreamReplaced(t *testing.T) {
	e := newEnv(t, nil)
	e.register(keyA, "dev-1")
	first := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	waitOnline(t, e, keyA, "dev-1", true)
	second := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	select {
	case <-first.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("old bridge stream was not closed")
	}
	// still online through the second stream
	waitOnline(t, e, keyA, "dev-1", true)

	// commands go to the new stream
	go e.do("POST", "/app/commands", keyA, map[string]any{"deviceId": "dev-1", "command": map[string]any{"type": "projects.list"}}, nil)
	env := second.next(t, "command")
	e.do("POST", "/bridge/reply", keyA, map[string]any{"deviceId": "dev-1", "commandId": env["commandId"], "ok": true}, nil)
}

func TestSSEPing(t *testing.T) {
	e := newEnv(t, nil)
	app := e.stream("/app/stream", keyA)
	time.Sleep(200 * time.Millisecond)
	if app.pings.Load() == 0 {
		t.Fatal("no keep-alive pings")
	}
}

func TestCommandRoundTrip(t *testing.T) {
	e := newEnv(t, nil)
	e.register(keyA, "dev-1")
	br := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	waitOnline(t, e, keyA, "dev-1", true)

	type result struct {
		code int
		out  map[string]any
	}
	done := make(chan result, 1)
	go func() {
		var out map[string]any
		code := e.do("POST", "/app/commands", keyA, map[string]any{
			"deviceId": "dev-1",
			"command":  map[string]any{"type": "sessions.list", "tool": "codex"},
		}, &out)
		done <- result{code, out}
	}()

	env := br.next(t, "command")
	cmdID, _ := env["commandId"].(string)
	cmd, _ := env["command"].(map[string]any)
	if cmdID == "" || env["deviceId"] != "dev-1" || cmd["type"] != "sessions.list" || cmd["tool"] != "codex" {
		t.Fatalf("envelope: %v", env)
	}

	// wrong account cannot answer it
	if code := e.do("POST", "/bridge/reply", keyB, map[string]any{"deviceId": "dev-1", "commandId": cmdID, "ok": true}, nil); code != 404 {
		t.Fatalf("foreign reply: %d", code)
	}
	reply := map[string]any{"deviceId": "dev-1", "commandId": cmdID, "ok": true,
		"result": map[string]any{"sessions": []map[string]any{{"sessionKey": "codex:t1"}}}}
	if code := e.do("POST", "/bridge/reply", keyA, reply, nil); code != 200 {
		t.Fatalf("reply: %d", code)
	}
	r := <-done
	if r.code != 200 || r.out["ok"] != true {
		t.Fatalf("command: %d %v", r.code, r.out)
	}
	sessions := r.out["result"].(map[string]any)["sessions"].([]any)
	if sessions[0].(map[string]any)["sessionKey"] != "codex:t1" {
		t.Fatalf("result: %v", r.out)
	}
	// a second reply for the same command is rejected
	if code := e.do("POST", "/bridge/reply", keyA, reply, nil); code != 404 {
		t.Fatalf("duplicate reply: %d", code)
	}

	// error reply
	go func() {
		var out map[string]any
		code := e.do("POST", "/app/commands", keyA, map[string]any{"deviceId": "dev-1", "command": map[string]any{"type": "session.send"}}, &out)
		done <- result{code, out}
	}()
	env = br.next(t, "command")
	e.do("POST", "/bridge/reply", keyA, map[string]any{"deviceId": "dev-1", "commandId": env["commandId"], "ok": false, "error": "这个会话正在电脑上运行，结束后才能继续"}, nil)
	r = <-done
	if r.code != 200 || r.out["ok"] != false || r.out["error"] != "这个会话正在电脑上运行，结束后才能继续" {
		t.Fatalf("error reply: %d %v", r.code, r.out)
	}
}

func TestCommandOfflineAndInvalid(t *testing.T) {
	e := newEnv(t, nil)
	var out map[string]string
	if code := e.do("POST", "/app/commands", keyA, map[string]any{"deviceId": "ghost", "command": map[string]any{"type": "projects.list"}}, &out); code != 404 {
		t.Fatalf("unknown device: %d %v", code, out)
	}
	e.register(keyA, "dev-1")
	if code := e.do("POST", "/app/commands", keyA, map[string]any{"deviceId": "dev-1", "command": map[string]any{"type": "projects.list"}}, &out); code != 409 || out["error"] != "电脑不在线" {
		t.Fatalf("offline: %d %v", code, out)
	}
	if code := e.do("POST", "/app/commands", keyA, map[string]any{"deviceId": "dev-1", "command": map[string]any{}}, &out); code != 400 {
		t.Fatalf("no type: %d %v", code, out)
	}
	// another account cannot command this device
	if code := e.do("POST", "/app/commands", keyB, map[string]any{"deviceId": "dev-1", "command": map[string]any{"type": "projects.list"}}, &out); code != 404 {
		t.Fatalf("foreign device: %d %v", code, out)
	}
}

func TestCommandTimeout(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.CommandTimeout = 150 * time.Millisecond })
	e.register(keyA, "dev-1")
	br := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	waitOnline(t, e, keyA, "dev-1", true)
	var out map[string]string
	start := time.Now()
	code := e.do("POST", "/app/commands", keyA, map[string]any{"deviceId": "dev-1", "command": map[string]any{"type": "projects.list"}}, &out)
	if code != 504 || out["error"] != "电脑没有响应" {
		t.Fatalf("timeout: %d %v", code, out)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("timeout took too long")
	}
	env := br.next(t, "command")
	// late reply is rejected
	if code := e.do("POST", "/bridge/reply", keyA, map[string]any{"deviceId": "dev-1", "commandId": env["commandId"], "ok": true}, nil); code != 404 {
		t.Fatalf("late reply: %d", code)
	}
}

func postEvents(t *testing.T, e *env, key, deviceID string, events ...map[string]any) map[string]any {
	t.Helper()
	var out map[string]any
	if code := e.do("POST", "/bridge/events", key, map[string]any{"deviceId": deviceID, "events": events}, &out); code != 200 {
		t.Fatalf("events: %d %v", code, out)
	}
	return out
}

func msg(sk, text string) map[string]any {
	return map[string]any{"sessionKey": sk, "tool": "codex", "ts": 1, "type": "message", "id": "m", "role": "assistant", "text": text, "final": true}
}

func TestEventFanOutAndReplay(t *testing.T) {
	e := newEnv(t, nil)
	e.register(keyA, "dev-1")
	app1 := e.stream("/app/stream", keyA)
	app2 := e.stream("/app/stream", keyA)
	appOther := e.stream("/app/stream", keyB)

	postEvents(t, e, keyA, "dev-1", msg("codex:t1", "one"), msg("codex:t1", "two"))
	postEvents(t, e, keyA, "dev-1", msg("codex:t2", "three"))

	var seqs []int64
	for i, want := range []string{"one", "two", "three"} {
		m1 := app1.next(t, "event")
		m2 := app2.next(t, "event")
		if m1["text"] != want || m2["text"] != want {
			t.Fatalf("event %d: %v / %v", i, m1, m2)
		}
		if m1["deviceId"] != "dev-1" || m1["seq"] != m2["seq"] {
			t.Fatalf("hub fields: %v", m1)
		}
		seqs = append(seqs, int64(m1["seq"].(float64)))
	}
	if !(seqs[0] < seqs[1] && seqs[1] < seqs[2]) || seqs[2]-seqs[0] != 2 {
		t.Fatalf("seq not monotonic: %v", seqs)
	}
	if seqs[0] >= 1<<53 {
		t.Fatalf("seq not JS-safe: %d", seqs[0])
	}
	select {
	case ev := <-appOther.events:
		if ev.Event == "event" {
			t.Fatalf("other account received %v", ev)
		}
	case <-time.After(100 * time.Millisecond):
	}

	// replay: a new stream with after=seq0 gets two and three, then live events
	app3 := e.stream(fmt.Sprintf("/app/stream?after=%d", seqs[0]), keyA)
	if m := app3.next(t, "event"); m["text"] != "two" {
		t.Fatalf("replay 1: %v", m)
	}
	if m := app3.next(t, "event"); m["text"] != "three" {
		t.Fatalf("replay 2: %v", m)
	}
	postEvents(t, e, keyA, "dev-1", msg("codex:t1", "four"))
	if m := app3.next(t, "event"); m["text"] != "four" {
		t.Fatalf("live after replay: %v", m)
	}

	// hub overwrites seq/deviceId sent by the bridge
	bogus := msg("codex:t1", "five")
	bogus["seq"], bogus["deviceId"] = 1, "spoof"
	postEvents(t, e, keyA, "dev-1", bogus)
	if m := app3.next(t, "event"); m["deviceId"] != "dev-1" || int64(m["seq"].(float64)) != seqs[2]+2 {
		t.Fatalf("hub fields not enforced: %v", m)
	}

	var bad map[string]string
	if code := e.do("GET", "/app/stream?after=abc", keyA, nil, &bad); code != 400 {
		t.Fatalf("bad after: %d", code)
	}
}

func TestEventValidation(t *testing.T) {
	e := newEnv(t, nil)
	var out map[string]string
	if code := e.do("POST", "/bridge/events", keyA, map[string]any{"deviceId": "dev-1", "events": []any{msg("s", "x")}}, &out); code != 404 {
		t.Fatalf("unregistered: %d", code)
	}
	e.register(keyA, "dev-1")
	if code := e.do("POST", "/bridge/events", keyA, map[string]any{"deviceId": "dev-1", "events": []any{map[string]any{"text": "no type"}}}, &out); code != 400 {
		t.Fatalf("no type: %d", code)
	}
	if code := e.do("POST", "/bridge/events", keyA, map[string]any{"deviceId": "dev-1", "events": []any{"str"}}, &out); code != 400 {
		t.Fatalf("not object: %d", code)
	}
	// notice without sessionKey is accepted (account stream only)
	postEvents(t, e, keyA, "dev-1", map[string]any{"type": "notice", "level": "warn", "text": "Codex 没有安装"})
}

func TestAppEventsPerSession(t *testing.T) {
	e := newEnv(t, nil)
	e.register(keyA, "dev-1")
	e.register(keyA, "dev-2")
	postEvents(t, e, keyA, "dev-1", msg("claude:s1", "a"), msg("claude:s2", "b"), msg("claude:s1", "c"))
	postEvents(t, e, keyA, "dev-2", msg("claude:s1", "other-device"))

	var out struct {
		Events []map[string]any `json:"events"`
	}
	if code := e.do("GET", "/app/events?deviceId=dev-1&sessionKey=claude:s1", keyA, nil, &out); code != 200 {
		t.Fatalf("events: %d", code)
	}
	if len(out.Events) != 2 || out.Events[0]["text"] != "a" || out.Events[1]["text"] != "c" {
		t.Fatalf("session events: %v", out.Events)
	}
	after := int64(out.Events[0]["seq"].(float64))
	e.do("GET", fmt.Sprintf("/app/events?deviceId=dev-1&sessionKey=claude:s1&after=%d", after), keyA, nil, &out)
	if len(out.Events) != 1 || out.Events[0]["text"] != "c" {
		t.Fatalf("after: %v", out.Events)
	}
	e.do("GET", "/app/events?deviceId=dev-1&sessionKey=claude:none", keyA, nil, &out)
	if out.Events == nil || len(out.Events) != 0 {
		t.Fatalf("empty session should be []: %v", out.Events)
	}
	e.do("GET", "/app/events?deviceId=dev-1&sessionKey=claude:s1", keyB, nil, &out)
	if len(out.Events) != 0 {
		t.Fatalf("account isolation: %v", out.Events)
	}
	var bad map[string]string
	if code := e.do("GET", "/app/events?deviceId=dev-1", keyA, nil, &bad); code != 400 {
		t.Fatalf("missing sessionKey: %d", code)
	}
}

func TestRingLimits(t *testing.T) {
	e := newEnv(t, nil)
	e.register(keyA, "dev-1")
	batch := make([]map[string]any, 0, 700)
	for i := 0; i < 700; i++ {
		batch = append(batch, msg("codex:big", fmt.Sprint(i)))
	}
	for i := 0; i < 3; i++ { // 2100 events
		postEvents(t, e, keyA, "dev-1", batch...)
	}
	var out struct {
		Events []map[string]any `json:"events"`
	}
	e.do("GET", "/app/events?deviceId=dev-1&sessionKey=codex:big", keyA, nil, &out)
	if len(out.Events) != sessionRingSize || out.Events[len(out.Events)-1]["text"] != "699" {
		t.Fatalf("session ring: %d", len(out.Events))
	}
	e.hub.mu.Lock()
	n := len(e.hub.accounts[AccountID(keyA)].events.after(0))
	e.hub.mu.Unlock()
	if n != accountRingSize {
		t.Fatalf("account ring: %d", n)
	}
}

func TestBodyLimit(t *testing.T) {
	e := newEnv(t, nil)
	big := strings.Repeat("x", maxDefaultBody+10)
	var out map[string]string
	if code := e.do("POST", "/bridge/register", keyA, map[string]any{"deviceId": "d", "name": big}, &out); code != 413 {
		t.Fatalf("register limit: %d", code)
	}
	e.register(keyA, "dev-1")
	// ~1 MB of events is fine (2 MB limit)
	ev := msg("s", strings.Repeat("y", 1<<20))
	if code := e.do("POST", "/bridge/events", keyA, map[string]any{"deviceId": "dev-1", "events": []any{ev}}, nil); code != 200 {
		t.Fatalf("1MB events: %d", code)
	}
	ev = msg("s", strings.Repeat("y", 3<<20))
	if code := e.do("POST", "/bridge/events", keyA, map[string]any{"deviceId": "dev-1", "events": []any{ev}}, &out); code != 413 {
		t.Fatalf("3MB events: %d", code)
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	fake := newFakeSub2API(t)
	cfg := Config{Sub2APIURL: fake.URL, DataDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	h1, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h1)
	e := &env{t: t, hub: h1, srv: srv, fake: fake}
	e.register(keyA, "dev-1")
	srv.Close()
	h1.Close()

	b, err := os.ReadFile(filepath.Join(dir, devicesFile))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(keyA)) {
		t.Fatal("key stored in plain text")
	}
	if fi, _ := os.Stat(filepath.Join(dir, devicesFile)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", fi.Mode().Perm())
	}

	h2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h2.Close()
	h2.mu.Lock()
	a := h2.accounts[AccountID(keyA)]
	h2.mu.Unlock()
	if a == nil || a.devices["dev-1"] == nil || a.devices["dev-1"].info.Name != "我的电脑" {
		t.Fatalf("devices not restored: %s", b)
	}
	if a.devices["dev-1"].conn != nil {
		t.Fatal("restored device must be offline")
	}
}

func TestShutdownEndsStreams(t *testing.T) {
	e := newEnv(t, nil)
	e.register(keyA, "dev-1")
	br := e.stream("/bridge/stream?deviceId=dev-1", keyA)
	app := e.stream("/app/stream", keyA)
	e.hub.Close()
	for _, c := range []*sseClient{br, app} {
		select {
		case <-c.closed:
		case <-time.After(3 * time.Second):
			t.Fatal("stream not closed on shutdown")
		}
	}
}
