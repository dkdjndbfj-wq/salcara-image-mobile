// Package mcpapproval is the tiny stdio MCP server Claude Code launches as its --permission-prompt-tool
// (`<bridge> mcp-approval --port N --token T --session S`). Each `approve` call is forwarded to the
// running bridge on 127.0.0.1, which asks the phone and answers.
package mcpapproval

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

// Timeout for one decision (the bridge itself gives up after 10 minutes).
const decisionTimeout = 11 * time.Minute

const defaultProtocolVersion = "2025-06-18"

type message struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Run serves MCP on stdin/stdout until stdin closes.
func Run(port int, token, session string) error {
	return Serve(os.Stdin, os.Stdout, fmt.Sprintf("http://127.0.0.1:%d/internal/agents/claude/permission", port), token, session)
}

// Serve is Run with explicit streams and endpoint (used by tests).
func Serve(in io.Reader, out io.Writer, endpoint, token, session string) error {
	var wmu sync.Mutex
	write := func(v any) {
		b, err := json.Marshal(v)
		if err != nil {
			return
		}
		wmu.Lock()
		defer wmu.Unlock()
		_, _ = out.Write(append(b, '\n'))
	}
	reply := func(id json.RawMessage, result any) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	replyErr := func(id json.RawMessage, code int, msg string) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}})
	}
	client := &http.Client{Timeout: decisionTimeout}
	var wg sync.WaitGroup
	br := bufio.NewReaderSize(in, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var m message
			if json.Unmarshal(line, &m) == nil {
				hasID := len(m.ID) > 0 && string(m.ID) != "null"
				switch m.Method {
				case "initialize":
					var p struct {
						ProtocolVersion string `json:"protocolVersion"`
					}
					_ = json.Unmarshal(m.Params, &p)
					if p.ProtocolVersion == "" {
						p.ProtocolVersion = defaultProtocolVersion
					}
					reply(m.ID, map[string]any{
						"protocolVersion": p.ProtocolVersion,
						"capabilities":    map[string]any{"tools": map[string]any{}},
						"serverInfo":      map[string]any{"name": "salcara", "version": "1.0.0"},
					})
				case "ping":
					reply(m.ID, map[string]any{})
				case "tools/list":
					reply(m.ID, map[string]any{"tools": []any{toolDef()}})
				case "tools/call":
					wg.Add(1)
					go func(m message) {
						defer wg.Done()
						reply(m.ID, callApprove(client, endpoint, token, session, m.Params))
					}(m)
				default:
					if hasID {
						replyErr(m.ID, -32601, "method not found: "+m.Method)
					}
					// notifications (notifications/initialized, cancelled, …) need no answer
				}
			}
		}
		if err != nil {
			wg.Wait()
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func toolDef() map[string]any {
	return map[string]any{
		"name":        "approve",
		"description": "Ask the Salcara phone app whether Claude Code may use a tool.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tool_name":   map[string]any{"type": "string"},
				"input":       map[string]any{"type": "object"},
				"tool_use_id": map[string]any{"type": "string"},
			},
			"required": []string{"tool_name", "input"},
		},
	}
}

func textResult(v any) map[string]any {
	b, _ := json.Marshal(v)
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": string(b)}}}
}

func deny(msg string) map[string]any {
	return textResult(map[string]any{"behavior": "deny", "message": msg})
}

func callApprove(client *http.Client, endpoint, token, session string, params json.RawMessage) map[string]any {
	var p struct {
		Name      string `json:"name"`
		Arguments struct {
			ToolName  string          `json:"tool_name"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
		} `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Name != "approve" {
		return deny("未知的审批请求")
	}
	input := p.Arguments.Input
	if len(input) == 0 || string(input) == "null" {
		input = json.RawMessage("{}")
	}
	body, _ := json.Marshal(map[string]any{"session": session, "tool_name": p.Arguments.ToolName,
		"input": input, "tool_use_id": p.Arguments.ToolUseID})
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return deny("无法联系 Salcara 桥接程序")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Salcara-Token", token)
	resp, err := client.Do(req)
	if err != nil {
		return deny("无法联系 Salcara 桥接程序：" + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode != http.StatusOK {
		return deny(fmt.Sprintf("Salcara 桥接程序拒绝了请求（HTTP %d）", resp.StatusCode))
	}
	var dec struct {
		Behavior     string          `json:"behavior"`
		UpdatedInput json.RawMessage `json:"updatedInput"`
		Message      string          `json:"message"`
	}
	if json.Unmarshal(raw, &dec) != nil {
		return deny("Salcara 桥接程序返回了无效的结果")
	}
	if dec.Behavior == "allow" {
		upd := dec.UpdatedInput
		if len(upd) == 0 || string(upd) == "null" {
			upd = input
		}
		return textResult(map[string]any{"behavior": "allow", "updatedInput": upd})
	}
	if dec.Message == "" {
		dec.Message = "用户拒绝了这个操作"
	}
	return deny(dec.Message)
}
