package agents

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"salcara/bridge/internal/protocol"
)

// claudeAgent runs one `claude -p --input-format stream-json` process per session the bridge drives and
// reads ~/.claude/projects for everything else.
type claudeAgent struct {
	exeOverride string
	home        string // ~/.claude (or $CLAUDE_CONFIG_DIR)
	sink        func(protocol.Event)
	settings    func() Settings
	thr         *throttle
	aps         *approvals
	hist        *claudeHistory

	mu          sync.Mutex
	procs       map[string]*claudeProc
	live        map[string]protocol.SessionInfo // sessions run by the bridge (this bridge run)
	policies    map[string]string
	allowed     map[string]map[string]bool // "allow_session" tool names per session
	recentOwned map[string]time.Time       // when a bridge process for the session last exited
	closed      bool
	closeCh     chan struct{}
	wg          sync.WaitGroup
}

type claudeProc struct {
	id      string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	wmu     sync.Mutex
	cwd     string
	policy  string
	mcpFile string
	mapper  *claudeMapper
	done    chan struct{}

	mu        sync.Mutex
	turns     int // user turns written but not yet answered by a result
	stopped   bool
	stderrBuf []byte
}

func newClaudeAgent(sink func(protocol.Event), settings func() Settings, exe, home string) *claudeAgent {
	if home == "" {
		home = defaultClaudeHome()
	}
	a := &claudeAgent{exeOverride: exe, home: home, sink: sink, settings: settings, aps: newApprovals(),
		procs: map[string]*claudeProc{}, live: map[string]protocol.SessionInfo{}, policies: map[string]string{},
		allowed: map[string]map[string]bool{}, recentOwned: map[string]time.Time{}, closeCh: make(chan struct{})}
	a.thr = newThrottle(sink)
	a.hist = newClaudeHistory(filepath.Join(home, "projects"))
	return a
}

func defaultClaudeHome() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".claude")
}

func (a *claudeAgent) ID() string   { return "claude" }
func (a *claudeAgent) Name() string { return "Claude Code" }

func (a *claudeAgent) exe() (string, bool) { return findExecutable("claude", a.exeOverride) }

func (a *claudeAgent) Detect(ctx context.Context) protocol.Tool {
	t := protocol.Tool{ID: "claude", Name: "Claude Code"}
	p, ok := a.exe()
	if !ok {
		return t
	}
	v, ok := toolVersion(ctx, p)
	t.Available, t.Version = ok, v
	return t
}

func (a *claudeAgent) emit(e protocol.Event) {
	e.Tool = "claude"
	if e.TS == 0 {
		e.TS = nowMs()
	}
	a.sink(e)
}

func (a *claudeAgent) Models(ctx context.Context) []string {
	return []string{"sonnet", "opus", "haiku"}
}

func (a *claudeAgent) Respond(approvalID, decision, message string) bool {
	return a.aps.answer(approvalID, approvalAnswer{decision: normalizeDecision(decision), message: message, by: "phone"})
}

// ownedLocked: the bridge drives this session now or did a moment ago (its transcript writes are ours).
func (a *claudeAgent) ownedLocked(id string) bool {
	if a.procs[id] != nil {
		return true
	}
	if t, ok := a.recentOwned[id]; ok && time.Since(t) < 10*time.Second {
		return true
	}
	return false
}

// ---- process lifecycle ----

func (a *claudeAgent) mcpConfig(s Settings, id string) (string, error) {
	exe := s.BridgeExe
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return "", err
		}
	}
	cfg := map[string]any{"mcpServers": map[string]any{"salcara": map[string]any{
		"type":    "stdio",
		"command": exe,
		"args":    []string{"mcp-approval", "--port", strconv.Itoa(s.LocalPort), "--token", s.LocalToken, "--session", id},
	}}}
	b, _ := json.Marshal(cfg)
	dir := filepath.Join(os.TempDir(), "salcara-bridge")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "mcp-"+id+".json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func claudeArgs(id, mcpFile, model, policy string, resume bool) []string {
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--permission-prompt-tool", "mcp__salcara__approve", "--mcp-config", mcpFile}
	if resume {
		args = append(args, "--resume", id)
	} else {
		args = append(args, "--session-id", id)
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	if policy == "auto_edits" {
		args = append(args, "--permission-mode", "acceptEdits")
	}
	return args
}

