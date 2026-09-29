package hubclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"salcara/bridge/internal/agents"
	"salcara/bridge/internal/config"
	"salcara/bridge/internal/protocol"
)

// ---- fakes ----

type fakeAgent struct {
	id       string
	mu       sync.Mutex
	started  []string
	sessions []protocol.SessionInfo
}

func (a *fakeAgent) ID() string   { return a.id }
func (a *fakeAgent) Name() string { return strings.ToUpper(a.id) }
func (a *fakeAgent) Detect(context.Context) protocol.Tool {
	return protocol.Tool{ID: a.id, Name: a.Name(), Available: true, Version: "1.0"}
}
func (a *fakeAgent) Sessions(context.Context) ([]protocol.SessionInfo, error) { return a.sessions, nil }
func (a *fakeAgent) Open(_ context.Context, id string) (protocol.SessionInfo, []protocol.Event, error) {
	return protocol.SessionInfo{SessionKey: a.id + ":" + id}, []protocol.Event{{Type: "message", Text: "hi"}}, nil
}
func (a *fakeAgent) Start(_ context.Context, cwd, prompt, model, approval string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.started = append(a.started, cwd+"|"+prompt+"|"+approval)
	return "s1", nil
}
func (a *fakeAgent) Send(context.Context, string, string) error { return nil }
func (a *fakeAgent) Interrupt(context.Context, string) error    { return nil }
func (a *fakeAgent) Respond(id, _, _ string) bool               { return id == a.id+"-ap" }
func (a *fakeAgent) Models(context.Context) []string            { return []string{"m1"} }
func (a *fakeAgent) Close()                                     {}

type fakeManager struct{ list []agents.Agent }

func (m *fakeManager) Agents() []agents.Agent { return m.list }
func (m *fakeManager) Get(t string) agents.Agent {
	for _, a := range m.list {
		if a.ID() == t {
			return a
		}
	}
	return nil
}
func (m *fakeManager) Watch(context.Context)      {}
func (m *fakeManager) LocalHandler() http.Handler { return http.NotFoundHandler() }
func (m *fakeManager) Close()                     {}

type fakeHub struct {
	t          *testing.T
	key        string
	mu         sync.Mutex
	regs       []protocol.Device
	replies    chan protocol.Reply
	batches    [][]protocol.Event
	commands   chan protocol.CommandEnvelope
	pairStarts chan string
	streams    int
	silent     bool          // don't send pings
	delay      time.Duration // before answering /bridge/stream
}

