package console

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"salcara/bridge/internal/config"
	"salcara/bridge/internal/protocol"
)

func newTestServer(t *testing.T) (*Server, http.Handler) {
	st, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Store: st, Version: "test", Port: 47831})
	return s, s.Handler()
}

func do(h http.Handler, method, target, host string, hdr map[string]string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = host
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func TestHostCheck(t *testing.T) {
	_, h := newTestServer(t)
	for _, host := range []string{"evil.com", "evil.com:47831", "127.0.0.1:1234", "192.168.1.2:47831", ""} {
		if w := do(h, "GET", "/", host, nil, ""); w.Code != http.StatusForbidden {
			t.Errorf("host %q: got %d", host, w.Code)
		}
	}
	for _, host := range []string{"127.0.0.1:47831", "localhost:47831"} {
		if w := do(h, "GET", "/", host, nil, ""); w.Code != 200 {
			t.Errorf("host %q: got %d", host, w.Code)
		}
	}
}

func TestCookieAuth(t *testing.T) {
	s, h := newTestServer(t)
	host := "127.0.0.1:47831"
	// no cookie
	if w := do(h, "GET", "/api/ping", host, nil, ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", w.Code)
	}
	// page load sets the cookie
	w := do(h, "GET", "/", host, nil, "")
	var ck *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == CookieName {
			ck = c
		}
	}
	if ck == nil || ck.Value != s.Token() || !ck.HttpOnly || ck.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie %+v", ck)
	}
	cookie := map[string]string{"Cookie": CookieName + "=" + ck.Value}
	if w := do(h, "GET", "/api/ping", host, cookie, ""); w.Code != 200 {
		t.Fatalf("with cookie: %d", w.Code)
	}
	// wrong cookie
	if w := do(h, "GET", "/api/ping", host, map[string]string{"Cookie": CookieName + "=nope"}, ""); w.Code != 401 {
		t.Fatalf("wrong cookie: %d", w.Code)
	}
	// cross-origin request with a valid cookie is still rejected
	hdr := map[string]string{"Cookie": cookie["Cookie"], "Origin": "https://evil.com", "Content-Type": "application/json"}
	if w := do(h, "POST", "/api/device", host, hdr, `{"name":"x"}`); w.Code != 403 {
		t.Fatalf("cross origin: %d", w.Code)
	}
	// same origin POST works
	hdr["Origin"] = "http://127.0.0.1:47831"
	if w := do(h, "POST", "/api/device", host, hdr, `{"name":"新名字"}`); w.Code != 200 {
		t.Fatalf("same origin: %d %s", w.Code, w.Body)
	}
	if s.d.Store.Get().DeviceName != "新名字" {
		t.Fatal("device name not saved")
	}
	// non-JSON POST (form CSRF shape) rejected
	hdr["Content-Type"] = "text/plain"
	if w := do(h, "POST", "/api/device", host, hdr, `{"name":"y"}`); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain: %d", w.Code)
	}
	// DNS rebinding: right cookie, wrong host
	if w := do(h, "GET", "/api/ping", "attacker.example:47831", cookie, ""); w.Code != 403 {
		t.Fatalf("rebinding: %d", w.Code)
	}
}

func TestInternalAgentsPath(t *testing.T) {
	_, h := newTestServer(t)
	// no cookie needed, but loopback only (httptest uses 192.0.2.1 as RemoteAddr)
	req := httptest.NewRequest("POST", "/internal/agents/permission", nil)
	req.Host = "127.0.0.1:47831"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-loopback: %d", w.Code)
	}
	req.RemoteAddr = "127.0.0.1:5555"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable { // manager not attached in this test
		t.Fatalf("loopback: %d", w.Code)
	}
}

func TestStaticAndAttribution(t *testing.T) {
	s, h := newTestServer(t)
	for _, p := range []string{"/app.js", "/app.css", "/logo.svg"} {
		if w := do(h, "GET", p, "localhost:47831", nil, ""); w.Code != 200 {
			t.Errorf("%s: %d", p, w.Code)
		}
	}
	s.Broadcast(protocol.Event{Type: "approval.request", ApprovalID: "a1"})
	if len(s.pending) != 1 {
		t.Fatal("pending not tracked")
	}
	s.markDesktop("a1")
	ev := s.Attribute(protocol.Event{Type: "approval.resolved", ApprovalID: "a1", By: "phone"})
	if ev.By != "desktop" {
		t.Fatalf("by=%s", ev.By)
	}
	if ev := s.Attribute(protocol.Event{Type: "approval.resolved", ApprovalID: "a2", By: "phone"}); ev.By != "phone" {
		t.Fatal("unrelated approval re-attributed")
	}
	s.Broadcast(ev)
	if len(s.pending) != 0 {
		t.Fatal("pending not cleared")
	}
}

func TestRevealOnlyKnownPlaces(t *testing.T) {
	s, h := newTestServer(t)
	hdr := map[string]string{"Cookie": CookieName + "=" + s.Token(), "Content-Type": "application/json"}
	for _, body := range []string{`{"which":"/etc"}`, `{"which":"../x"}`, `{"which":""}`, `{"path":"/"}`} {
		if w := do(h, "POST", "/api/reveal", "127.0.0.1:47831", hdr, body); w.Code != 400 {
			t.Errorf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
	// config dir unknown in this server → a clear error, not a crash
	if w := do(h, "POST", "/api/reveal", "127.0.0.1:47831", hdr, `{"which":"config"}`); w.Code != 400 {
		t.Errorf("empty config dir: %d", w.Code)
	}
}

func TestStateHasPlatformFields(t *testing.T) {
	s, h := newTestServer(t)
	w := do(h, "GET", "/api/state", "127.0.0.1:47831", map[string]string{"Cookie": CookieName + "=" + s.Token()}, "")
	for _, k := range []string{`"os":`, `"arch":`, `"home":`, `"appBundle":`, `"installedFrom":`} {
		if !strings.Contains(w.Body.String(), k) {
			t.Errorf("state missing %s: %s", k, w.Body.String())
		}
	}
}