func (a *claudeAgent) spawn(id, cwd, model, policy string, resume bool) (*claudeProc, error) {
	s := a.settings()
	if s.RelayRoot == "" || s.ClaudeKey == "" {
		return nil, errors.New("请先在电脑端控制台填写中转站地址和 Claude Code 使用的 Key")
	}
	exe, ok := a.exe()
	if !ok {
		return nil, errors.New("没有找到 Claude Code，请先安装 Claude Code")
	}
	if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
		return nil, errors.New("文件夹不存在：" + cwd)
	}
	mcpFile, err := a.mcpConfig(s, id)
	if err != nil {
		return nil, errors.New("无法写入审批配置：" + err.Error())
	}
	cmd := exec.Command(exe, claudeArgs(id, mcpFile, model, policy, resume)...)
	prepareCmd(cmd)
	cmd.Dir = cwd
	cmd.Env = childEnv(exe, map[string]string{
		"ANTHROPIC_BASE_URL":                       strings.TrimRight(s.RelayRoot, "/"),
		"ANTHROPIC_AUTH_TOKEN":                     s.ClaudeKey,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
		"MCP_TOOL_TIMEOUT":                         "700000", // approvals wait up to 10 minutes
	}, []string{"ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"})
	stdin, err := cmd.StdinPipe()
	if err != nil {
		os.Remove(mcpFile)
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		os.Remove(mcpFile)
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		os.Remove(mcpFile)
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		os.Remove(mcpFile)
		return nil, errors.New("无法启动 Claude Code：" + err.Error())
	}
	p := &claudeProc{id: id, cmd: cmd, stdin: stdin, cwd: cwd, policy: policy, mcpFile: mcpFile,
		mapper: newClaudeMapper("claude:"+id, cwd), done: make(chan struct{})}
	a.wg.Add(2)
	go func() {
		defer a.wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				p.mu.Lock()
				p.stderrBuf = append(p.stderrBuf, buf[:n]...)
				if len(p.stderrBuf) > 4096 {
					p.stderrBuf = p.stderrBuf[len(p.stderrBuf)-4096:]
				}
				p.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer a.wg.Done()
		br := bufio.NewReaderSize(stdout, 1<<20)
		for {
			line, err := br.ReadBytes('\n')
			if len(line) > 0 {
				a.handleLine(p, line)
			}
			if err != nil {
				break
			}
		}
		werr := cmd.Wait()
		a.onExit(p, werr)
	}()
	return p, nil
}

func (a *claudeAgent) writeTurn(p *claudeProc, text string) error {
	msg := map[string]any{"type": "user", "session_id": p.id, "parent_tool_use_id": nil,
		"message": map[string]any{"role": "user", "content": []map[string]any{{"type": "text", "text": text}}}}
	b, _ := json.Marshal(msg)
	b = append(b, '\n')
	p.wmu.Lock()
	_, err := p.stdin.Write(b)
	p.wmu.Unlock()
	if err != nil {
		return errors.New("无法发送给 Claude Code：" + err.Error())
	}
	p.mu.Lock()
	p.turns++
	p.mu.Unlock()
	sk := "claude:" + p.id
	a.emit(protocol.Event{SessionKey: sk, Type: "message", ID: newID("u_"), Role: "user", Text: text, Final: true})
	a.emit(protocol.Event{SessionKey: sk, Type: "turn", Status: "started"})
	a.setLive(p.id, func(i *protocol.SessionInfo) { i.Status = "running" })
	return nil
}

// setLive updates the cached SessionInfo of a bridge-run session and emits session.updated.
func (a *claudeAgent) setLive(id string, f func(*protocol.SessionInfo)) {
	a.mu.Lock()
	info, ok := a.live[id]
	if !ok {
		info = protocol.SessionInfo{SessionKey: "claude:" + id, Tool: "claude", Client: "Claude Code", Controllable: true, Status: "idle"}
		if h, ok := a.hist.info(id); ok {
			info = h
		}
	}
	f(&info)
	info.UpdatedAt = nowMs()
	info.Controllable = true
	a.live[id] = info
	a.mu.Unlock()
	a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})
}