func newFakeHub(t *testing.T) (*fakeHub, *httptest.Server) {
	h := &fakeHub{t: t, key: "sk-good", replies: make(chan protocol.Reply, 10), commands: make(chan protocol.CommandEnvelope, 10), pairStarts: make(chan string, 2)}
	mux := http.NewServeMux()
	auth := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+h.key {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":"Key 无效"}`))
			return false
		}
		return true
	}
	mux.HandleFunc("/salcara-hub/v1/bridge/register", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		var d protocol.Device
		json.NewDecoder(r.Body).Decode(&d)
		h.mu.Lock()
		h.regs = append(h.regs, d)
		h.mu.Unlock()
		w.Write([]byte(`{}`))
	})
	mux.HandleFunc("/salcara-hub/v1/bridge/pair/start", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		h.pairStarts <- r.Header.Get("X-Salcara-Device-Secret")
		_, _ = w.Write([]byte(`{"code":"ABCD2345","expires_at":1234567890}`))
	})
	mux.HandleFunc("/salcara-hub/v1/bridge/stream", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		h.mu.Lock()
		h.streams++
		silent, delay := h.silent, h.delay
		h.mu.Unlock()
		time.Sleep(delay)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		fl.Flush()
		ping := time.NewTicker(20 * time.Millisecond)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case cmd := <-h.commands:
				b, _ := json.Marshal(cmd)
				fmt.Fprintf(w, "event: command\ndata: %s\n\n", b)
				fl.Flush()
			case <-ping.C:
				if !silent {
					fmt.Fprint(w, ": ping\n\n")
					fl.Flush()
				}
			}
		}
	})
	mux.HandleFunc("/salcara-hub/v1/bridge/reply", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		var rep protocol.Reply
		json.NewDecoder(r.Body).Decode(&rep)
		h.replies <- rep
	})
	mux.HandleFunc("/salcara-hub/v1/bridge/events", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		var body struct {
			DeviceID string           `json:"deviceId"`
			Events   []protocol.Event `json:"events"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		h.mu.Lock()
		h.batches = append(h.batches, body.Events)
		h.mu.Unlock()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return h, srv
}

func newTestClient(t *testing.T, hubURL, key string, projects []protocol.Project) (*Client, *config.Store) {
	st, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	st.Update(func(c *config.Config) error {
		c.RelayRoot = "https://relay.invalid"
		c.HubURL = hubURL + "/salcara-hub"
		c.AccountKey = key
		c.Projects = projects
		return nil
	})
	c := New(Options{Store: st, Version: "test", HeartbeatTimeout: 200 * time.Millisecond,
		BackoffMin: 20 * time.Millisecond, BackoffMax: 100 * time.Millisecond, FlushInterval: 30 * time.Millisecond,
		FlushBatch: 5, ToolCheckEvery: 50 * time.Millisecond})
	c.SetManager(&fakeManager{list: []agents.Agent{&fakeAgent{id: "codex"}, &fakeAgent{id: "claude"}}})
	return c, st
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

// ---- tests ----

func TestRegisterCommandReplyAndEvents(t *testing.T) {
	hub, srv := newFakeHub(t)
	proj := t.TempDir()
	c, st := newTestClient(t, srv.URL, "sk-good", []protocol.Project{{Path: proj, Name: "p"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	waitFor(t, "connected", func() bool { return c.Status().State == StateConnected })
	hub.mu.Lock()
	reg := hub.regs[0]
	hub.mu.Unlock()
	if reg.DeviceID != st.Get().DeviceID || len(reg.Tools) != 2 || len(reg.Projects) != 1 || reg.Version != "test" {
		t.Fatalf("register body %+v", reg)
	}
	code, expiresAt, err := c.PairStart(ctx)
	if err != nil || code != "ABCD2345" || expiresAt != 1234567890 {
		t.Fatalf("pair start code=%q expiry=%d err=%v", code, expiresAt, err)
	}
	if got := <-hub.pairStarts; got == "" || got != st.Get().DeviceSecret {
		t.Fatalf("pair request omitted the desktop secret")
	}

	// command → reply
	sub := filepath.Join(proj, "sub")
	os.Mkdir(sub, 0o755)
	hub.commands <- protocol.CommandEnvelope{CommandID: "c1", Command: map[string]any{"type": "session.start", "tool": "codex", "cwd": sub, "prompt": "fix"}}
	rep := <-hub.replies
	if !rep.OK || rep.CommandID != "c1" || rep.Result.(map[string]any)["sessionKey"] != "codex:s1" {
		t.Fatalf("reply %+v", rep)
	}
	// disallowed cwd → error reply
	hub.commands <- protocol.CommandEnvelope{CommandID: "c2", Command: map[string]any{"type": "session.start", "tool": "codex", "cwd": t.TempDir(), "prompt": "x"}}
	rep = <-hub.replies
	if rep.OK || rep.Error != ErrNotAllowed.Error() {
		t.Fatalf("reply %+v", rep)
	}
	hub.commands <- protocol.CommandEnvelope{CommandID: "c3", Command: map[string]any{"type": "approval.respond", "approvalId": "claude-ap", "decision": "allow"}}
	if rep = <-hub.replies; !rep.OK {
		t.Fatalf("approval reply %+v", rep)
	}

	// events: 12 events → batched
	for i := 0; i < 12; i++ {
		c.Push(protocol.Event{SessionKey: "codex:s1", Tool: "codex", Type: "message", ID: "m", Text: fmt.Sprint(i)})
	}
	waitFor(t, "events uploaded", func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		n := 0
		for _, b := range hub.batches {
			n += len(b)
		}
		return n == 12
	})
	hub.mu.Lock()
	nb := len(hub.batches)
	first := hub.batches[0][0]
	hub.mu.Unlock()
	if nb > 4 || first.Text != "0" || first.TS == 0 {
		t.Fatalf("batches=%d first=%+v", nb, first)
	}

	// projects change → re-register picks it up
	st.Update(func(cfg *config.Config) error {
		cfg.Projects = append(cfg.Projects, protocol.Project{Path: t.TempDir(), Name: "q"})
		return nil
	})
	c.Reregister()
	waitFor(t, "re-register", func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return len(hub.regs[len(hub.regs)-1].Projects) == 2
	})
}

func TestInvalidKeyAndHeartbeatReconnect(t *testing.T) {
	hub, srv := newFakeHub(t)
	c, st := newTestClient(t, srv.URL, "sk-bad", nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	waitFor(t, "invalid key", func() bool { return c.Status().State == StateInvalidKey })

	// fix key → Kick → connected
	st.Update(func(cfg *config.Config) error { cfg.AccountKey = "sk-good"; return nil })
	c.Kick()
	waitFor(t, "connected", func() bool { return c.Status().State == StateConnected })

	// hub goes silent → heartbeat timeout → reconnect (new stream)
	hub.mu.Lock()
	hub.silent = true
	before := hub.streams
	hub.mu.Unlock()
	c.Kick() // reconnect so the new stream is silent
	waitFor(t, "reconnect after heartbeat timeout", func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return hub.streams >= before+2
	})
}

func TestQueueCapDropsOldest(t *testing.T) {
	st, _ := config.Open(filepath.Join(t.TempDir(), "c.json"))
	c := New(Options{Store: st, QueueCap: 10, FlushBatch: 1000})
	for i := 0; i < 25; i++ {
		c.Push(protocol.Event{Type: "notice", Text: fmt.Sprint(i)})
	}
	if len(c.queue) != 10 || c.queue[0].Text != "15" || c.queue[9].Text != "24" {
		t.Fatalf("queue %d first=%s", len(c.queue), c.queue[0].Text)
	}
}

func TestNotLoggedIn(t *testing.T) {
	st, _ := config.Open(filepath.Join(t.TempDir(), "c.json"))
	c := New(Options{Store: st})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	time.Sleep(50 * time.Millisecond)
	if c.Status().State != StateNotLoggedIn {
		t.Fatal(c.Status().State)
	}
}

func TestIsWithin(t *testing.T) {
	cases := []struct {
		root, target string
		win, want    bool
	}{
		{"/home/u/code", "/home/u/code", false, true},
		{"/home/u/code", "/home/u/code/app/src", false, true},
		{"/home/u/code", "/home/u/code2", false, false},
		{"/home/u/code", "/home/u/code/../secret", false, false},
		{"/home/u/code", "/home/u/code/a/../../code/b", false, true},
		{"/home/u/Code", "/home/u/code/x", false, false},
		{"/", "/etc", false, true},
		{`C:\Code\App`, `c:\code\app\src`, true, true},
		{`C:\Code\App`, `C:/Code/App/../Other`, true, false},
		{`C:\Code\App`, `C:\Code\AppData`, true, false},
		{`C:\Code\App\`, `C:\Code\App`, true, true},
		{`D:\`, `d:\x\y`, true, true},
		{`C:\Code`, `D:\Code`, true, false},
		{`C:\Code`, `\\?\C:\Code\x`, true, true},
		{"", "/x", false, false},
	}
	for _, c := range cases {
		if got := IsWithin(c.root, c.target, c.win); got != c.want {
			t.Errorf("IsWithin(%q,%q,%v)=%v", c.root, c.target, c.win, got)
		}
	}
}

func TestCheckCwd(t *testing.T) {
	base := t.TempDir()
	proj := filepath.Join(base, "proj")
	outside := filepath.Join(base, "outside")
	os.MkdirAll(filepath.Join(proj, "src"), 0o755)
	os.MkdirAll(outside, 0o755)
	projects := []protocol.Project{{Path: proj, Name: "proj"}}

	if _, err := CheckCwd(filepath.Join(proj, "src"), projects); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckCwd(proj, projects); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckCwd(filepath.Join(proj, "..", "outside"), projects); err != ErrNotAllowed {
		t.Fatalf("traversal: %v", err)
	}
	if _, err := CheckCwd("relative/path", projects); err != ErrNotAllowed {
		t.Fatalf("relative: %v", err)
	}
	if _, err := CheckCwd(filepath.Join(proj, "missing"), projects); err == nil {
		t.Fatal("missing dir accepted")
	}
	if _, err := CheckCwd(proj, nil); err != ErrNotAllowed {
		t.Fatal("no projects must reject")
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(proj, "escape")
		if err := os.Symlink(outside, link); err == nil {
			if _, err := CheckCwd(link, projects); err != ErrNotAllowed {
				t.Fatalf("symlink escape: %v", err)
			}
		}
		// project given through a symlink still works
		plink := filepath.Join(base, "plink")
		os.Symlink(proj, plink)
		if _, err := CheckCwd(filepath.Join(proj, "src"), []protocol.Project{{Path: plink}}); err != nil {
			t.Fatalf("symlinked project: %v", err)
		}
	}
}

func TestDispatchSessionsList(t *testing.T) {
	a := &fakeAgent{id: "codex", sessions: []protocol.SessionInfo{{SessionKey: "codex:1", UpdatedAt: 1}, {SessionKey: "codex:2", UpdatedAt: 5}}}
	b := &fakeAgent{id: "claude", sessions: []protocol.SessionInfo{{SessionKey: "claude:3", UpdatedAt: 3}}}
	st, _ := config.Open(filepath.Join(t.TempDir(), "c.json"))
	c := New(Options{Store: st})
	c.SetManager(&fakeManager{list: []agents.Agent{a, b}})
	res, err := c.Dispatch(context.Background(), map[string]any{"type": "sessions.list"})
	if err != nil {
		t.Fatal(err)
	}
	ss := res.(map[string]any)["sessions"].([]protocol.SessionInfo)
	if len(ss) != 3 || ss[0].SessionKey != "codex:2" || ss[1].SessionKey != "claude:3" {
		t.Fatalf("%+v", ss)
	}
	res, _ = c.Dispatch(context.Background(), map[string]any{"type": "sessions.list", "tool": "claude"})
	if len(res.(map[string]any)["sessions"].([]protocol.SessionInfo)) != 1 {
		t.Fatal("filter")
	}
	if _, err := c.Dispatch(context.Background(), map[string]any{"type": "nope"}); err == nil {
		t.Fatal("unknown command accepted")
	}
	if _, err := c.Dispatch(context.Background(), map[string]any{"type": "approval.respond", "approvalId": "x", "decision": "allow"}); err == nil {
		t.Fatal("unknown approval accepted")
	}
}

// A project added while the client is (re)connecting — right after login, which Kick()s — must reach the
// hub as soon as the stream is up, not only at the next periodic tool check.
func TestProjectAddedWhileConnectingIsRegistered(t *testing.T) {
	h, srv := newFakeHub(t)
	h.delay = 300 * time.Millisecond
	c, st := newTestClient(t, srv.URL, "sk-good", nil)
	c.o.ToolCheckEvery = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	waitFor(t, "first register", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.regs) == 1 })
	if s := c.Status().State; s != StateConnecting {
		t.Fatalf("state %s, want connecting", s)
	}
	dir := t.TempDir()
	st.Update(func(cc *config.Config) error { cc.Projects = []protocol.Project{{Path: dir, Name: "p"}}; return nil })
	c.Reregister() // what the console does; skipped while connecting
	waitFor(t, "register with the project", func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		last := h.regs[len(h.regs)-1]
		return len(last.Projects) == 1 && last.Projects[0].Path == dir
	})
}
