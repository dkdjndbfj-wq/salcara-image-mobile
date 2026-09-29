package agents

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"salcara/bridge/internal/protocol"
)

// codexAgent drives one long-lived `codex app-server` process for the whole bridge.
type codexAgent struct {
	exeOverride string
	stateFile   string // remembers which threads the bridge started (for SessionInfo.Client)
	sink        func(protocol.Event)
	settings    func() Settings
	thr         *throttle
	aps         *approvals

	startMu   sync.Mutex // serializes process start
	mu        sync.Mutex
	conn      *rpcConn
	connSig   string
	startedAt time.Time
	nextStart time.Time
	backoff   time.Duration
	threads   map[string]*codexThread
	owned     map[string]bool
	closed    bool
	closeCh   chan struct{}
	wg        sync.WaitGroup
}

type codexThread struct {
	id       string
	info     protocol.SessionInfo
	path     string
	loaded   bool // started/resumed on our app-server
	policy   string
	turnID   string
	baseline *int64 // total tokens (in,out) at turn start
	baseOut  int64
	usage    protocol.Usage
	items    map[string]*cxLive
	opened   bool            // phone opened it: stream new history items while it runs elsewhere
	seen     map[string]bool // history item keys already sent (external threads)
}

// cxLive accumulates streaming state for one item.
type cxLive struct {
	text      string
	summary   []string
	content   []string
	output    string
	changes   []cxChange
	lastEvent protocol.Event
}

func newCodexAgent(sink func(protocol.Event), settings func() Settings, exe, stateFile string) *codexAgent {
	a := &codexAgent{exeOverride: exe, stateFile: stateFile, sink: sink, settings: settings,
		aps: newApprovals(), threads: map[string]*codexThread{}, owned: map[string]bool{}, closeCh: make(chan struct{})}
	a.thr = newThrottle(sink)
	a.loadState()
	return a
}

func (a *codexAgent) ID() string   { return "codex" }
func (a *codexAgent) Name() string { return "Codex" }

func (a *codexAgent) exe() (string, bool) {
	p, ok := findExecutable("codex", a.exeOverride)
	if ok && a.exeOverride == "" {
		if native := nativeCodexExe(p); native != "" {
			p = native
		}
	}
	return p, ok
}

func (a *codexAgent) Detect(ctx context.Context) protocol.Tool {
	t := protocol.Tool{ID: "codex", Name: "Codex"}
	p, ok := a.exe()
	if !ok {
		return t
	}
	v, ok := toolVersion(ctx, p)
	t.Available, t.Version = ok, v
	return t
}

// ---- persistence of bridge-started threads ----

func (a *codexAgent) loadState() {
	if a.stateFile == "" {
		return
	}
	b, err := os.ReadFile(a.stateFile)
	if err != nil {
		return
	}
	var ids []string
	if json.Unmarshal(b, &ids) == nil {
		for _, id := range ids {
			a.owned[id] = true
		}
	}
}

func (a *codexAgent) saveStateLocked() {
	if a.stateFile == "" {
		return
	}
	ids := make([]string, 0, len(a.owned))
	for id := range a.owned {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > 2000 {
		ids = ids[len(ids)-2000:]
	}
	b, _ := json.Marshal(ids)
	_ = os.MkdirAll(filepath.Dir(a.stateFile), 0o700)
	tmp := a.stateFile + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, a.stateFile)
	}
}

// ---- process management ----

func tomlString(s string, quoted bool) string {
	if !quoted {
		return s // codex falls back to a literal string when the value isn't valid TOML
	}
	b, _ := json.Marshal(s) // JSON string escapes are valid TOML basic-string escapes
	return string(b)
}

