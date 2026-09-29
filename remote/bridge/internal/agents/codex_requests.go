package agents

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"salcara/bridge/internal/protocol"
)

type cxApprovalParams struct {
	ThreadID       string          `json:"threadId"`
	TurnID         string          `json:"turnId"`
	ItemID         string          `json:"itemId"`
	Reason         *string         `json:"reason"`
	Command        *string         `json:"command"`
	Cwd            *string         `json:"cwd"`
	CommandActions []cxAction      `json:"commandActions"`
	Kind           string          `json:"kind"`
	GrantRoot      *string         `json:"grantRoot"`
	Permissions    json.RawMessage `json:"permissions"`
	Questions      []struct {
		Question string `json:"question"`
		Header   string `json:"header"`
	} `json:"questions"`
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// onRequest answers server→client requests. It runs on its own goroutine.
func (a *codexAgent) onRequest(c *rpcConn, id json.RawMessage, method string, params json.RawMessage) {
	var p cxApprovalParams
	_ = json.Unmarshal(params, &p)
	sk := "codex:" + p.ThreadID

	a.mu.Lock()
	t := a.threadLocked(p.ThreadID)
	policy := t.policy
	if policy == "" {
		policy = normalizePolicy(a.settings().Approval)
	}
	cwd := t.info.Cwd
	var changes []cxChange
	if l := t.items[p.ItemID]; l != nil {
		changes = l.changes
	}
	a.mu.Unlock()

	switch method {
	case "item/commandExecution/requestApproval":
		if policy == "auto_all" {
			_ = c.Reply(id, map[string]any{"decision": "accept"})
			return
		}
		cmd := deref(p.Command)
		title := "运行 " + cmd
		if p.Kind == "writeStdin" {
			title = "向命令输入 " + cmd
		}
		if cmd == "" {
			title = "运行命令"
		}
		ev := protocol.Event{Kind: "command", Title: titleText(title), Detail: truncHead(strings.TrimSpace(cmd+"\n\n"+deref(p.Reason)), maxDetailChars), Cwd: deref(p.Cwd)}
		ans, ok := a.askPhone(sk, string(id), ev)
		if !ok {
			return
		}
		decision := "decline"
		switch ans.decision {
		case "allow":
			decision = "accept"
		case "allow_session":
			decision = "acceptForSession"
		}
		_ = c.Reply(id, map[string]any{"decision": decision})

	case "item/fileChange/requestApproval":
		if policy == "auto_all" || policy == "auto_edits" {
			_ = c.Reply(id, map[string]any{"decision": "accept"})
			return
		}
		ev := protocol.Event{Kind: "file_change", Title: codexChangesTitle(changes, cwd), Diff: codexChangesDiff(changes), Cwd: cwd}
		detail := deref(p.Reason)
		if p.GrantRoot != nil {
			detail = strings.TrimSpace(detail + "\n申请写入：" + *p.GrantRoot)
		}
		ev.Detail = truncHead(detail, maxDetailChars)
		ans, ok := a.askPhone(sk, string(id), ev)
		if !ok {
			return
		}
		decision := "decline"
		switch ans.decision {
		case "allow":
			decision = "accept"
		case "allow_session":
			decision = "acceptForSession"
		}
		_ = c.Reply(id, map[string]any{"decision": decision})

	case "item/permissions/requestApproval":
		granted := grantedPermissions(p.Permissions)
		if policy == "auto_all" {
			_ = c.Reply(id, map[string]any{"permissions": granted, "scope": "turn"})
			return
		}
		ev := protocol.Event{Kind: "permission", Title: "申请额外权限", Cwd: deref(p.Cwd),
			Detail: truncHead(strings.TrimSpace(deref(p.Reason)+"\n"+jsonCompact(p.Permissions)), maxDetailChars)}
		ans, ok := a.askPhone(sk, string(id), ev)
		if !ok {
			return
		}
		switch ans.decision {
		case "allow":
			_ = c.Reply(id, map[string]any{"permissions": granted, "scope": "turn"})
		case "allow_session":
			_ = c.Reply(id, map[string]any{"permissions": granted, "scope": "session"})
		default:
			_ = c.Reply(id, map[string]any{"permissions": map[string]any{}, "scope": "turn"})
		}

	case "item/tool/requestUserInput":
		var qs []string
		for _, q := range p.Questions {
			qs = append(qs, q.Question)
		}
		a.emit(protocol.Event{SessionKey: sk, Type: "notice", Level: "info",
			Text: truncHead("Codex 提出了问题（手机端暂不支持回答，已跳过）："+strings.Join(qs, "；"), 1000)})
		_ = c.Reply(id, map[string]any{"answers": map[string]any{}})

	case "mcpServer/elicitation/request":
		_ = c.Reply(id, map[string]any{"action": "decline", "content": nil, "_meta": nil})

	case "execCommandApproval", "applyPatchApproval": // legacy v1 API, not used by v2 threads
		_ = c.Reply(id, map[string]any{"decision": "denied"})

	default:
		_ = c.ReplyError(id, -32601, "not supported by Salcara bridge: "+method)
	}
}

// grantedPermissions echoes the requested permission profile without null fields.
func grantedPermissions(raw json.RawMessage) map[string]any {
	var req map[string]any
	_ = json.Unmarshal(raw, &req)
	out := map[string]any{}
	for k, v := range req {
		if v != nil {
			out[k] = v
		}
	}
	return out
}

// askPhone raises approval.request and waits. ok=false means the tool withdrew the request (no reply).
func (a *codexAgent) askPhone(sk, ref string, ev protocol.Event) (approvalAnswer, bool) {
	p := a.aps.add(sk, "codex")
	p.ref = ref
	ev.SessionKey, ev.Type, ev.ApprovalID = sk, "approval.request", p.id
	a.emit(ev)
	a.setStatus(sk, "waiting_approval")
	ans := a.aps.wait(p, a.closeCh)
	a.emit(protocol.Event{SessionKey: sk, Type: "approval.resolved", ApprovalID: p.id, Decision: ans.decision, By: ans.by})
	if a.aps.countFor(sk) == 0 {
		a.setStatus(sk, "running")
	}
	return ans, !ans.noReply
}

func (a *codexAgent) setStatus(sk, status string) {
	id := strings.TrimPrefix(sk, "codex:")
	a.mu.Lock()
	t := a.threadLocked(id)
	if status == "running" && t.turnID == "" {
		status = "idle"
	}
	if t.info.Status == status {
		a.mu.Unlock()
		return
	}
	t.info.Status = status
	t.info.UpdatedAt = nowMs()
	info := t.info
	a.mu.Unlock()
	a.emit(protocol.Event{SessionKey: sk, Type: "session.updated", Session: ptrInfo(info)})
}

// watch polls thread/list so threads run by the Codex CLI / IDE / app show up and update on the phone.
// For external threads the phone has opened, new history items are streamed as events.
func (a *codexAgent) watch(ctx context.Context, interval time.Duration) {
	prev := map[string]protocol.SessionInfo{}
	first := true
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		if _, ok := a.exe(); ok {
			a.pollOnce(ctx, prev, first)
			first = false
		}
		select {
		case <-ctx.Done():
			return
		case <-a.closeCh:
			return
		case <-tick.C:
		}
	}
}

