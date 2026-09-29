package agents

import (
	"encoding/json"
	"strconv"
	"strings"

	"salcara/bridge/internal/protocol"
)

// Wire shapes of `codex app-server` (v2), trimmed to what the bridge uses. Field names follow
// codex-rs/app-server-protocol/schema/typescript/v2.

type cxThread struct {
	ID             string          `json:"id"`
	Preview        string          `json:"preview"`
	Ephemeral      bool            `json:"ephemeral"`
	ModelProvider  string          `json:"modelProvider"`
	Model          *string         `json:"model"`
	CreatedAt      int64           `json:"createdAt"`
	UpdatedAt      int64           `json:"updatedAt"`
	Status         cxThreadStatus  `json:"status"`
	Path           *string         `json:"path"`
	Cwd            string          `json:"cwd"`
	Originator     *string         `json:"originator"`
	Source         json.RawMessage `json:"source"`
	ParentThreadID *string         `json:"parentThreadId"`
	Name           *string         `json:"name"`
	Turns          []cxTurn        `json:"turns"`
}

type cxThreadStatus struct {
	Type        string   `json:"type"`
	ActiveFlags []string `json:"activeFlags"`
}

type cxTurn struct {
	ID          string            `json:"id"`
	Items       []json.RawMessage `json:"items"`
	Status      string            `json:"status"`
	Error       *cxTurnError      `json:"error"`
	StartedAt   *int64            `json:"startedAt"`
	CompletedAt *int64            `json:"completedAt"`
}

type cxTurnError struct {
	Message           string  `json:"message"`
	AdditionalDetails *string `json:"additionalDetails"`
}

type cxAction struct {
	Type    string  `json:"type"`
	Command string  `json:"command"`
	Name    string  `json:"name"`
	Path    *string `json:"path"`
	Query   *string `json:"query"`
}

type cxChange struct {
	Path string `json:"path"`
	Kind struct {
		Type     string  `json:"type"`
		MovePath *string `json:"move_path"`
	} `json:"kind"`
	Diff string `json:"diff"`
}

type cxItem struct {
	Type string `json:"type"`
	ID   string `json:"id"`

	Content json.RawMessage `json:"content"` // userMessage: []UserInput; reasoning: []string
	Text    string          `json:"text"`
	Summary []string        `json:"summary"`

	Command          string     `json:"command"`
	Cwd              string     `json:"cwd"`
	Status           string     `json:"status"`
	CommandActions   []cxAction `json:"commandActions"`
	AggregatedOutput *string    `json:"aggregatedOutput"`
	ExitCode         *int       `json:"exitCode"`

	Changes []cxChange `json:"changes"`

	Server       string          `json:"server"`
	Tool         string          `json:"tool"`
	Arguments    json.RawMessage `json:"arguments"`
	Result       json.RawMessage `json:"result"`
	Error        json.RawMessage `json:"error"`
	ContentItems json.RawMessage `json:"contentItems"`
	Success      *bool           `json:"success"`
	Prompt       *string         `json:"prompt"`

	Query  string          `json:"query"`
	Action json.RawMessage `json:"action"`
	Path   string          `json:"path"`
	Review string          `json:"review"`
}

type cxUserInput struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Path string `json:"path"`
	URL  string `json:"url"`
	Name string `json:"name"`
}

// codexClient maps Thread.source / originator to SessionInfo.Client.
func codexClient(source json.RawMessage, originator string, owned bool) string {
	if owned {
		return "Codex"
	}
	var s string
	_ = json.Unmarshal(source, &s)
	o := strings.ToLower(originator)
	appLike := strings.Contains(o, "desktop") || strings.Contains(o, "codex_app") || strings.Contains(o, "codex app")
	switch s {
	case "cli", "exec":
		return "Codex CLI"
	case "vscode":
		if appLike {
			return "Codex App"
		}
		return "Codex IDE"
	case "appServer":
		return "Codex App"
	}
	if appLike {
		return "Codex App"
	}
	return "Codex"
}

func userInputText(raw json.RawMessage) string {
	var parts []cxUserInput
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var out []string
	for _, p := range parts {
		switch p.Type {
		case "text":
			out = append(out, p.Text)
		case "image", "localImage":
			out = append(out, "[图片]")
		case "mention", "skill":
			out = append(out, "@"+p.Name)
		}
	}
	return strings.Join(out, "\n")
}

func reasoningText(summary []string, content json.RawMessage) string {
	if len(summary) > 0 {
		return strings.TrimSpace(strings.Join(summary, "\n\n"))
	}
	var c []string
	_ = json.Unmarshal(content, &c)
	return strings.TrimSpace(strings.Join(c, "\n\n"))
}