// codexArgs builds `codex app-server` with config overrides that force the relay provider.
func codexArgs(exe string, s Settings) []string {
	args := []string{"app-server"}
	if s.RelayRoot == "" {
		return args
	}
	// Through a .cmd shim cmd.exe re-parses the command line; avoid quotes and spaces there.
	quoted := !strings.EqualFold(filepath.Ext(exe), ".cmd") && !strings.EqualFold(filepath.Ext(exe), ".bat")
	base := strings.TrimRight(s.RelayRoot, "/") + "/v1"
	kv := [][2]string{
		{"model_provider", tomlString("salcara", quoted)},
		{"model_providers.salcara.name", tomlString("Salcara", quoted)},
		{"model_providers.salcara.base_url", tomlString(base, quoted)},
		{"model_providers.salcara.env_key", tomlString("SUB2API_API_KEY", quoted)},
		{"model_providers.salcara.wire_api", tomlString("responses", quoted)},
		{"model_providers.salcara.requires_openai_auth", "false"},
		{"model_providers.salcara.supports_websockets", "false"},
	}
	for _, p := range kv {
		args = append(args, "-c", p[0]+"="+p[1])
	}
	return args
}

func codexSig(s Settings) string { return s.RelayRoot + "\x00" + s.CodexKey }

func (a *codexAgent) hasActiveTurnsLocked() bool {
	for _, t := range a.threads {
		if t.loaded && t.turnID != "" {
			return true
		}
	}
	return false
}

// ensure returns a running, initialized app-server connection, starting (or restarting after a
// settings change) as needed. Restarts after crashes are rate-limited with exponential backoff.
func (a *codexAgent) ensure(ctx context.Context) (*rpcConn, error) {
	a.startMu.Lock()
	defer a.startMu.Unlock()
	s := a.settings()
	sig := codexSig(s)

	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, errors.New("桥接程序正在退出")
	}
	c := a.conn
	if c != nil && c.alive() {
		if a.connSig == sig || a.hasActiveTurnsLocked() {
			a.mu.Unlock()
			return c, nil
		}
		// Relay settings changed and nothing is running: restart with the new ones.
		a.conn = nil
		a.markUnloadedLocked()
		a.mu.Unlock()
		c.Kill()
		<-c.done
		a.mu.Lock()
	}
	wait := time.Until(a.nextStart)
	a.mu.Unlock()
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-a.closeCh:
			return nil, errors.New("桥接程序正在退出")
		}
	}

	exe, ok := a.exe()
	if !ok {
		return nil, errors.New("没有找到 Codex，请先安装 Codex CLI")
	}
	cmd := exec.Command(exe, codexArgs(exe, s)...)
	prepareCmd(cmd)
	env := map[string]string{"SUB2API_API_KEY": s.CodexKey}
	cmd.Env = childEnv(exe, env, nil)
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	c, err := startRPC(cmd, a.onNotify, nil)
	if err != nil {
		a.failedStart()
		return nil, errors.New("无法启动 Codex：" + err.Error())
	}
	c.onRequest = func(id json.RawMessage, method string, params json.RawMessage) {
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			a.onRequest(c, id, method, params)
		}()
	}
	ictx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	init := map[string]any{
		"clientInfo":   map[string]any{"name": "salcara_bridge", "title": "Salcara Bridge", "version": "1.0.0"},
		"capabilities": map[string]any{"experimentalApi": false, "requestAttestation": false},
	}
	if err := c.Call(ictx, "initialize", init, nil); err != nil {
		c.Kill()
		a.failedStart()
		msg := err.Error()
		if tail := c.stderrText(); tail != "" && !strings.Contains(msg, tail) {
			msg += "\n" + truncTail(tail, 600)
		}
		return nil, errors.New("Codex 启动失败：" + msg)
	}
	_ = c.Notify("initialized", nil)

	a.mu.Lock()
	a.conn, a.connSig, a.startedAt = c, sig, time.Now()
	a.mu.Unlock()
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		<-c.done
		a.onExit(c)
	}()
	return c, nil
}

func (a *codexAgent) failedStart() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.bumpBackoffLocked()
}

func (a *codexAgent) bumpBackoffLocked() {
	if a.backoff == 0 {
		a.backoff = time.Second
	} else {
		a.backoff *= 2
		if a.backoff > time.Minute {
			a.backoff = time.Minute
		}
	}
	a.nextStart = time.Now().Add(a.backoff)
}

func (a *codexAgent) markUnloadedLocked() {
	for _, t := range a.threads {
		t.loaded = false
		t.turnID = ""
		t.items = nil
	}
}

