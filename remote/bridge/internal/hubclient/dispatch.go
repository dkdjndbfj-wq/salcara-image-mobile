package hubclient

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"salcara/bridge/internal/agents"
	"salcara/bridge/internal/config"
	"salcara/bridge/internal/protocol"
)

const (
	maxSessions   = 100
	maxOpenEvents = 400
)

// Dispatch executes one Command (PROTOCOL.md §3) and returns its result. The local console uses it too.
func (c *Client) Dispatch(ctx context.Context, cmd map[string]any) (any, error) {
	typ := str(cmd, "type")
	m := c.manager()
	if m == nil && typ != "projects.list" {
		return nil, errors.New("程序还在启动，请稍后再试")
	}
	cfg := c.o.Store.Get()
	switch typ {
	case "sessions.list":
		return ListSessions(ctx, m, str(cmd, "tool"))

	case "session.open":
		a, id, err := agentFor(m, str(cmd, "sessionKey"))
		if err != nil {
			return nil, err
		}
		info, events, err := a.Open(ctx, id)
		if err != nil {
			return nil, err
		}
		if len(events) > maxOpenEvents {
			events = events[len(events)-maxOpenEvents:]
		}
		if events == nil {
			events = []protocol.Event{}
		}
		return map[string]any{"session": info, "events": events}, nil

	case "session.start":
		tool := str(cmd, "tool")
		a := m.Get(tool)
		if a == nil {
			return nil, fmt.Errorf("不支持的工具：%s", tool)
		}
		prompt := strings.TrimSpace(str(cmd, "prompt"))
		if prompt == "" {
			return nil, errors.New("请输入任务内容")
		}
		cwd, err := CheckCwd(str(cmd, "cwd"), cfg.Projects)
		if err != nil {
			return nil, err
		}
		approval := str(cmd, "approval")
		if !config.ValidApproval(approval) {
			approval = cfg.Approval
		}
		model := str(cmd, "model")
		if model == "" {
			if a.ID() == "codex" {
				model = cfg.CodexModel
			} else {
				model = cfg.ClaudeModel
			}
		}
		id, err := a.Start(ctx, cwd, prompt, model, approval)
		if err != nil {
			return nil, err
		}
		return map[string]any{"sessionKey": a.ID() + ":" + id}, nil

	case "session.send":
		a, id, err := agentFor(m, str(cmd, "sessionKey"))
		if err != nil {
			return nil, err
		}
		text := strings.TrimSpace(str(cmd, "text"))
		if text == "" {
			return nil, errors.New("请输入内容")
		}
		if err := a.Send(ctx, id, text); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "session.interrupt":
		a, id, err := agentFor(m, str(cmd, "sessionKey"))
		if err != nil {
			return nil, err
		}
		if err := a.Interrupt(ctx, id); err != nil {
			return nil, err
		}
		return map[string]any{}, nil

	case "approval.respond":
		aid, decision := str(cmd, "approvalId"), str(cmd, "decision")
		if decision != "allow" && decision != "allow_session" && decision != "deny" {
			return nil, errors.New("无效的审批结果")
		}
		for _, a := range m.Agents() {
			if a.Respond(aid, decision, str(cmd, "message")) {
				return map[string]any{}, nil
			}
		}
		return nil, errors.New("这个审批已经处理过或已过期")

	case "projects.list":
		p := cfg.Projects
		if p == nil {
			p = []protocol.Project{}
		}
		return map[string]any{"projects": p}, nil

	case "models.list":
		models := []string{}
		if a := m.Get(str(cmd, "tool")); a != nil {
			if ms := a.Models(ctx); ms != nil {
				models = ms
			}
		}
		return map[string]any{"models": models}, nil
	}
	return nil, fmt.Errorf("不支持的命令：%s", typ)
}

// ListSessions merges every agent's sessions, newest first, at most 100.
func ListSessions(ctx context.Context, m agents.Manager, tool string) (map[string]any, error) {
	var all []protocol.SessionInfo
	var errs []string
	agentsList := m.Agents()
	for _, a := range agentsList {
		if tool != "" && a.ID() != tool {
			continue
		}
		ss, err := a.Sessions(ctx)
		if err != nil {
			errs = append(errs, a.Name()+"："+err.Error())
			continue
		}
		for _, s := range ss {
			if s.SessionKey == "" {
				continue
			}
			all = append(all, s)
		}
	}
	if len(all) == 0 && len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "；"))
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].UpdatedAt > all[j].UpdatedAt })
	if len(all) > maxSessions {
		all = all[:maxSessions]
	}
	if all == nil {
		all = []protocol.SessionInfo{}
	}
	return map[string]any{"sessions": all}, nil
}

func agentFor(m agents.Manager, key string) (agents.Agent, string, error) {
	tool, id, ok := strings.Cut(key, ":")
	if !ok || id == "" {
		return nil, "", errors.New("无效的会话")
	}
	a := m.Get(tool)
	if a == nil {
		return nil, "", fmt.Errorf("不支持的工具：%s", tool)
	}
	return a, id, nil
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}
