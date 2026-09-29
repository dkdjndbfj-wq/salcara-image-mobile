// Package e2e runs the whole remote-coding chain with real processes:
//
//	fake phone (this test, HTTP + SSE)
//	    → fake relay (httptest: sub2api GET /v1/usage + nginx-like proxy of /salcara-hub/ with X-Forwarded-*)
//	    → salcara-hub (built from ../../hub)
//	    ⇄ SalcaraBridge (built from ..) started like a macOS LaunchAgent: PATH=/usr/bin:/bin:/usr/sbin:/sbin,
//	      --background, a fresh HOME
//	    → fake `codex` / `claude` (internal/testfake) installed the npm way: ~/.npm-global/bin/{codex,claude}
//	      are `#!/usr/bin/env node` scripts and `node` lives in ~/.volta/bin — so every spawn also proves
//	      the bridge's PATH augmentation reaches the child.
//
// It also downloads install-mac.sh through the hub's download endpoint and runs it with stubbed macOS
// commands (uname/sw_vers/open/xattr…) to check templating, the .app zip and its executable bit.
//
// Run: go test ./e2e/ -v   (skipped with -short and on Windows)
package e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const (
	goodKey = "sk-e2e-account-key"
	timeout = 30 * time.Second
)

// ---------------------------------------------------------------------------------------------------
// build & process helpers

func goBuild(t *testing.T, dir, pkg, out string, flags ...string) {
	t.Helper()
	cmd := exec.Command("go", append(append([]string{"build", "-o", out}, flags...), pkg)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build %s in %s: %v\n%s", pkg, dir, err, b)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type proc struct {
	name string
	cmd  *exec.Cmd
	out  *lockedBuf
	done chan struct{}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func start(t *testing.T, name, bin string, env []string, args ...string) *proc {
	t.Helper()
	p := &proc{name: name, out: &lockedBuf{}, done: make(chan struct{})}
	p.cmd = exec.Command(bin, args...)
	p.cmd.Env = env
	p.cmd.Stdout, p.cmd.Stderr = p.out, p.out
	if err := p.cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", name, err)
	}
	go func() { _ = p.cmd.Wait(); close(p.done) }()
	t.Cleanup(func() {
		p.stop()
		if t.Failed() {
			t.Logf("----- %s output -----\n%s", name, tail(p.out.String(), 6000))
		}
	})
	return p
}

func (p *proc) stop() {
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(8 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func writeFile(t *testing.T, p string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, mode); err != nil {
		t.Fatal(err)
	}
}

func copyFile(t *testing.T, src, dst string, mode os.FileMode) {
	t.Helper()
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, dst, b, mode)
}

// ---------------------------------------------------------------------------------------------------
// fake relay: sub2api /v1/usage + an nginx-like proxy in front of the hub

func newRelay(t *testing.T, hubAddr *string) *httptest.Server {
	var proxy *httputil.ReverseProxy
	var once sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/usage":
			if r.Header.Get("Authorization") != "Bearer "+goodKey {
				w.WriteHeader(http.StatusUnauthorized)
				io.WriteString(w, `{"error":"invalid api key"}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"mode":"balance","balance":12.5,"usage":{"today":{"requests":3,"cost":0.1}}}`)
		case strings.HasPrefix(r.URL.Path, "/salcara-hub/"):
			once.Do(func() {
				target, _ := url.Parse("http://" + *hubAddr)
				proxy = &httputil.ReverseProxy{
					Rewrite: func(pr *httputil.ProxyRequest) {
						pr.SetURL(target)
						pr.SetXForwarded() // X-Forwarded-For / -Host / -Proto like the documented nginx config
					},
					FlushInterval: -1, // proxy_buffering off
				}
			})
			proxy.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ---------------------------------------------------------------------------------------------------
// the phone

type event struct {
	Seq        int64           `json:"seq"`
	DeviceID   string          `json:"deviceId"`
	SessionKey string          `json:"sessionKey"`
	Tool       string          `json:"tool"`
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	Role       string          `json:"role"`
	Text       string          `json:"text"`
	Final      bool            `json:"final"`
	Kind       string          `json:"kind"`
	Title      string          `json:"title"`
	Status     string          `json:"status"`
	Output     string          `json:"output"`
	ApprovalID string          `json:"approvalId"`
	Decision   string          `json:"decision"`
	By         string          `json:"by"`
	Error      string          `json:"error"`
	Usage      json.RawMessage `json:"usage"`
	Session    *struct {
		SessionKey string `json:"sessionKey"`
		Status     string `json:"status"`
	} `json:"session"`
}

type phone struct {
	t    *testing.T
	base string // relay/salcara-hub/v1
	key  string

	mu      sync.Mutex
	events  []event
	devices []map[string]any
}

func (p *phone) do(method, path string, body any, out any) int {
	p.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, p.base+path, rd)
	req.Header.Set("Authorization", "Bearer "+p.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		p.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			p.t.Fatalf("%s %s: %s", method, path, b)
		}
	}
	return resp.StatusCode
}

type cmdResult struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

func (p *phone) command(deviceID string, cmd map[string]any) cmdResult {
	p.t.Helper()
	var r cmdResult
	code := p.do("POST", "/app/commands", map[string]any{"deviceId": deviceID, "command": cmd}, &r)
	if code != 200 {
		p.t.Fatalf("command %v: HTTP %d %+v", cmd["type"], code, r)
	}
	return r
}

func (p *phone) mustCommand(deviceID string, cmd map[string]any, out any) {
	p.t.Helper()
	r := p.command(deviceID, cmd)
	if !r.OK {
		p.t.Fatalf("command %v failed: %s", cmd["type"], r.Error)
	}
	if out != nil {
		if err := json.Unmarshal(r.Result, out); err != nil {
			p.t.Fatalf("command %v result %s: %v", cmd["type"], r.Result, err)
		}
	}
}

// stream reads /app/stream into p.events until ctx ends.
func (p *phone) stream(ctx context.Context) {
	req, _ := http.NewRequestWithContext(ctx, "GET", p.base+"/app/stream", nil)
	req.Header.Set("Authorization", "Bearer "+p.key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		p.t.Errorf("app/stream: %d", resp.StatusCode)
		return
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	var name, data string
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			p.mu.Lock()
			switch name {
			case "event":
				var e event
				if json.Unmarshal([]byte(data), &e) == nil {
					p.events = append(p.events, e)
				}
			case "device":
				var d map[string]any
				if json.Unmarshal([]byte(data), &d) == nil {
					p.devices = append(p.devices, d)
				}
			}
			p.mu.Unlock()
			name, data = "", ""
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data += strings.TrimPrefix(line[5:], " ")
		}
	}
}