// onExit handles a dead app-server: running turns fail, approvals are withdrawn, the next call restarts.
func (a *codexAgent) onExit(c *rpcConn) {
	a.mu.Lock()
	if a.conn != c {
		a.mu.Unlock()
		return
	}
	a.conn = nil
	if time.Since(a.startedAt) > time.Minute {
		a.backoff = 0
	}
	a.bumpBackoffLocked()
	closed := a.closed
	var failed []*codexThread
	for _, t := range a.threads {
		if t.loaded && t.turnID != "" {
			failed = append(failed, t)
		}
	}
	a.markUnloadedLocked()
	var infos []protocol.SessionInfo
	for _, t := range failed {
		t.info.Status = "idle"
		infos = append(infos, t.info)
	}
	a.mu.Unlock()
	if closed {
		return
	}
	errText := "Codex 进程意外退出"
	if c.err != nil {
		errText = c.err.Error()
	}
	for _, info := range infos {
		a.aps.cancelSession(info.SessionKey)
		a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "turn", Status: "failed", Error: errText})
		a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})
	}
}

func (a *codexAgent) partial(e protocol.Event) {
	e.Tool = "codex"
	e.TS = nowMs()
	a.thr.Update(e)
}

func (a *codexAgent) emitFinal(e protocol.Event) {
	e.Tool = "codex"
	e.TS = nowMs()
	a.thr.Final(e)
}

func ptrInfo(i protocol.SessionInfo) *protocol.SessionInfo { return &i }

func (a *codexAgent) emit(e protocol.Event) {
	e.Tool = "codex"
	if e.TS == 0 {
		e.TS = nowMs()
	}
	a.sink(e)
}

// ---- thread state ----

func (a *codexAgent) threadLocked(id string) *codexThread {
	t := a.threads[id]
	if t == nil {
		t = &codexThread{id: id, info: protocol.SessionInfo{SessionKey: "codex:" + id, Tool: "codex", Client: "Codex", Status: "idle", Controllable: true}}
		a.threads[id] = t
	}
	return t
}

func fileRecentlyModified(path string) (time.Time, bool) {
	if path == "" {
		return time.Time{}, false
	}
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	return st.ModTime(), time.Since(st.ModTime()) < externalActive
}

// applyThreadLocked refreshes cached SessionInfo from a Thread object.
func (a *codexAgent) applyThreadLocked(th cxThread) *codexThread {
	t := a.threadLocked(th.ID)
	originator := ""
	if th.Originator != nil {
		originator = *th.Originator
	}
	info := &t.info
	info.Client = codexClient(th.Source, originator, a.owned[th.ID])
	title := ""
	if th.Name != nil {
		title = *th.Name
	}
	if title == "" {
		title = th.Preview
	}
	if title != "" {
		info.Title = titleText(title)
	}
	if th.Cwd != "" {
		info.Cwd = th.Cwd
	}
	if th.Model != nil && *th.Model != "" {
		info.Model = *th.Model
	}
	if th.UpdatedAt > 0 {
		info.UpdatedAt = th.UpdatedAt * 1000
	}
	if th.Path != nil {
		t.path = *th.Path
	}
	mt, recent := fileRecentlyModified(t.path)
	if ms := mt.UnixMilli(); !mt.IsZero() && ms > info.UpdatedAt {
		info.UpdatedAt = ms
	}
	switch th.Status.Type {
	case "active":
		info.Status = "running"
		for _, f := range th.Status.ActiveFlags {
			if f == "waitingOnApproval" {
				info.Status = "waiting_approval"
			}
		}
	case "systemError":
		info.Status = "failed"
	default:
		info.Status = "idle"
	}
	info.Controllable = true
	if !t.loaded && recent {
		// Another Codex (CLI / IDE / app) is writing this thread right now.
		info.Status = "running"
		info.Controllable = false
	}
	if t.loaded && t.turnID != "" {
		info.Status = "running"
		if a.aps.countFor(info.SessionKey) > 0 {
			info.Status = "waiting_approval"
		}
	}
	return t
}

// ---- Agent API ----

var codexSourceKinds = []string{"cli", "vscode", "exec", "appServer"}