func cxToolStatus(status string, exit *int) string {
	switch status {
	case "inProgress", "":
		return "running"
	case "completed":
		if exit != nil && *exit != 0 {
			return "failed"
		}
		return "done"
	default: // failed, declined
		return "failed"
	}
}

func codexChangesDiff(changes []cxChange) string {
	var sb strings.Builder
	for _, ch := range changes {
		mp := ""
		if ch.Kind.MovePath != nil {
			mp = *ch.Kind.MovePath
		}
		d := normalizeCodexDiff(ch.Path, ch.Kind.Type, mp, ch.Diff)
		sb.WriteString(d)
		if !strings.HasSuffix(d, "\n") {
			sb.WriteByte('\n')
		}
	}
	return truncHead(sb.String(), maxDiffChars)
}

func codexChangesTitle(changes []cxChange, cwd string) string {
	if len(changes) == 0 {
		return "修改文件"
	}
	if len(changes) == 1 {
		verb := "修改 "
		switch changes[0].Kind.Type {
		case "add":
			verb = "创建 "
		case "delete":
			verb = "删除 "
		}
		return titleText(verb + shortPath(changes[0].Path, cwd))
	}
	return titleText("修改 " + shortPath(changes[0].Path, cwd) + " 等 " + itoa(len(changes)) + " 个文件")
}

func itoa(n int) string { return strconv.Itoa(n) }

func codexCommandKindTitle(cmd string, actions []cxAction, cwd string) (string, string) {
	if len(actions) > 0 {
		allRead, allSearch, allList := true, true, true
		for _, a := range actions {
			allRead = allRead && a.Type == "read"
			allSearch = allSearch && a.Type == "search"
			allList = allList && a.Type == "listFiles"
		}
		switch {
		case allRead:
			names := make([]string, 0, len(actions))
			for _, a := range actions {
				n := a.Name
				if n == "" && a.Path != nil {
					n = shortPath(*a.Path, cwd)
				}
				names = append(names, n)
			}
			return "read", titleText("读取 " + strings.Join(names, ", "))
		case allSearch:
			q := ""
			if actions[0].Query != nil {
				q = *actions[0].Query
			}
			if q != "" {
				return "search", titleText("搜索 “" + q + "”")
			}
			return "search", titleText("搜索 " + cmd)
		case allList:
			p := ""
			if actions[0].Path != nil {
				p = shortPath(*actions[0].Path, cwd)
			}
			return "search", titleText("列出文件 " + p)
		}
	}
	return "command", titleText("运行 " + cmd)
}

func mcpResultText(result json.RawMessage) string {
	var r struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &r) != nil {
		return ""
	}
	var parts []string
	for _, c := range r.Content {
		if c.Type == "text" {
			parts = append(parts, c.Text)
		} else if c.Type != "" {
			parts = append(parts, "["+c.Type+"]")
		}
	}
	return strings.Join(parts, "\n")
}

