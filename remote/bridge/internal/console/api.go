package console

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"salcara/bridge/internal/applog"
	"salcara/bridge/internal/autostart"
	"salcara/bridge/internal/config"
	"salcara/bridge/internal/hubclient"
	"salcara/bridge/internal/macapp"
	"salcara/bridge/internal/protocol"
	"salcara/bridge/internal/relay"
	"salcara/bridge/internal/toolcfg"
)

func (s *Server) routes(m *http.ServeMux) {
	m.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]bool{"ok": true}) })
	m.HandleFunc("GET /api/state", s.handleState)
	m.HandleFunc("GET /api/stream", s.handleStream)
	m.HandleFunc("GET /api/usage", s.handleUsage)
	m.HandleFunc("POST /api/test", s.handleTest)
	m.HandleFunc("POST /api/login", s.handleLogin)
	m.HandleFunc("POST /api/logout", s.handleLogout)
	m.HandleFunc("GET /api/secret", s.handleSecret)
	m.HandleFunc("POST /api/device", s.handleDevice)
	m.HandleFunc("POST /api/pair/start", s.handlePairStart)
	m.HandleFunc("GET /api/toolcfg", s.handleToolcfg)
	m.HandleFunc("POST /api/toolcfg", s.handleToolcfgAction)
	m.HandleFunc("GET /api/projects", s.handleProjects)
	m.HandleFunc("POST /api/projects", s.handleProjectAdd)
	m.HandleFunc("POST /api/projects/remove", s.handleProjectRemove)
	m.HandleFunc("GET /api/fs", s.handleFS)
	m.HandleFunc("GET /api/sessions", s.handleSessions)
	m.HandleFunc("GET /api/session", s.handleSession)
	m.HandleFunc("POST /api/session/send", s.handleSessionCmd("session.send"))
	m.HandleFunc("POST /api/session/interrupt", s.handleSessionCmd("session.interrupt"))
	m.HandleFunc("GET /api/approvals", s.handleApprovals)
	m.HandleFunc("POST /api/approval", s.handleApproval)
	m.HandleFunc("POST /api/settings", s.handleSettings)
	m.HandleFunc("GET /api/logs", s.handleLogs)
	m.HandleFunc("POST /api/quit", s.handleQuit)
	m.HandleFunc("POST /api/reveal", s.handleReveal)
}

func (s *Server) handlePairStart(w http.ResponseWriter, r *http.Request) {
	if s.d.Hub == nil {
		writeErr(w, http.StatusServiceUnavailable, "远程服务尚未启动")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	code, expires, err := s.d.Hub.PairStart(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]any{"code": code, "expiresAt": expires})
}

func mask(k string) string {
	if k == "" {
		return ""
	}
	if len(k) <= 10 {
		return strings.Repeat("•", 6)
	}
	return k[:5] + "••••••" + k[len(k)-4:]
}

func (s *Server) tools(ctx context.Context) []protocol.Tool {
	var tools []protocol.Tool
	if s.d.Hub != nil {
		tools = s.d.Hub.Tools()
	}
	if len(tools) == 0 {
		if m := s.manager(); m != nil {
			for _, a := range m.Agents() {
				c, cancel := context.WithTimeout(ctx, 10*time.Second)
				tools = append(tools, a.Detect(c))
				cancel()
			}
		}
	}
	if tools == nil {
		tools = []protocol.Tool{}
	}
	return tools
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	c := s.d.Store.Get()
	var hub any = hubclient.Status{State: hubclient.StateNotLoggedIn}
	if s.d.Hub != nil {
		hub = s.d.Hub.Status()
	}
	ctx, cancel := ctxTimeout(r, 20*time.Second)
	defer cancel()
	home, _ := os.UserHomeDir()
	writeJSON(w, map[string]any{
		"version":       s.d.Version,
		"os":            runtime.GOOS,
		"arch":          runtime.GOARCH,
		"home":          home,
		"exe":           s.d.Exe,
		"appBundle":     macapp.BundleOf(s.d.Exe),
		"installedFrom": os.Getenv(macapp.EnvInstalledFrom),
		"configDir":     s.d.Dir,
		"config": map[string]any{
			"relayRoot":          c.RelayRoot,
			"hubUrl":             c.HubURL,
			"effectiveHubUrl":    c.EffectiveHubURL(),
			"deviceId":           c.DeviceID,
			"deviceName":         c.DeviceName,
			"approval":           c.Approval,
			"autostart":          autostart.Enabled(),
			"openConsoleOnStart": c.OpenConsoleOnStart,
			"codexModel":         c.CodexModel,
			"claudeModel":        c.ClaudeModel,
			"codexAuthMode":      c.CodexAuthMode,
			"accountKey":         mask(c.AccountKey),
			"codexKey":           mask(c.CodexKey),
			"claudeKey":          mask(c.ClaudeKey),
			"loggedIn":           c.LoggedIn(),
			"projects":           c.Projects,
			"configPath":         s.d.Store.Path(),
		},
		"hub":     hub,
		"tools":   s.tools(ctx),
		"desktop": toolcfg.DetectClaudeDesktop(),
	})
}