func (a *codexAgent) listThreads(ctx context.Context) ([]cxThread, error) {
	c, err := a.ensure(ctx)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Data []cxThread `json:"data"`
	}
	params := map[string]any{"limit": maxSessions, "sortKey": "updated_at", "modelProviders": []string{}, "sourceKinds": codexSourceKinds}
	if err := c.Call(ctx, "thread/list", params, &resp); err != nil {
		var re *rpcError
		if !errors.As(err, &re) {
			return nil, err
		}
		// Older app-servers: fall back to the minimal request.
		if err := c.Call(ctx, "thread/list", map[string]any{"limit": maxSessions, "modelProviders": []string{}}, &resp); err != nil {
			return nil, err
		}
	}
	return resp.Data, nil
}

func (a *codexAgent) Sessions(ctx context.Context) ([]protocol.SessionInfo, error) {
	list, err := a.listThreads(ctx)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	out := make([]protocol.SessionInfo, 0, len(list))
	seen := map[string]bool{}
	for _, th := range list {
		if th.Ephemeral || (th.ParentThreadID != nil && *th.ParentThreadID != "") {
			continue
		}
		t := a.applyThreadLocked(th)
		seen[t.id] = true
		out = append(out, t.info)
	}
	// Threads running on our app-server that thread/list doesn't return (yet): codex may write the
	// rollout file lazily or filter the list by source, and a phone-started task must not vanish.
	for id, t := range a.threads {
		if !seen[id] && t.loaded && t.info.SessionKey != "" {
			out = append(out, t.info)
		}
	}
	a.mu.Unlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	if len(out) > maxSessions {
		out = out[:maxSessions]
	}
	return out, nil
}

func (a *codexAgent) readThread(ctx context.Context, id string) (cxThread, error) {
	c, err := a.ensure(ctx)
	if err != nil {
		return cxThread{}, err
	}
	var resp struct {
		Thread cxThread `json:"thread"`
	}
	if err := c.Call(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": true}, &resp); err != nil {
		return cxThread{}, err
	}
	return resp.Thread, nil
}

func historyKeys(th cxThread) []string {
	var keys []string
	for _, t := range th.Turns {
		for i := range t.Items {
			keys = append(keys, t.ID+":"+strconv.Itoa(i))
		}
	}
	return keys
}

func (a *codexAgent) Open(ctx context.Context, id string) (protocol.SessionInfo, []protocol.Event, error) {
	th, err := a.readThread(ctx, id)
	if err != nil {
		return protocol.SessionInfo{}, nil, err
	}
	a.mu.Lock()
	t := a.applyThreadLocked(th)
	t.opened = true
	t.seen = map[string]bool{}
	for _, k := range historyKeys(th) {
		t.seen[k] = true
	}
	info := t.info
	a.mu.Unlock()
	evs := dedupeEvents(codexHistory(info.SessionKey, th), maxHistoryEvents)
	return info, evs, nil
}

func codexPolicy(approval string) (string, string) {
	if normalizePolicy(approval) == "auto_all" {
		return "on-request", "workspace-write"
	}
	// "untrusted": every command that isn't a known-safe read asks, and so does every patch.
	return "untrusted", "workspace-write"
}

func (a *codexAgent) requireRelay() (Settings, error) {
	s := a.settings()
	if s.RelayRoot == "" || s.CodexKey == "" {
		return s, errors.New("请先在电脑端控制台填写中转站地址和 Codex 使用的 Key")
	}
	return s, nil
}

func (a *codexAgent) Start(ctx context.Context, cwd, prompt, model, approval string) (string, error) {
	s, err := a.requireRelay()
	if err != nil {
		return "", err
	}
	c, err := a.ensure(ctx)
	if err != nil {
		return "", err
	}
	if approval == "" {
		approval = s.Approval
	}
	approval = normalizePolicy(approval)
	if model == "" {
		model = s.CodexModel
	}
	ap, sb := codexPolicy(approval)
	params := map[string]any{"cwd": cwd, "approvalPolicy": ap, "sandbox": sb, "modelProvider": "salcara"}
	if model != "" {
		params["model"] = model
	}
	var resp struct {
		Thread cxThread `json:"thread"`
		Model  string   `json:"model"`
	}
	if err := c.Call(ctx, "thread/start", params, &resp); err != nil {
		return "", errors.New("Codex 创建会话失败：" + err.Error())
	}
	id := resp.Thread.ID
	a.mu.Lock()
	a.owned[id] = true
	a.saveStateLocked()
	t := a.applyThreadLocked(resp.Thread)
	t.loaded, t.policy = true, approval
	if t.info.Title == "" {
		t.info.Title = titleText(prompt)
	}
	if t.info.Cwd == "" {
		t.info.Cwd = cwd
	}
	if resp.Model != "" {
		t.info.Model = resp.Model
	}
	t.info.Status = "running"
	t.info.UpdatedAt = nowMs()
	info := t.info
	a.mu.Unlock()
	a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})
	if err := a.startTurn(ctx, c, id, prompt); err != nil {
		return id, err
	}
	return id, nil
}

