package agents

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"salcara/bridge/internal/protocol"
)

// PermissionPath is where the `mcp-approval` helper asks the bridge for a Claude permission decision.
const PermissionPath = "/internal/agents/claude/permission"

// PermissionRequest is the helper → bridge body.
type PermissionRequest struct {
	Session   string          `json:"session"`
	ToolName  string          `json:"tool_name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
}

// PermissionDecision is what Claude Code expects back from a --permission-prompt-tool.
type PermissionDecision struct {
	Behavior     string          `json:"behavior"` // allow | deny
	UpdatedInput json.RawMessage `json:"updatedInput,omitempty"`
	Message      string          `json:"message,omitempty"`
}

func allowDecision(input json.RawMessage) PermissionDecision {
	if len(input) == 0 || string(input) == "null" {
		input = json.RawMessage("{}")
	}
	return PermissionDecision{Behavior: "allow", UpdatedInput: input}
}

func (a *claudeAgent) permissionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := a.settings().LocalToken
	got := r.Header.Get("X-Salcara-Token")
	if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req PermissionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil || req.Session == "" || req.ToolName == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	dec := a.decide(r, req)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(dec)
}

func (a *claudeAgent) decide(r *http.Request, req PermissionRequest) PermissionDecision {
	id := req.Session
	sk := "claude:" + id
	a.mu.Lock()
	policy := a.policies[id]
	if policy == "" {
		policy = normalizePolicy(a.settings().Approval)
	}
	cwd := ""
	if p := a.procs[id]; p != nil {
		cwd = p.cwd
	} else if info, ok := a.live[id]; ok {
		cwd = info.Cwd
	}
	sessionAllowed := a.allowed[id][req.ToolName]
	a.mu.Unlock()

	if policy == "auto_all" || sessionAllowed || (policy == "auto_edits" && claudeEditTools[req.ToolName]) {
		return allowDecision(req.Input)
	}

	var input map[string]any
	_ = json.Unmarshal(req.Input, &input)
	d := describeClaudeTool(req.ToolName, input, cwd, true)
	p := a.aps.add(sk, "claude")
	a.emit(protocol.Event{SessionKey: sk, Type: "approval.request", ApprovalID: p.id, Kind: claudeApprovalKind(d.kind),
		Title: d.title, Detail: d.detail, Diff: d.diff, Cwd: cwd})
	a.setApprovalStatus(id)

	stop := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		select {
		case <-r.Context().Done(): // the helper (or Claude Code) went away
		case <-a.closeCh:
		case <-finished:
			return
		}
		close(stop)
	}()
	ans := a.aps.wait(p, stop)
	close(finished)
	if ans.by == "" {
		ans.by = "desktop"
	}
	a.emit(protocol.Event{SessionKey: sk, Type: "approval.resolved", ApprovalID: p.id, Decision: ans.decision, By: ans.by})
	a.setApprovalStatus(id)

	switch ans.decision {
	case "allow_session":
		a.mu.Lock()
		if a.allowed[id] == nil {
			a.allowed[id] = map[string]bool{}
		}
		a.allowed[id][req.ToolName] = true
		a.mu.Unlock()
		return allowDecision(req.Input)
	case "allow":
		return allowDecision(req.Input)
	}
	msg := strings.TrimSpace(ans.message)
	if msg == "" {
		msg = "用户在手机上拒绝了这个操作"
	}
	return PermissionDecision{Behavior: "deny", Message: msg}
}

// setApprovalStatus re-derives running / waiting_approval for a bridge-run session and emits it.
func (a *claudeAgent) setApprovalStatus(id string) {
	a.mu.Lock()
	p := a.procs[id]
	a.mu.Unlock()
	if p == nil {
		return
	}
	waiting := a.aps.countFor("claude:"+id) > 0
	a.setLive(id, func(i *protocol.SessionInfo) {
		if waiting {
			i.Status = "waiting_approval"
		} else {
			i.Status = "running"
		}
	})
}