// codexItemEvent converts one ThreadItem. ok=false means the item isn't shown on the phone.
// completed=true marks the final state (history items are always completed).
func codexItemEvent(sk string, it cxItem, completed bool, cwd string) (protocol.Event, bool) {
	e := protocol.Event{SessionKey: sk, Tool: "codex", TS: nowMs(), ID: it.ID}
	switch it.Type {
	case "userMessage":
		e.Type, e.Role, e.Text, e.Final = "message", "user", userInputText(it.Content), true
		return e, e.Text != ""
	case "agentMessage":
		e.Type, e.Role, e.Text, e.Final = "message", "assistant", it.Text, completed
		return e, e.Text != "" || completed
	case "reasoning":
		e.Type, e.Text, e.Final = "reasoning", reasoningText(it.Summary, it.Content), completed
		return e, e.Text != ""
	case "plan":
		e.Type, e.Kind, e.Title, e.Status = "tool", "other", "制定计划", "done"
		if !completed {
			e.Status = "running"
		}
		e.Output = truncHead(it.Text, maxOutputChars)
		return e, true
	case "commandExecution":
		e.Type = "tool"
		e.Kind, e.Title = codexCommandKindTitle(it.Command, it.CommandActions, it.Cwd)
		e.Detail = truncHead(it.Command, maxDetailChars)
		e.Cwd = it.Cwd
		e.Status = cxToolStatus(it.Status, it.ExitCode)
		if it.AggregatedOutput != nil {
			e.Output = truncTail(*it.AggregatedOutput, maxOutputChars)
		}
		e.ExitCode = it.ExitCode
		if it.Status == "declined" {
			e.Output = "已拒绝"
		}
		return e, true
	case "fileChange":
		e.Type, e.Kind = "tool", "file_change"
		e.Title = codexChangesTitle(it.Changes, cwd)
		paths := make([]string, 0, len(it.Changes))
		for _, c := range it.Changes {
			paths = append(paths, c.Path)
		}
		e.Detail = truncHead(strings.Join(paths, "\n"), maxDetailChars)
		e.Diff = codexChangesDiff(it.Changes)
		e.Status = cxToolStatus(it.Status, nil)
		if it.Status == "declined" {
			e.Output = "已拒绝"
		}
		return e, true
	case "mcpToolCall":
		e.Type, e.Kind = "tool", "mcp"
		e.Title = titleText("调用 " + it.Server + "." + it.Tool)
		e.Detail = truncHead(jsonCompact(it.Arguments), maxDetailChars)
		e.Status = cxToolStatus(it.Status, nil)
		if len(it.Error) > 0 && string(it.Error) != "null" {
			var me struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(it.Error, &me)
			e.Output = truncTail(me.Message, maxOutputChars)
			if completed {
				e.Status = "failed"
			}
		} else {
			e.Output = truncTail(mcpResultText(it.Result), maxOutputChars)
		}
		return e, true
	case "dynamicToolCall":
		e.Type, e.Kind = "tool", "other"
		e.Title = titleText("调用 " + it.Tool)
		e.Detail = truncHead(jsonCompact(it.Arguments), maxDetailChars)
		e.Status = cxToolStatus(it.Status, nil)
		if it.Success != nil && !*it.Success && completed {
			e.Status = "failed"
		}
		return e, true
	case "collabAgentToolCall":
		e.Type, e.Kind = "tool", "other"
		e.Title = titleText("子代理 " + it.Tool)
		if it.Prompt != nil {
			e.Detail = truncHead(*it.Prompt, maxDetailChars)
		}
		e.Status = cxToolStatus(it.Status, nil)
		return e, true
	case "webSearch":
		e.Type, e.Kind = "tool", "web"
		e.Title = titleText("搜索网页 “" + it.Query + "”")
		var act struct {
			Type    string `json:"type"`
			URL     string `json:"url"`
			Pattern string `json:"pattern"`
		}
		if json.Unmarshal(it.Action, &act) == nil {
			switch act.Type {
			case "openPage":
				if act.URL != "" {
					e.Title = titleText("打开网页 " + act.URL)
				}
			case "findInPage":
				e.Title = titleText("在网页中查找 “" + act.Pattern + "”")
			}
		}
		if it.Query == "" && e.Title == "搜索网页 “”" {
			e.Title = "搜索网页"
		}
		e.Status = "done"
		if !completed {
			e.Status = "running"
		}
		return e, true
	case "imageView":
		e.Type, e.Kind, e.Title, e.Status = "tool", "read", titleText("查看图片 "+shortPath(it.Path, cwd)), "done"
		return e, true
	case "enteredReviewMode":
		e.Type, e.Level, e.Text, e.ID = "notice", "info", "开始代码审查", ""
		return e, true
	case "exitedReviewMode":
		e.Type, e.Role, e.Text, e.Final = "message", "assistant", it.Review, true
		return e, it.Review != ""
	case "contextCompaction":
		e.Type, e.Level, e.Text, e.ID = "notice", "info", "上下文已压缩", ""
		return e, completed
	}
	return e, false
}

func codexTurnStatus(s string) string {
	switch s {
	case "completed":
		return "completed"
	case "interrupted":
		return "interrupted"
	case "failed":
		return "failed"
	}
	return "started"
}

// codexHistory converts thread/read turns to events, oldest first.
func codexHistory(sk string, th cxThread) []protocol.Event {
	var evs []protocol.Event
	for _, t := range th.Turns {
		ts := int64(0)
		if t.StartedAt != nil {
			ts = *t.StartedAt * 1000
		} else {
			ts = th.UpdatedAt * 1000
		}
		for _, raw := range t.Items {
			var it cxItem
			if json.Unmarshal(raw, &it) != nil {
				continue
			}
			if e, ok := codexItemEvent(sk, it, true, th.Cwd); ok {
				e.TS = ts
				evs = append(evs, e)
			}
		}
		if t.Status == "failed" || t.Status == "interrupted" {
			e := protocol.Event{SessionKey: sk, Tool: "codex", TS: ts, Type: "turn", Status: codexTurnStatus(t.Status)}
			if t.Error != nil {
				e.Error = t.Error.Message
			}
			evs = append(evs, e)
		}
	}
	return evs
}