func (a *codexAgent) startTurn(ctx context.Context, c *rpcConn, id, text string) error {
	params := map[string]any{"threadId": id, "input": []map[string]any{{"type": "text", "text": text, "text_elements": []any{}}}}
	var resp struct {
		Turn cxTurn `json:"turn"`
	}
	if err := c.Call(ctx, "turn/start", params, &resp); err != nil {
		return errors.New("Codex 发送失败：" + err.Error())
	}
	a.mu.Lock()
	if t := a.threads[id]; t != nil && resp.Turn.ID != "" && resp.Turn.Status == "inProgress" {
		t.turnID = resp.Turn.ID
	}
	a.mu.Unlock()
	return nil
}

func (a *codexAgent) Send(ctx context.Context, id, text string) error {
	s, err := a.requireRelay()
	if err != nil {
		return err
	}
	c, err := a.ensure(ctx)
	if err != nil {
		return err
	}
	a.mu.Lock()
	t := a.threadLocked(id)
	loaded := t.loaded
	path := t.path
	policy := t.policy
	a.mu.Unlock()
	if !loaded {
		if path == "" {
			if th, err := a.readThread(ctx, id); err == nil && th.Path != nil {
				path = *th.Path
			}
		}
		if _, recent := fileRecentlyModified(path); recent {
			return errors.New(errExternalRunning)
		}
		if policy == "" {
			policy = normalizePolicy(s.Approval)
		}
		ap, sb := codexPolicy(policy)
		params := map[string]any{"threadId": id, "approvalPolicy": ap, "sandbox": sb, "modelProvider": "salcara"}
		if s.CodexModel != "" {
			params["model"] = s.CodexModel
		}
		var resp struct {
			Thread cxThread `json:"thread"`
		}
		if err := c.Call(ctx, "thread/resume", params, &resp); err != nil {
			return errors.New("Codex 恢复会话失败：" + err.Error())
		}
		a.mu.Lock()
		resp.Thread.Turns = nil
		t = a.applyThreadLocked(resp.Thread)
		t.loaded, t.policy = true, policy
		a.mu.Unlock()
	}
	return a.startTurn(ctx, c, id, text)
}

func (a *codexAgent) Interrupt(ctx context.Context, id string) error {
	a.mu.Lock()
	t := a.threads[id]
	turn := ""
	loaded := false
	if t != nil {
		turn, loaded = t.turnID, t.loaded
	}
	c := a.conn
	a.mu.Unlock()
	if !loaded || turn == "" || c == nil {
		return nil
	}
	a.aps.cancelSession("codex:" + id)
	return c.Call(ctx, "turn/interrupt", map[string]any{"threadId": id, "turnId": turn}, nil)
}

func (a *codexAgent) Respond(approvalID, decision, message string) bool {
	return a.aps.answer(approvalID, approvalAnswer{decision: normalizeDecision(decision), message: message, by: "phone"})
}

func (a *codexAgent) Models(ctx context.Context) []string {
	c, err := a.ensure(ctx)
	if err != nil {
		return nil
	}
	var resp struct {
		Data []struct {
			ID     string `json:"id"`
			Model  string `json:"model"`
			Hidden bool   `json:"hidden"`
		} `json:"data"`
	}
	if err := c.Call(ctx, "model/list", map[string]any{}, &resp); err != nil {
		return nil
	}
	var out []string
	for _, m := range resp.Data {
		if m.Hidden {
			continue
		}
		name := m.Model
		if name == "" {
			name = m.ID
		}
		out = append(out, name)
	}
	return out
}