func (s *Server) usage(ctx context.Context, force bool) (map[string]any, string) {
	c := s.d.Store.Get()
	s.usageMu.Lock()
	defer s.usageMu.Unlock()
	key := c.RelayRoot + "|" + c.AccountKey
	if !force && key == s.usageKey && time.Since(s.usageAt) < 30*time.Second {
		return s.usageData, s.usageErr
	}
	data, err := relay.Usage(ctx, c.RelayRoot, c.AccountKey)
	s.usageKey, s.usageAt, s.usageData, s.usageErr = key, time.Now(), data, ""
	if err != nil {
		s.usageErr = err.Error()
	}
	return s.usageData, s.usageErr
}

func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	if !s.d.Store.Get().LoggedIn() {
		writeJSON(w, map[string]any{"error": "未登录"})
		return
	}
	ctx, cancel := ctxTimeout(r, 20*time.Second)
	defer cancel()
	data, errText := s.usage(ctx, r.URL.Query().Get("refresh") == "1")
	writeJSON(w, map[string]any{"usage": data, "error": errText})
}

func (s *Server) handleTest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RelayRoot string `json:"relayRoot"`
		Key       string `json:"key"`
		Which     string `json:"which"` // when key is empty: account | codex | claude (use the saved key)
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c := s.d.Store.Get()
	root := config.NormalizeRelayRoot(in.RelayRoot)
	if root == "" {
		root = c.RelayRoot
	}
	key := strings.TrimSpace(in.Key)
	if key == "" {
		switch in.Which {
		case "codex":
			key = c.EffectiveCodexKey()
		case "claude":
			key = c.EffectiveClaudeKey()
		default:
			key = c.AccountKey
		}
	}
	ctx, cancel := ctxTimeout(r, 20*time.Second)
	defer cancel()
	u, err := relay.Usage(ctx, root, key)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "usage": u})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RelayRoot  string  `json:"relayRoot"`
		AccountKey string  `json:"accountKey"`
		HubURL     *string `json:"hubUrl"`
		CodexKey   *string `json:"codexKey"`
		ClaudeKey  *string `json:"claudeKey"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	cur := s.d.Store.Get()
	root := config.NormalizeRelayRoot(in.RelayRoot)
	key := strings.TrimSpace(in.AccountKey)
	if key == "" {
		key = cur.AccountKey
	}
	if root == "" || key == "" {
		writeErr(w, 400, "请填写中转站地址和 API Key")
		return
	}
	ctx, cancel := ctxTimeout(r, 20*time.Second)
	defer cancel()
	u, err := relay.Usage(ctx, root, key)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	enableAutostart := false
	err = s.d.Store.Update(func(c *config.Config) error {
		c.RelayRoot, c.AccountKey = root, key
		if in.HubURL != nil {
			c.HubURL = strings.TrimRight(strings.TrimSpace(*in.HubURL), "/")
		}
		if in.CodexKey != nil {
			c.CodexKey = strings.TrimSpace(*in.CodexKey)
		}
		if in.ClaudeKey != nil {
			c.ClaudeKey = strings.TrimSpace(*in.ClaudeKey)
		}
		if !c.AutostartDecided {
			c.AutostartDecided, c.Autostart = true, true
			enableAutostart = true
		}
		return nil
	})
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if enableAutostart && s.d.Exe != "" {
		if err := autostart.Enable(s.d.Exe); err != nil {
			s.log.Printf("autostart: %v", err)
		}
	}
	s.usageMu.Lock()
	s.usageAt = time.Time{}
	s.usageMu.Unlock()
	if s.d.Hub != nil {
		s.d.Hub.Kick()
	}
	writeJSON(w, map[string]any{"ok": true, "usage": u, "autostartEnabled": enableAutostart})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	_ = s.d.Store.Update(func(c *config.Config) error { c.AccountKey = ""; return nil })
	if s.d.Hub != nil {
		s.d.Hub.Kick()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleSecret(w http.ResponseWriter, r *http.Request) {
	c := s.d.Store.Get()
	v := ""
	switch r.URL.Query().Get("which") {
	case "account":
		v = c.AccountKey
	case "codex":
		v = c.EffectiveCodexKey()
	case "claude":
		v = c.EffectiveClaudeKey()
	default:
		writeErr(w, 400, "未知的 Key")
		return
	}
	writeJSON(w, map[string]string{"value": v})
}

func (s *Server) handleDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len([]rune(name)) > 40 {
		writeErr(w, 400, "设备名称需要 1–40 个字")
		return
	}
	if err := s.d.Store.Update(func(c *config.Config) error { c.DeviceName = name; return nil }); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if s.d.Hub != nil {
		s.d.Hub.Reregister()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- tool configuration ----

func (s *Server) handleToolcfg(w http.ResponseWriter, r *http.Request) {
	c := s.d.Store.Get()
	writeJSON(w, map[string]any{
		"relayRoot":        c.RelayRoot,
		"os":               runtime.GOOS,
		"codexAuthMode":    c.CodexAuthMode,
		"claude":           toolcfg.ClaudeStatusFor(toolcfg.ClaudeSettingsPath(), c.RelayRoot, c.EffectiveClaudeKey()),
		"codex":            toolcfg.CodexStatusFor(toolcfg.CodexConfigPath(), codexBase(c), c.EffectiveCodexKey()),
		"desktop":          toolcfg.DetectClaudeDesktop(),
		"desktopConfigDir": toolcfg.ClaudeDesktopConfigDir(),
		"envKeyName":       toolcfg.CodexEnvKey,
	})
}

func codexBase(c config.Config) string {
	if c.RelayRoot == "" {
		return ""
	}
	return c.RelayRoot + "/v1"
}

func (s *Server) handleToolcfgAction(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Tool   string `json:"tool"`
		Action string `json:"action"`
		Mode   string `json:"mode"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c := s.d.Store.Get()
	if in.Action == "apply" && !c.LoggedIn() {
		writeErr(w, 400, "请先在「登录 / 中转站」里填写中转站地址和 Key")
		return
	}
	var err error
	note := ""
	switch in.Tool + ":" + in.Action {
	case "claude:apply":
		err = toolcfg.ApplyClaude(toolcfg.ClaudeSettingsPath(), c.RelayRoot, c.EffectiveClaudeKey())
		note = "已写入 ~/.claude/settings.json，新开的 Claude Code 会话会走中转站。"
	case "claude:restore":
		err = toolcfg.RestoreClaude(toolcfg.ClaudeSettingsPath())
		note = "已恢复 Claude Code 原配置。"
	case "codex:apply":
		mode := in.Mode
		if mode != config.CodexAuthEnv {
			mode = config.CodexAuthToken
		}
		p := toolcfg.CodexParams{BaseURL: codexBase(c), Token: c.EffectiveCodexKey()}
		if mode == config.CodexAuthEnv {
			p.EnvKey = toolcfg.CodexEnvKey
			if runtime.GOOS == "windows" {
				if e := autostart.Command("setx", toolcfg.CodexEnvKey, c.EffectiveCodexKey()).Run(); e != nil {
					writeErr(w, 500, "设置环境变量失败："+e.Error())
					return
				}
				note = "已用 setx 设置用户环境变量 " + toolcfg.CodexEnvKey + "，重新打开终端 / VS Code 后生效。"
			} else if runtime.GOOS == "darwin" {
				note = "请在 ~/.zshrc 里加入 export " + toolcfg.CodexEnvKey + "=<你的 Key>，然后重新打开终端。注意：从程序坞 / 访达打开的 App（如 VS Code、Codex App）读不到 ~/.zshrc，这种情况请用“写入配置文件”方式。"
			} else {
				note = "请在 shell 配置（~/.zshrc 或 ~/.bashrc）里加入 export " + toolcfg.CodexEnvKey + "=<你的 Key>。"
			}
		}
		err = toolcfg.ApplyCodex(toolcfg.CodexConfigPath(), p)
		if err == nil {
			_ = s.d.Store.Update(func(cc *config.Config) error { cc.CodexAuthMode = mode; return nil })
			if note == "" {
				note = "已写入 ~/.codex/config.toml，新开的 Codex 会话会走中转站。"
			}
		}
	case "codex:restore":
		err = toolcfg.RestoreCodex(toolcfg.CodexConfigPath())
		note = "已恢复 Codex 原配置。"
	default:
		writeErr(w, 400, "未知操作")
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.log.Printf("toolcfg %s %s ok", in.Tool, in.Action)
	writeJSON(w, map[string]any{"ok": true, "note": note})
}