func (a *codexAgent) pollOnce(ctx context.Context, prev map[string]protocol.SessionInfo, first bool) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	list, err := a.Sessions(cctx)
	if err != nil {
		return
	}
	for _, info := range list {
		old, known := prev[info.SessionKey]
		prev[info.SessionKey] = info
		if first {
			continue
		}
		id := strings.TrimPrefix(info.SessionKey, "codex:")
		a.mu.Lock()
		t := a.threads[id]
		loaded, opened := false, false
		if t != nil {
			loaded, opened = t.loaded, t.opened
		}
		a.mu.Unlock()
		changed := !known || old.UpdatedAt != info.UpdatedAt || old.Status != info.Status ||
			old.Title != info.Title || old.Controllable != info.Controllable
		if !changed {
			continue
		}
		if !loaded {
			// Live events for loaded threads come straight from the app-server.
			a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})
			if opened && known && old.UpdatedAt != info.UpdatedAt {
				a.streamNewItems(cctx, id)
			}
		}
	}
}

func (a *codexAgent) streamNewItems(ctx context.Context, id string) {
	th, err := a.readThread(ctx, id)
	if err != nil {
		return
	}
	sk := "codex:" + id
	var out []protocol.Event
	a.mu.Lock()
	t := a.threadLocked(id)
	if t.seen == nil {
		t.seen = map[string]bool{}
	}
	for _, turn := range th.Turns {
		for i, raw := range turn.Items {
			key := turn.ID + ":" + itoa(i)
			if t.seen[key] {
				continue
			}
			t.seen[key] = true
			var it cxItem
			if json.Unmarshal(raw, &it) != nil {
				continue
			}
			if e, ok := codexItemEvent(sk, it, true, th.Cwd); ok {
				out = append(out, e)
			}
		}
	}
	a.mu.Unlock()
	for _, e := range out {
		a.emit(e)
	}
}