func (a *codexAgent) Close() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.closed = true
	close(a.closeCh)
	c := a.conn
	a.conn = nil
	a.mu.Unlock()
	a.aps.cancelAll()
	a.thr.Close()
	if c != nil {
		c.Kill()
		<-c.done
	}
	a.wg.Wait()
}

// ---- notifications ----

type cxNote struct {
	ThreadID  string          `json:"threadId"`
	TurnID    string          `json:"turnId"`
	ItemID    string          `json:"itemId"`
	Delta     string          `json:"delta"`
	Index     int             `json:"summaryIndex"`
	Item      json.RawMessage `json:"item"`
	Turn      *cxTurn         `json:"turn"`
	Thread    *cxThread       `json:"thread"`
	Status    *cxThreadStatus `json:"status"`
	Changes   []cxChange      `json:"changes"`
	WillRetry bool            `json:"willRetry"`
	Error     *cxTurnError    `json:"error"`
	RequestID json.RawMessage `json:"requestId"`
	Usage     *struct {
		Total struct {
			InputTokens  int64 `json:"inputTokens"`
			OutputTokens int64 `json:"outputTokens"`
		} `json:"total"`
		Last struct {
			InputTokens  int64 `json:"inputTokens"`
			OutputTokens int64 `json:"outputTokens"`
		} `json:"last"`
	} `json:"tokenUsage"`
}

func (t *codexThread) live(itemID string) *cxLive {
	if t.items == nil {
		t.items = map[string]*cxLive{}
	}
	l := t.items[itemID]
	if l == nil {
		l = &cxLive{}
		t.items[itemID] = l
	}
	return l
}