func (a *claudeAgent) handleLine(p *claudeProc, line []byte) {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	if l.ParentTU != nil && *l.ParentTU != "" {
		return // sub-agent traffic
	}
	sk := "claude:" + p.id
	switch l.Type {
	case "system":
		if l.Subtype == "init" && l.Model != "" {
			a.mu.Lock()
			if info, ok := a.live[p.id]; ok {
				info.Model = l.Model
				a.live[p.id] = info
			}
			a.mu.Unlock()
		}
		if l.Subtype == "compact_boundary" {
			a.emit(protocol.Event{SessionKey: sk, Type: "notice", Level: "info", Text: "上下文已压缩"})
		}
	case "stream_event":
		for _, e := range p.mapper.stream(l.Event) {
			e.Tool = "claude"
			a.thr.Update(e)
		}
	case "assistant":
		for _, e := range p.mapper.assistant(l.Message, newID("m_"), nowMs()) {
			a.thr.Final(e)
		}
	case "user":
		l.IsMeta = true // typed text is emitted by writeTurn; only tool results matter here
		for _, e := range p.mapper.user(&l, "", nowMs()) {
			a.thr.Final(e)
		}
	case "result":
		p.mu.Lock()
		if p.turns > 0 {
			p.turns--
		}
		busy := p.turns > 0
		p.mu.Unlock()
		e := protocol.Event{SessionKey: sk, Type: "turn", Status: "completed"}
		if l.IsError || (l.Subtype != "" && l.Subtype != "success") {
			e.Status = "failed"
			e.Error = l.Result
			if e.Error == "" {
				e.Error = strings.Join(l.Errors, "\n")
			}
			if e.Error == "" {
				e.Error = l.Subtype
			}
			e.Error = truncHead(e.Error, 2000)
		}
		if l.Usage != nil || l.TotalCostUSD > 0 {
			u := protocol.Usage{CostUSD: l.TotalCostUSD}
			if l.Usage != nil {
				u.InputTokens = l.Usage.InputTokens + l.Usage.CacheReadTokens + l.Usage.CacheCreationTokens
				u.OutputTokens = l.Usage.OutputTokens
			}
			e.Usage = &u
		}
		a.emit(e)
		if !busy {
			a.setLive(p.id, func(i *protocol.SessionInfo) { i.Status = "idle" })
		}
	}
}

func (a *claudeAgent) onExit(p *claudeProc, werr error) {
	a.mu.Lock()
	if a.procs[p.id] == p {
		delete(a.procs, p.id)
	}
	a.recentOwned[p.id] = time.Now()
	closed := a.closed
	a.mu.Unlock()
	close(p.done)
	os.Remove(p.mcpFile)
	a.aps.cancelSession("claude:" + p.id)
	p.mu.Lock()
	turns, stopped := p.turns, p.stopped
	tail := strings.TrimSpace(string(p.stderrBuf))
	p.mu.Unlock()
	if closed {
		return
	}
	sk := "claude:" + p.id
	if turns > 0 {
		e := protocol.Event{SessionKey: sk, Type: "turn", Status: "interrupted"}
		if !stopped {
			e.Status = "failed"
			msg := "Claude Code 意外退出"
			if werr != nil {
				msg += "：" + werr.Error()
			}
			if tail != "" {
				msg += "\n" + truncTail(tail, 800)
			}
			e.Error = msg
		}
		a.emit(e)
	}
	a.setLive(p.id, func(i *protocol.SessionInfo) { i.Status = "idle" })
}

func (a *claudeAgent) stop(p *claudeProc) {
	p.mu.Lock()
	p.stopped = true
	p.mu.Unlock()
	_ = p.stdin.Close()
	killTree(p.cmd)
}

// ---- Agent API ----

func (a *claudeAgent) Start(ctx context.Context, cwd, prompt, model, approval string) (string, error) {
	s := a.settings()
	if approval == "" {
		approval = s.Approval
	}
	approval = normalizePolicy(approval)
	if model == "" {
		model = s.ClaudeModel
	}
	id := newUUID()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return "", errors.New("桥接程序正在退出")
	}
	a.policies[id] = approval
	a.live[id] = protocol.SessionInfo{SessionKey: "claude:" + id, Tool: "claude", Client: "Claude Code", Title: titleText(prompt),
		Cwd: cwd, UpdatedAt: nowMs(), Status: "running", Controllable: true, Model: model}
	a.mu.Unlock()
	p, err := a.spawn(id, cwd, model, approval, false)
	if err != nil {
		a.mu.Lock()
		delete(a.live, id)
		delete(a.policies, id)
		a.mu.Unlock()
		return "", err
	}
	a.mu.Lock()
	a.procs[id] = p
	a.mu.Unlock()
	if err := a.writeTurn(p, prompt); err != nil {
		a.stop(p)
		return "", err
	}
	return id, nil
}