// ---- projects ----

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"projects": s.d.Store.Get().Projects})
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func (s *Server) handleProjectAdd(w http.ResponseWriter, r *http.Request) {
	var in protocol.Project
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	p := strings.TrimSpace(in.Path)
	p = strings.Trim(p, `"`)
	if p == "" || !filepath.IsAbs(p) {
		writeErr(w, 400, "请填写完整的文件夹路径（绝对路径）")
		return
	}
	p = filepath.Clean(p)
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		writeErr(w, 400, "文件夹不存在："+p)
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = config.ProjectName(p)
	}
	err = s.d.Store.Update(func(c *config.Config) error {
		for _, e := range c.Projects {
			if samePath(e.Path, p) {
				return errors.New("这个文件夹已经在列表里了")
			}
		}
		c.Projects = append(c.Projects, protocol.Project{Path: p, Name: name})
		return nil
	})
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if s.d.Hub != nil {
		s.d.Hub.Reregister()
	}
	writeJSON(w, map[string]any{"ok": true, "projects": s.d.Store.Get().Projects})
}

func (s *Server) handleProjectRemove(w http.ResponseWriter, r *http.Request) {
	var in protocol.Project
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	_ = s.d.Store.Update(func(c *config.Config) error {
		out := c.Projects[:0]
		for _, e := range c.Projects {
			if e.Path != in.Path {
				out = append(out, e)
			}
		}
		c.Projects = out
		return nil
	})
	if s.d.Hub != nil {
		s.d.Hub.Reregister()
	}
	writeJSON(w, map[string]any{"ok": true, "projects": s.d.Store.Get().Projects})
}

type dirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (s *Server) handleFS(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	showHidden := r.URL.Query().Get("hidden") == "1"
	var roots []dirEntry
	if runtime.GOOS == "windows" {
		for d := 'A'; d <= 'Z'; d++ {
			root := string(d) + `:\`
			if _, err := os.Stat(root); err == nil {
				roots = append(roots, dirEntry{Name: string(d) + ":", Path: root})
			}
		}
	} else {
		roots = []dirEntry{{Name: "/", Path: "/"}}
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		roots = append([]dirEntry{{Name: "主目录", Path: home}}, roots...)
	}
	if p == "" {
		p = home
	}
	if !filepath.IsAbs(p) {
		writeErr(w, 400, "需要绝对路径")
		return
	}
	p = filepath.Clean(p)
	entries, err := os.ReadDir(p)
	if err != nil {
		writeErr(w, 400, "无法打开："+p)
		return
	}
	dirs := []dirEntry{}
	for _, e := range entries {
		name := e.Name()
		if !showHidden && (strings.HasPrefix(name, ".") || name == "$RECYCLE.BIN" || name == "System Volume Information") {
			continue
		}
		isDir := e.IsDir()
		if !isDir && e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(p, name)); err == nil && st.IsDir() {
				isDir = true
			}
		}
		if isDir {
			dirs = append(dirs, dirEntry{Name: name, Path: filepath.Join(p, name)})
		}
		if len(dirs) >= 2000 {
			break
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name) })
	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}
	writeJSON(w, map[string]any{"path": p, "parent": parent, "dirs": dirs, "roots": roots, "sep": string(filepath.Separator)})
}

// ---- sessions & approvals ----

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	m := s.manager()
	if m == nil {
		writeJSON(w, map[string]any{"sessions": []any{}})
		return
	}
	ctx, cancel := ctxTimeout(r, 30*time.Second)
	defer cancel()
	res, err := hubclient.ListSessions(ctx, m, r.URL.Query().Get("tool"))
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) dispatch(r *http.Request, cmd map[string]any) (any, error) {
	if s.d.Hub == nil {
		return nil, errors.New("程序还在启动")
	}
	ctx, cancel := ctxTimeout(r, 45*time.Second)
	defer cancel()
	return s.d.Hub.Dispatch(ctx, cmd)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	res, err := s.dispatch(r, map[string]any{"type": "session.open", "sessionKey": r.URL.Query().Get("key")})
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) handleSessionCmd(typ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		if err := readJSON(r, &in); err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		in["type"] = typ
		res, err := s.dispatch(r, in)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, res)
	}
}

func (s *Server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	s.pendMu.Lock()
	list := make([]protocol.Event, 0, len(s.pending))
	for _, e := range s.pending {
		list = append(list, e)
	}
	s.pendMu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].TS < list[j].TS })
	writeJSON(w, map[string]any{"approvals": list})
}

func (s *Server) handleApproval(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ApprovalID string `json:"approvalId"`
		Decision   string `json:"decision"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.markDesktop(in.ApprovalID)
	_, err := s.dispatch(r, map[string]any{"type": "approval.respond", "approvalId": in.ApprovalID, "decision": in.Decision, "message": "由电脑端控制台处理"})
	if err != nil {
		s.byMu.Lock()
		delete(s.byDesktop, in.ApprovalID)
		s.byMu.Unlock()
		writeErr(w, 400, err.Error())
		return
	}
	s.log.Printf("approval %s → %s (desktop)", in.ApprovalID, in.Decision)
	// The agent emits approval.resolved itself; make sure the console list clears even if it doesn't.
	s.pendMu.Lock()
	delete(s.pending, in.ApprovalID)
	s.pendMu.Unlock()
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- settings, logs, quit ----

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Autostart          *bool   `json:"autostart"`
		Approval           *string `json:"approval"`
		OpenConsoleOnStart *bool   `json:"openConsoleOnStart"`
		CodexModel         *string `json:"codexModel"`
		ClaudeModel        *string `json:"claudeModel"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if in.Approval != nil && !config.ValidApproval(*in.Approval) {
		writeErr(w, 400, "无效的审批策略")
		return
	}
	if in.Autostart != nil {
		var err error
		if *in.Autostart {
			if s.d.Exe == "" {
				err = errors.New("找不到程序路径")
			} else {
				err = autostart.Enable(s.d.Exe)
			}
		} else {
			err = autostart.Disable()
		}
		if err != nil {
			writeErr(w, 500, "设置开机自启失败："+err.Error())
			return
		}
	}
	err := s.d.Store.Update(func(c *config.Config) error {
		if in.Autostart != nil {
			c.Autostart, c.AutostartDecided = *in.Autostart, true
		}
		if in.Approval != nil {
			c.Approval = *in.Approval
		}
		if in.OpenConsoleOnStart != nil {
			c.OpenConsoleOnStart = *in.OpenConsoleOnStart
		}
		if in.CodexModel != nil {
			c.CodexModel = strings.TrimSpace(*in.CodexModel)
		}
		if in.ClaudeModel != nil {
			c.ClaudeModel = strings.TrimSpace(*in.ClaudeModel)
		}
		return nil
	})
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	lines := []string{}
	if s.d.LogPath != "" {
		if l := applog.Tail(s.d.LogPath, 300); l != nil {
			lines = l
		}
	}
	writeJSON(w, map[string]any{"lines": lines, "path": s.d.LogPath})
}

func (s *Server) handleQuit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"ok": true})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	if s.d.Quit != nil {
		go func() {
			time.Sleep(300 * time.Millisecond)
			s.d.Quit()
		}()
	}
}

// handleReveal opens a known folder in Finder / Explorer / the file manager. Only fixed locations are
// accepted (never a path from the request), so a page can't make the bridge open arbitrary things.
func (s *Server) handleReveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Which string `json:"which"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var p string
	switch in.Which {
	case "config":
		p = s.d.Dir
	case "log":
		p = s.d.LogPath
	case "exe":
		p = s.d.Exe
		if b := macapp.BundleOf(p); b != "" {
			p = b
		}
	case "claude":
		p = toolcfg.ClaudeSettingsPath()
	case "codex":
		p = toolcfg.CodexConfigPath()
	default:
		writeErr(w, 400, "未知位置")
		return
	}
	if p == "" {
		writeErr(w, 400, "找不到这个位置")
		return
	}
	if _, err := os.Stat(p); err != nil {
		p = filepath.Dir(p) // e.g. settings.json not created yet: open its folder
		if _, err := os.Stat(p); err != nil {
			writeErr(w, 400, "文件夹不存在："+p)
			return
		}
	}
	if err := autostart.OpenPath(p); err != nil {
		writeErr(w, 500, "无法打开："+err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