func (a *codexAgent) onNotify(method string, params json.RawMessage) {
	var n cxNote
	_ = json.Unmarshal(params, &n)
	sk := "codex:" + n.ThreadID
	switch method {
	case "thread/started":
		if n.Thread == nil {
			return
		}
		a.mu.Lock()
		t := a.applyThreadLocked(*n.Thread)
		info := t.info
		a.mu.Unlock()
		a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})

	case "thread/status/changed":
		if n.Status == nil {
			return
		}
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		old := t.info.Status
		switch n.Status.Type {
		case "active":
			t.info.Status = "running"
			for _, f := range n.Status.ActiveFlags {
				if f == "waitingOnApproval" {
					t.info.Status = "waiting_approval"
				}
			}
		case "systemError":
			t.info.Status = "failed"
		default:
			t.info.Status = "idle"
		}
		t.info.UpdatedAt = nowMs()
		info := t.info
		a.mu.Unlock()
		if old != info.Status {
			a.emit(protocol.Event{SessionKey: sk, Type: "session.updated", Session: ptrInfo(info)})
		}

	case "turn/started":
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		if n.Turn != nil {
			t.turnID = n.Turn.ID
		}
		t.baseline, t.usage = nil, protocol.Usage{}
		t.info.Status = "running"
		t.info.UpdatedAt = nowMs()
		info := t.info
		a.mu.Unlock()
		a.emit(protocol.Event{SessionKey: sk, Type: "turn", Status: "started"})
		a.emit(protocol.Event{SessionKey: sk, Type: "session.updated", Session: ptrInfo(info)})

	case "turn/completed":
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		t.turnID = ""
		t.items = nil
		usage := t.usage
		t.info.Status = "idle"
		t.info.UpdatedAt = nowMs()
		info := t.info
		a.mu.Unlock()
		a.aps.cancelSession(sk)
		e := protocol.Event{SessionKey: sk, Type: "turn", Status: "completed"}
		if n.Turn != nil {
			e.Status = codexTurnStatus(n.Turn.Status)
			if e.Status == "started" {
				e.Status = "completed"
			}
			if n.Turn.Error != nil {
				e.Error = n.Turn.Error.Message
			}
		}
		if usage.InputTokens > 0 || usage.OutputTokens > 0 {
			e.Usage = &usage
		}
		a.emit(e)
		a.emit(protocol.Event{SessionKey: sk, Type: "session.updated", Session: ptrInfo(info)})

	case "thread/tokenUsage/updated":
		if n.Usage == nil {
			return
		}
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		if t.baseline == nil {
			in := n.Usage.Total.InputTokens - n.Usage.Last.InputTokens
			t.baseline = &in
			t.baseOut = n.Usage.Total.OutputTokens - n.Usage.Last.OutputTokens
		}
		t.usage = protocol.Usage{InputTokens: n.Usage.Total.InputTokens - *t.baseline, OutputTokens: n.Usage.Total.OutputTokens - t.baseOut}
		a.mu.Unlock()

	case "item/started", "item/completed":
		var it cxItem
		if json.Unmarshal(n.Item, &it) != nil {
			return
		}
		completed := method == "item/completed"
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		cwd := t.info.Cwd
		if it.Type == "fileChange" {
			l := t.live(it.ID)
			if len(it.Changes) > 0 {
				l.changes = it.Changes
			} else {
				it.Changes = l.changes
			}
		}
		if !completed && it.Type == "commandExecution" && it.AggregatedOutput == nil {
			if l := t.items[it.ID]; l != nil && l.output != "" {
				out := l.output
				it.AggregatedOutput = &out
			}
		}
		e, ok := codexItemEvent(sk, it, completed, cwd)
		if ok && !completed && e.Type == "tool" {
			t.live(it.ID).lastEvent = e
		}
		a.mu.Unlock()
		if !ok {
			return
		}
		a.emitFinal(e)

	case "item/agentMessage/delta":
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		l := t.live(n.ItemID)
		l.text += n.Delta
		text := l.text
		a.mu.Unlock()
		a.partial(protocol.Event{SessionKey: sk, Type: "message", ID: n.ItemID, Role: "assistant", Text: text})

	case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded":
		var idx struct {
			SummaryIndex *int `json:"summaryIndex"`
			ContentIndex *int `json:"contentIndex"`
		}
		_ = json.Unmarshal(params, &idx)
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		l := t.live(n.ItemID)
		if method == "item/reasoning/textDelta" {
			i := 0
			if idx.ContentIndex != nil {
				i = *idx.ContentIndex
			}
			for len(l.content) <= i {
				l.content = append(l.content, "")
			}
			l.content[i] += n.Delta
		} else {
			i := 0
			if idx.SummaryIndex != nil {
				i = *idx.SummaryIndex
			}
			for len(l.summary) <= i {
				l.summary = append(l.summary, "")
			}
			l.summary[i] += n.Delta
		}
		cj, _ := json.Marshal(l.content)
		text := reasoningText(l.summary, cj)
		a.mu.Unlock()
		if text != "" {
			a.partial(protocol.Event{SessionKey: sk, Type: "reasoning", ID: n.ItemID, Text: text})
		}

	case "item/commandExecution/outputDelta":
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		l := t.live(n.ItemID)
		l.output += n.Delta
		if len(l.output) > 64*1024 {
			l.output = l.output[len(l.output)-32*1024:]
		}
		e := l.lastEvent
		if e.ID == "" {
			e = protocol.Event{SessionKey: sk, Type: "tool", ID: n.ItemID, Kind: "command", Title: "运行命令"}
		}
		e.Status = "running"
		e.Output = truncTail(l.output, maxOutputChars)
		a.mu.Unlock()
		a.partial(e)

	case "item/fileChange/patchUpdated":
		a.mu.Lock()
		t := a.threadLocked(n.ThreadID)
		l := t.live(n.ItemID)
		l.changes = n.Changes
		cwd := t.info.Cwd
		a.mu.Unlock()
		a.partial(protocol.Event{SessionKey: sk, Type: "tool", ID: n.ItemID, Kind: "file_change", Status: "running",
			Title: codexChangesTitle(n.Changes, cwd), Diff: codexChangesDiff(n.Changes)})

	case "error":
		if n.Error == nil {
			return
		}
		level := "error"
		text := n.Error.Message
		if n.WillRetry {
			level = "warn"
			text += "（正在重试）"
		}
		a.emit(protocol.Event{SessionKey: sk, Type: "notice", Level: level, Text: truncHead(text, 1000)})

	case "serverRequest/resolved":
		a.aps.resolveByRef(string(n.RequestID))
	}
}