func (a *claudeAgent) Send(ctx context.Context, id, text string) error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return errors.New("桥接程序正在退出")
	}
	p := a.procs[id]
	owned := a.ownedLocked(id)
	policy := a.policies[id]
	liveInfo, hasLive := a.live[id]
	a.mu.Unlock()
	if p != nil {
		select {
		case <-p.done:
			p = nil
		default:
		}
	}
	if p != nil {
		return a.writeTurn(p, text)
	}
	info, ok := a.hist.info(id)
	if !ok && hasLive {
		info, ok = liveInfo, true
	}
	if !ok {
		return errors.New("找不到这个会话")
	}
	if !owned {
		if mt, err := a.hist.modTime(id); err == nil && time.Since(mt) < externalActive {
			return errors.New(errExternalRunning)
		}
	}
	s := a.settings()
	if policy == "" {
		policy = normalizePolicy(s.Approval)
	}
	cwd := info.Cwd
	if cwd == "" && hasLive {
		cwd = liveInfo.Cwd
	}
	a.mu.Lock()
	a.policies[id] = policy
	if _, ok := a.live[id]; !ok {
		a.live[id] = info
	}
	a.mu.Unlock()
	np, err := a.spawn(id, cwd, s.ClaudeModel, policy, true)
	if err != nil {
		return err
	}
	a.mu.Lock()
	if old := a.procs[id]; old != nil {
		a.mu.Unlock()
		a.stop(np)
		return a.writeTurn(old, text)
	}
	a.procs[id] = np
	a.mu.Unlock()
	return a.writeTurn(np, text)
}

func (a *claudeAgent) Interrupt(ctx context.Context, id string) error {
	a.mu.Lock()
	p := a.procs[id]
	a.mu.Unlock()
	if p == nil {
		return nil
	}
	a.stop(p)
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
	case <-ctx.Done():
	}
	return nil
}

func (a *claudeAgent) Close() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.closed = true
	close(a.closeCh)
	procs := make([]*claudeProc, 0, len(a.procs))
	for _, p := range a.procs {
		procs = append(procs, p)
	}
	a.mu.Unlock()
	a.aps.cancelAll()
	a.thr.Close()
	for _, p := range procs {
		a.stop(p)
	}
	for _, p := range procs {
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
		}
	}
	a.wg.Wait()
}

// Sessions merges transcripts on disk with sessions the bridge is running.
func (a *claudeAgent) Sessions(ctx context.Context) ([]protocol.SessionInfo, error) {
	list := a.hist.list()
	a.mu.Lock()
	seen := map[string]bool{}
	for i := range list {
		id := strings.TrimPrefix(list[i].SessionKey, "claude:")
		seen[id] = true
		a.decorateLocked(id, &list[i])
	}
	for id, info := range a.live {
		if !seen[id] {
			a.decorateLocked(id, &info)
			list = append(list, info)
		}
	}
	a.mu.Unlock()
	sortSessions(list)
	if len(list) > maxSessions {
		list = list[:maxSessions]
	}
	return list, nil
}

// decorateLocked fills status/controllable from bridge processes and file activity.
func (a *claudeAgent) decorateLocked(id string, info *protocol.SessionInfo) {
	if p := a.procs[id]; p != nil {
		live := a.live[id]
		if live.Title != "" && info.Title == "" {
			info.Title = live.Title
		}
		if live.Model != "" && info.Model == "" {
			info.Model = live.Model
		}
		p.mu.Lock()
		busy := p.turns > 0
		p.mu.Unlock()
		info.Status = "idle"
		if busy {
			info.Status = "running"
		}
		if a.aps.countFor(info.SessionKey) > 0 {
			info.Status = "waiting_approval"
		}
		info.Controllable = true
		return
	}
	if !a.ownedLocked(id) && time.Since(time.UnixMilli(info.UpdatedAt)) < externalActive {
		info.Status, info.Controllable = "running", false
		return
	}
	info.Status, info.Controllable = "idle", true
}

func (a *claudeAgent) Open(ctx context.Context, id string) (protocol.SessionInfo, []protocol.Event, error) {
	info, evs, err := a.hist.open(id)
	if err != nil {
		a.mu.Lock()
		live, ok := a.live[id]
		a.mu.Unlock()
		if !ok {
			return protocol.SessionInfo{}, nil, err
		}
		info, evs = live, nil
	}
	a.mu.Lock()
	a.decorateLocked(id, &info)
	a.mu.Unlock()
	return info, evs, nil
}