func (p *phone) snapshot() []event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]event(nil), p.events...)
}

// wait returns the first event after index `from` matching pred.
func (p *phone) wait(what string, from int, pred func(event) bool) (event, int) {
	p.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		evs := p.snapshot()
		for i := from; i < len(evs); i++ {
			if pred(evs[i]) {
				return evs[i], i
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	var b strings.Builder
	for i, e := range p.snapshot() {
		if i >= from {
			fmt.Fprintf(&b, "  %s %s %s id=%s status=%s text=%q title=%q appr=%s err=%s\n", e.Tool, e.SessionKey, e.Type, e.ID, e.Status, tail(e.Text, 60), e.Title, e.ApprovalID, e.Error)
		}
	}
	p.t.Fatalf("timeout waiting for %s; events since %d:\n%s", what, from, b.String())
	return event{}, 0
}

func (p *phone) mark() int { return len(p.snapshot()) }

func readLog(t *testing.T, dir, name string) []map[string]any {
	b, _ := os.ReadFile(filepath.Join(dir, name))
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

// ---------------------------------------------------------------------------------------------------

func TestEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses unix shebang scripts")
	}
	if testing.Short() {
		t.Skip("builds and runs the hub and the bridge")
	}
	bridgeDir, _ := filepath.Abs("..")
	hubDir := filepath.Join(bridgeDir, "..", "hub")
	if _, err := os.Stat(filepath.Join(hubDir, "go.mod")); err != nil {
		t.Skip("hub module not found next to the bridge")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not on PATH")
	}

	bin := t.TempDir()
	hubBin, bridgeBin, fakeBin := filepath.Join(bin, "salcara-hub"), filepath.Join(bin, "SalcaraBridge"), filepath.Join(bin, "fakeagent")
	goBuild(t, hubDir, ".", hubBin)
	goBuild(t, bridgeDir, ".", bridgeBin, "-ldflags", "-X main.version=9.9.9-e2e")
	goBuild(t, bridgeDir, "./internal/testfake/fakeagent", fakeBin)

	// ---- fake computer: tools installed the npm way, node elsewhere ----
	home := t.TempDir()
	for _, tool := range []string{"codex", "claude"} {
		writeFile(t, filepath.Join(home, ".npm-global", "bin", tool), []byte("#!/usr/bin/env node\n// npm shim stand-in\n"), 0o755)
	}
	copyFile(t, fakeBin, filepath.Join(home, ".volta", "bin", "node"), 0o755)
	work := filepath.Join(home, "code", "app")
	outside := filepath.Join(home, "private")
	os.MkdirAll(work, 0o755)
	os.MkdirAll(outside, 0o755)
	fakeLog := t.TempDir()

	// ---- hub behind the fake relay ----
	hubAddr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	relay := newRelay(t, &hubAddr)
	downloads := t.TempDir()
	copyFile(t, filepath.Join(bridgeDir, "install", "install-mac.sh"), filepath.Join(downloads, "install-mac.sh"), 0o644)
	// The .app zip, built by the real packaging tool around a Linux build so the installer can run it here.
	mb := exec.Command("go", "run", "./tools/macbundle", "-bin", bridgeBin, "-version", "9.9.9-e2e", "-out", filepath.Join(downloads, "SalcaraBridge-macos.zip"))
	mb.Dir = bridgeDir
	if b, err := mb.CombinedOutput(); err != nil {
		t.Fatalf("macbundle: %v\n%s", err, b)
	}
	hub := start(t, "hub", hubBin, []string{
		"PATH=" + os.Getenv("PATH"),
		"SALCARA_HUB_ADDR=" + hubAddr,
		"SUB2API_URL=" + relay.URL,
		"SALCARA_HUB_DATA=" + t.TempDir(),
		"SALCARA_HUB_DOWNLOADS=" + downloads,
		"TRUST_PROXY=true",
		"SALCARA_HUB_LOG_FORMAT=text",
	})
	waitFor(t, "hub /ping through the relay", func() bool {
		resp, err := http.Get(relay.URL + "/salcara-hub/v1/ping")
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == 200
	})
	_ = hub

	// ---- the bridge, started the way a macOS LaunchAgent starts it ----
	port := freePort(t)
	console := fmt.Sprintf("http://127.0.0.1:%d", port)
	bridgeEnv := []string{
		"HOME=" + home,
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
		"SALCARA_BRIDGE_PORT=" + fmt.Sprint(port),
		"SALCARA_BRIDGE_CONFIG_DIR=" + filepath.Join(home, "cfg"),
		"SALCARA_NO_SHELL_PATH=1",
		"SALCARA_FAKE_LOG=" + fakeLog,
		"ANTHROPIC_API_KEY=user-own-key-must-not-leak",
		"TMPDIR=" + t.TempDir(),
	}
	bridge := start(t, "bridge", bridgeBin, bridgeEnv, "--background", "--relay", relay.URL+"/v1/")
	waitFor(t, "bridge console /healthz", func() bool {
		resp, err := http.Get(console + "/healthz")
		if err != nil {
			return false
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return strings.Contains(string(b), "salcara-bridge")
	})

	// ---- local console: login + project, like the user in the browser ----
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	consoleCall := func(method, path string, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, console+path, rd)
		req.Header.Set("Origin", console)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := browser.Do(req)
		if err != nil {
			t.Fatalf("console %s: %v", path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if out != nil {
			_ = json.Unmarshal(b, out)
		}
		if resp.StatusCode != 200 {
			t.Logf("console %s %s → %d %s", method, path, resp.StatusCode, b)
		}
		return resp.StatusCode
	}
	if code := consoleCall("GET", "/", nil, nil); code != 200 {
		t.Fatalf("console page %d", code)
	}
	var state struct {
		OS     string `json:"os"`
		Home   string `json:"home"`
		Config struct {
			RelayRoot string `json:"relayRoot"`
			LoggedIn  bool   `json:"loggedIn"`
		} `json:"config"`
		Tools []struct {
			ID        string `json:"id"`
			Available bool   `json:"available"`
			Version   string `json:"version"`
		} `json:"tools"`
	}
	consoleCall("GET", "/api/state", nil, &state)
	if state.Config.RelayRoot != relay.URL || state.Config.LoggedIn || state.Home != home {
		t.Fatalf("--relay prefill / state: %+v", state)
	}
	if code := consoleCall("POST", "/api/login", map[string]any{"relayRoot": relay.URL, "accountKey": "sk-wrong"}, nil); code == 200 {
		t.Fatal("login with a wrong key succeeded")
	}
	if code := consoleCall("POST", "/api/login", map[string]any{"relayRoot": relay.URL, "accountKey": goodKey}, nil); code != 200 {
		t.Fatal("login failed")
	}
	if code := consoleCall("POST", "/api/projects", map[string]any{"path": work}, nil); code != 200 {
		t.Fatal("add project failed")
	}

	// ---- the phone ----
	ph := &phone{t: t, base: relay.URL + "/salcara-hub/v1", key: goodKey}
	if code := (&phone{t: t, base: ph.base, key: "sk-nope"}).do("GET", "/app/devices", nil, nil); code != 401 {
		t.Fatalf("wrong key → %d, want 401", code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ph.stream(ctx)

	type device struct {
		DeviceID string `json:"deviceId"`
		OS       string `json:"os"`
		Online   bool   `json:"online"`
		Tools    []struct {
			ID        string `json:"id"`
			Available bool   `json:"available"`
			Version   string `json:"version"`
		} `json:"tools"`
		Projects []struct {
			Path string `json:"path"`
		} `json:"projects"`
	}
	var dev device
	var lastDevices string
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("last /app/devices: %s", lastDevices)
		}
	})
	waitFor(t, "device online with both tools and the project", func() bool {
		var r struct {
			Devices []device `json:"devices"`
		}
		ph.do("GET", "/app/devices", nil, &r)
		b, _ := json.Marshal(r)
		lastDevices = string(b)
		for _, d := range r.Devices {
			ok := d.Online && len(d.Projects) == 1 && d.Projects[0].Path == work
			n := 0
			for _, tl := range d.Tools {
				if tl.Available && tl.Version == "9.9.9" {
					n++
				}
			}
			if ok && n == 2 {
				dev = d
				return true
			}
		}
		return false
	})
	t.Logf("device %s online (%s), codex + claude found via ~/.npm-global/bin with node from ~/.volta/bin", dev.DeviceID, dev.OS)
	id := dev.DeviceID

	// ---- simple commands ----
	var projects struct {
		Projects []struct{ Path string } `json:"projects"`
	}
	ph.mustCommand(id, map[string]any{"type": "projects.list"}, &projects)
	if len(projects.Projects) != 1 {
		t.Fatalf("projects.list %+v", projects)
	}
	var models struct {
		Models []string `json:"models"`
	}
	ph.mustCommand(id, map[string]any{"type": "models.list", "tool": "codex"}, &models)
	if strings.Join(models.Models, ",") != "gpt-5.5" {
		t.Fatalf("codex models %v", models.Models)
	}
	if r := ph.command(id, map[string]any{"type": "session.start", "tool": "claude", "cwd": outside, "prompt": "x"}); r.OK || !strings.Contains(r.Error, "没有被允许") {
		t.Fatalf("cwd outside projects: %+v", r)
	}
	if r := ph.command(id, map[string]any{"type": "approval.respond", "approvalId": "ap_nope", "decision": "allow"}); r.OK {
		t.Fatal("unknown approval accepted")
	}

	// ================= Claude Code =================
	t.Run("claude", func(t *testing.T) {
		from := ph.mark()
		var st struct {
			SessionKey string `json:"sessionKey"`
		}
		ph.mustCommand(id, map[string]any{"type": "session.start", "tool": "claude", "cwd": work, "prompt": "hello e2e", "approval": "ask"}, &st)
		sk := st.SessionKey
		if !strings.HasPrefix(sk, "claude:") {
			t.Fatalf("sessionKey %q", sk)
		}
		in := func(e event) bool { return e.SessionKey == sk }
		ph.wait("turn started", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "started" })
		ph.wait("user message", from, func(e event) bool { return in(e) && e.Type == "message" && e.Role == "user" && e.Text == "hello e2e" })
		ph.wait("assistant text", from, func(e event) bool {
			return in(e) && e.Type == "message" && e.Role == "assistant" && strings.HasPrefix(e.Text, "Hi")
		})
		ap, _ := ph.wait("Bash approval", from, func(e event) bool { return in(e) && e.Type == "approval.request" && e.Kind == "command" })
		if !strings.Contains(ap.Title, "ls") {
			t.Errorf("approval title %q", ap.Title)
		}
		ph.wait("waiting_approval status", from, func(e event) bool {
			return in(e) && e.Type == "session.updated" && e.Session != nil && e.Session.Status == "waiting_approval"
		})
		ph.mustCommand(id, map[string]any{"type": "approval.respond", "approvalId": ap.ApprovalID, "decision": "allow"}, nil)
		ph.wait("approval resolved by phone", from, func(e event) bool {
			return in(e) && e.Type == "approval.resolved" && e.ApprovalID == ap.ApprovalID && e.Decision == "allow" && e.By == "phone"
		})
		ph.wait("tool done with output", from, func(e event) bool {
			return in(e) && e.Type == "tool" && e.Status == "done" && strings.Contains(e.Output, "file1")
		})
		ph.wait("final assistant message", from, func(e event) bool {
			return in(e) && e.Type == "message" && e.Role == "assistant" && e.Final && e.Text == "Hi there"
		})
		done, _ := ph.wait("turn completed", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "completed" })
		if !strings.Contains(string(done.Usage), `"costUsd":0.0123`) || !strings.Contains(string(done.Usage), `"outputTokens":20`) {
			t.Errorf("usage %s", done.Usage)
		}

		// sessions.list has it, idle
		waitFor(t, "sessions.list shows the session idle", func() bool {
			var r struct {
				Sessions []struct{ SessionKey, Status, Tool, Cwd string } `json:"sessions"`
			}
			ph.mustCommand(id, map[string]any{"type": "sessions.list", "tool": "claude"}, &r)
			for _, s := range r.Sessions {
				if s.SessionKey == sk && s.Status == "idle" && s.Cwd == work {
					return true
				}
			}
			return false
		})
		var opened struct {
			Session struct{ SessionKey string } `json:"session"`
		}
		ph.mustCommand(id, map[string]any{"type": "session.open", "sessionKey": sk}, &opened)
		if opened.Session.SessionKey != sk {
			t.Errorf("session.open %+v", opened)
		}

		// second turn: deny Bash, allow Edit for the whole session
		from = ph.mark()
		ph.mustCommand(id, map[string]any{"type": "session.send", "sessionKey": sk, "text": "please edit a.txt"}, nil)
		ap1, _ := ph.wait("Bash approval (turn 2)", from, func(e event) bool { return in(e) && e.Type == "approval.request" && e.Kind == "command" })
		ph.mustCommand(id, map[string]any{"type": "approval.respond", "approvalId": ap1.ApprovalID, "decision": "deny", "message": "不要运行"}, nil)
		ap2, _ := ph.wait("Edit approval", from, func(e event) bool { return in(e) && e.Type == "approval.request" && e.Kind == "file_change" })
		ph.mustCommand(id, map[string]any{"type": "approval.respond", "approvalId": ap2.ApprovalID, "decision": "allow_session"}, nil)
		ph.wait("turn 2 completed", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "completed" })
		ph.wait("denied tool failed", from, func(e event) bool { return in(e) && e.Type == "tool" && e.Status == "failed" })

		// the hub cached the session's events for /app/events
		var cached struct {
			Events []event `json:"events"`
		}
		ph.do("GET", "/app/events?deviceId="+url.QueryEscape(id)+"&sessionKey="+url.QueryEscape(sk), nil, &cached)
		if len(cached.Events) < 10 {
			t.Errorf("app/events returned %d events", len(cached.Events))
		}

		// third turn hangs → interrupt
		from = ph.mark()
		ph.mustCommand(id, map[string]any{"type": "session.send", "sessionKey": sk, "text": "sleep for a while"}, nil)
		ph.wait("turn 3 started", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "started" })
		ph.mustCommand(id, map[string]any{"type": "session.interrupt", "sessionKey": sk}, nil)
		ph.wait("turn interrupted", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "interrupted" })

		decisions := readLog(t, fakeLog, "claude-decisions.jsonl")
		got := []string{}
		for _, d := range decisions {
			got = append(got, fmt.Sprint(d["tool"], ":", d["behavior"]))
		}
		if strings.Join(got, ",") != "Bash:allow,Bash:deny,Edit:allow" {
			t.Errorf("claude decisions %v", got)
		}
		for _, a := range readLog(t, fakeLog, "claude-args.jsonl") {
			if a["base"] != relay.URL || a["token"] != goodKey || a["apikey"] != "" || a["cwd"] != work {
				t.Errorf("claude child env/args: %v", a)
			}
		}
	})

	// ================= Codex =================
	t.Run("codex", func(t *testing.T) {
		from := ph.mark()
		var st struct {
			SessionKey string `json:"sessionKey"`
		}
		ph.mustCommand(id, map[string]any{"type": "session.start", "tool": "codex", "cwd": work, "prompt": "hi codex", "approval": "ask"}, &st)
		sk := st.SessionKey
		if sk != "codex:thr_new" {
			t.Fatalf("sessionKey %q", sk)
		}
		in := func(e event) bool { return e.SessionKey == sk }
		ph.wait("streamed agent message", from, func(e event) bool {
			return in(e) && e.Type == "message" && e.Role == "assistant" && e.Final && e.Text == "Hello"
		})
		ap, _ := ph.wait("command approval", from, func(e event) bool { return in(e) && e.Type == "approval.request" && e.Kind == "command" })
		if !strings.Contains(ap.Title, "npm test") {
			t.Errorf("title %q", ap.Title)
		}
		ph.mustCommand(id, map[string]any{"type": "approval.respond", "approvalId": ap.ApprovalID, "decision": "allow"}, nil)
		ph.wait("command done", from, func(e event) bool {
			return in(e) && e.Type == "tool" && e.Kind == "command" && e.Status == "done" && strings.Contains(e.Output, "ok 1")
		})
		ap2, _ := ph.wait("file change approval", from, func(e event) bool { return in(e) && e.Type == "approval.request" && e.Kind == "file_change" })
		ph.mustCommand(id, map[string]any{"type": "approval.respond", "approvalId": ap2.ApprovalID, "decision": "deny"}, nil)
		ph.wait("approval resolved deny", from, func(e event) bool {
			return in(e) && e.Type == "approval.resolved" && e.ApprovalID == ap2.ApprovalID && e.Decision == "deny"
		})
		ph.wait("turn completed", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "completed" })

		var r struct {
			Sessions []struct{ SessionKey, Client string } `json:"sessions"`
		}
		ph.mustCommand(id, map[string]any{"type": "sessions.list", "tool": "codex"}, &r)
		keys := map[string]bool{}
		for _, s := range r.Sessions {
			keys[s.SessionKey] = true
		}
		if !keys[sk] || !keys["codex:thr_cli"] || !keys["codex:thr_ide"] {
			t.Errorf("codex sessions %+v", r.Sessions)
		}

		from = ph.mark()
		ph.mustCommand(id, map[string]any{"type": "session.send", "sessionKey": sk, "text": "slow job"}, nil)
		ph.wait("slow turn started", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "started" })
		ph.mustCommand(id, map[string]any{"type": "session.interrupt", "sessionKey": sk}, nil)
		ph.wait("turn interrupted", from, func(e event) bool { return in(e) && e.Type == "turn" && e.Status == "interrupted" })

		got := []string{}
		for _, d := range readLog(t, fakeLog, "codex-decisions.jsonl") {
			got = append(got, fmt.Sprint(d["kind"], ":", d["decision"]))
		}
		if strings.Join(got, ",") != "command:accept,file:decline" {
			t.Errorf("codex decisions %v", got)
		}
		// The history watcher may start app-server before login (listing local threads needs no key);
		// the bridge restarts it when the relay settings change, so the last one must carry the key.
		spawns := readLog(t, fakeLog, "codex-args.jsonl")
		if len(spawns) == 0 {
			t.Fatal("codex never started")
		}
		last := spawns[len(spawns)-1]
		if last["key"] != goodKey || !strings.Contains(fmt.Sprint(last["args"]), "model_providers.salcara.base_url=\""+relay.URL+"/v1\"") {
			t.Errorf("codex child: %v", last)
		}
	})

	// ================= install-mac.sh through the hub =================
	t.Run("install-mac.sh", func(t *testing.T) {
		resp, err := http.Get(relay.URL + "/salcara-hub/download/install-mac.sh")
		if err != nil {
			t.Fatal(err)
		}
		script, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		wantHub := relay.URL + "/salcara-hub"
		if resp.StatusCode != 200 || !strings.Contains(string(script), `HUB="${SALCARA_HUB:-`+wantHub+`}"`) {
			t.Fatalf("templated script: %d\n%s", resp.StatusCode, tail(string(script), 400))
		}
		if resp, err := http.Get(relay.URL + "/salcara-hub/download/..%2Fdevices.json"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				t.Fatal("traversal through the relay")
			}
		}
		if _, err := exec.LookPath("unzip"); err != nil {
			t.Skip("unzip not installed")
		}
		// Stub the macOS commands and run the script exactly like `curl … | bash`.
		stubs := t.TempDir()
		logf := filepath.Join(stubs, "calls.log")
		stub := func(name, body string) {
			writeFile(t, filepath.Join(stubs, name), []byte("#!/bin/sh\necho \""+name+" $*\" >> '"+logf+"'\n"+body+"\n"), 0o755)
		}
		stub("uname", `case "$1" in -s) echo Darwin;; -m) echo arm64;; *) echo Darwin;; esac`)
		stub("sw_vers", "echo 14.5")
		stub("sysctl", "echo 0")
		stub("xattr", "exit 0")
		stub("open", "exit 0")
		stub("pgrep", "exit 1")
		stub("pkill", "exit 1")
		instHome := t.TempDir()
		cmd := exec.Command("bash")
		cmd.Stdin = bytes.NewReader(script)
		cmd.Env = []string{"HOME=" + instHome, "PATH=" + stubs + ":/usr/bin:/bin", "TMPDIR=" + t.TempDir()}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("install-mac.sh: %v\n%s", err, out)
		}
		app := filepath.Join(instHome, "Applications", "Salcara Bridge.app")
		exe := filepath.Join(app, "Contents", "MacOS", "SalcaraBridge")
		st, err := os.Stat(exe)
		if err != nil || st.Mode().Perm()&0o111 == 0 {
			t.Fatalf("installed executable: %v %v\n%s", err, st, out)
		}
		for _, f := range []string{"Contents/Info.plist", "Contents/Resources/AppIcon.icns"} {
			if _, err := os.Stat(filepath.Join(app, f)); err != nil {
				t.Errorf("missing %s", f)
			}
		}
		calls, _ := os.ReadFile(logf)
		if !strings.Contains(string(calls), "xattr -dr com.apple.quarantine "+app) ||
			!strings.Contains(string(calls), "open "+app+" --args --relay "+relay.URL) {
			t.Errorf("stub calls:\n%s", calls)
		}
		if !strings.Contains(string(out), "Salcara Bridge 9.9.9-e2e") {
			t.Errorf("installer output:\n%s", out)
		}
	})

	// ================= shutdown → offline =================
	bridge.stop()
	waitFor(t, "device offline after the bridge quits", func() bool {
		var r struct {
			Devices []device `json:"devices"`
		}
		ph.do("GET", "/app/devices", nil, &r)
		return len(r.Devices) == 1 && !r.Devices[0].Online
	})
	ph.mu.Lock()
	sawOffline := false
	for _, d := range ph.devices {
		if d["deviceId"] == id && d["online"] == false {
			sawOffline = true
		}
	}
	ph.mu.Unlock()
	if !sawOffline {
		t.Error("app stream did not get the offline device event")
	}
	if strings.Contains(bridge.out.String(), goodKey) {
		t.Error("the bridge logged the API key")
	}
}
