// Package testfake contains fake `codex app-server` and `claude -p --input-format stream-json` programs that
// speak the same protocols as the real CLIs, for the agents unit tests and the end-to-end test. Nothing in
// the shipped bridge imports it.
//
// Behaviour (both tools):
//   - `--version` prints "9.9.9 (fake)".
//   - codex app-server: answers initialize / thread/list / thread/read / thread/start / thread/resume /
//     turn/start / turn/interrupt / model/list; a turn streams agentMessage deltas, then asks
//     item/commandExecution/requestApproval ("npm test") and item/fileChange/requestApproval, then
//     completes. A prompt containing "slow" waits for turn/interrupt.
//   - claude: emits system/init, stream_event text deltas ("Hi there"), a Bash tool_use whose permission is
//     asked through the MCP server named "salcara" from --mcp-config (the bridge's mcp-approval helper),
//     the tool_result and a result with usage. A prompt containing "edit" also asks for an Edit; "sleep"
//     hangs for 30s (to test interrupts).
//
// Set SALCARA_FAKE_LOG to a folder to get JSON lines of arguments, calls and approval decisions.
package testfake

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"salcara/bridge/internal/mcpapproval"
)

// Run acts as the fake tool selected by args (os.Args[1:]) and returns when the fake exits.
// "mcp-approval ..." runs the real approval helper (the unit tests use the test binary as the bridge too).
func Run(args []string) {
	switch {
	case len(args) > 0 && args[0] == "--version":
		fmt.Println("9.9.9 (fake)")
	case len(args) > 0 && args[0] == "app-server":
		fakeCodex(args)
	case len(args) > 0 && args[0] == "mcp-approval":
		port, token, session := 0, "", ""
		for i := 1; i+1 < len(args); i += 2 {
			switch args[i] {
			case "--port":
				port, _ = strconv.Atoi(args[i+1])
			case "--token":
				token = args[i+1]
			case "--session":
				session = args[i+1]
			}
		}
		if err := mcpapproval.Run(port, token, session); err != nil {
			os.Exit(1)
		}
	default:
		fakeClaude(args)
	}
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func fakeLog(name string, v any) {
	dir := os.Getenv("SALCARA_FAKE_LOG")
	if dir == "" {
		return
	}
	b, _ := json.Marshal(v)
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(b, '\n'))
}

// ---------------- fake codex app-server ----------------

type fakeRPC struct {
	wmu     sync.Mutex
	mu      sync.Mutex
	waiting map[string]chan json.RawMessage
	nextID  int
}

func (f *fakeRPC) send(v any) {
	b, _ := json.Marshal(v)
	f.wmu.Lock()
	os.Stdout.Write(append(b, '\n'))
	f.wmu.Unlock()
}

func (f *fakeRPC) notify(method string, params any) {
	f.send(map[string]any{"method": method, "params": params})
}

// request sends a server→client request and waits for the client's result.
func (f *fakeRPC) request(method string, params any) json.RawMessage {
	f.mu.Lock()
	f.nextID++
	id := 100 + f.nextID
	ch := make(chan json.RawMessage, 1)
	f.waiting[strconv.Itoa(id)] = ch
	f.mu.Unlock()
	f.send(map[string]any{"id": id, "method": method, "params": params})
	select {
	case r := <-ch:
		return r
	case <-time.After(20 * time.Second):
		return nil
	}
}

func fakeThread(id, source, preview string) map[string]any {
	return map[string]any{"id": id, "sessionId": id, "preview": preview, "ephemeral": false, "modelProvider": "salcara",
		"model": "gpt-5.5", "createdAt": 1700000000, "updatedAt": 1700000100, "status": map[string]any{"type": "notLoaded"},
		"path": nil, "cwd": "/work/app", "cliVersion": "0.1", "originator": "codex_cli_rs", "source": source,
		"parentThreadId": nil, "name": nil, "turns": []any{}}
}

func fakeCodex(args []string) {
	fakeLog("codex-args.jsonl", map[string]any{"args": args, "key": os.Getenv("SUB2API_API_KEY")})
	f := &fakeRPC{waiting: map[string]chan json.RawMessage{}}
	var turnMu sync.Mutex
	interrupted := map[string]chan struct{}{}
	br := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		if m.Method == "" { // response to our request
			f.mu.Lock()
			ch := f.waiting[string(m.ID)]
			f.mu.Unlock()
			if ch != nil {
				ch <- m.Result
			}
			continue
		}
		var p map[string]any
		_ = json.Unmarshal(m.Params, &p)
		reply := func(r any) { f.send(map[string]any{"id": m.ID, "result": r}) }
		switch m.Method {
		case "initialize":
			reply(map[string]any{"userAgent": "fake", "codexHome": "/tmp", "platformFamily": "unix", "platformOs": "linux"})
		case "initialized":
		case "thread/list":
			fakeLog("codex-calls.jsonl", map[string]any{"method": m.Method, "params": p})
			reply(map[string]any{"data": []any{fakeThread("thr_cli", "cli", "fix the bug"), fakeThread("thr_ide", "vscode", "add tests")}, "nextCursor": nil})
		case "thread/read":
			th := fakeThread(str(p, "threadId"), "cli", "fix the bug")
			th["turns"] = []any{map[string]any{"id": "t1", "status": "completed", "startedAt": 1700000000, "items": []any{
				map[string]any{"type": "userMessage", "id": "i1", "content": []any{map[string]any{"type": "text", "text": "fix the bug"}}},
				map[string]any{"type": "reasoning", "id": "i2", "summary": []any{"Looking at code"}, "content": []any{}},
				map[string]any{"type": "commandExecution", "id": "i3", "command": "cat main.go", "cwd": "/work/app", "status": "completed",
					"commandActions":   []any{map[string]any{"type": "read", "command": "cat main.go", "name": "main.go", "path": "/work/app/main.go"}},
					"aggregatedOutput": "package main", "exitCode": 0},
				map[string]any{"type": "agentMessage", "id": "i4", "text": "Fixed."},
			}}}
			reply(map[string]any{"thread": th})
		case "thread/start", "thread/resume":
			fakeLog("codex-calls.jsonl", map[string]any{"method": m.Method, "params": p})
			id := "thr_new"
			if m.Method == "thread/resume" {
				id = str(p, "threadId")
			}
			th := fakeThread(id, "vscode", "")
			th["status"] = map[string]any{"type": "idle"}
			reply(map[string]any{"thread": th, "model": "gpt-5.5"})
			if m.Method == "thread/start" {
				f.notify("thread/started", map[string]any{"thread": th})
			}
		case "turn/start":
			fakeLog("codex-calls.jsonl", map[string]any{"method": m.Method, "params": p})
			tid := str(p, "threadId")
			turnID := "turn_" + strconv.Itoa(int(time.Now().UnixNano()%100000))
			reply(map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}})
			stop := make(chan struct{})
			turnMu.Lock()
			interrupted[turnID] = stop
			turnMu.Unlock()
			input, _ := p["input"].([]any)
			text := ""
			if len(input) > 0 {
				text = str(input[0].(map[string]any), "text")
			}
			go fakeCodexTurn(f, tid, turnID, text, stop)
		case "turn/interrupt":
			turnMu.Lock()
			if ch := interrupted[str(p, "turnId")]; ch != nil {
				close(ch)
				delete(interrupted, str(p, "turnId"))
			}
			turnMu.Unlock()
			reply(map[string]any{})
		case "model/list":
			reply(map[string]any{"data": []any{map[string]any{"id": "gpt-5.5", "model": "gpt-5.5", "hidden": false}, map[string]any{"id": "x", "model": "x", "hidden": true}}})
		default:
			f.send(map[string]any{"id": m.ID, "error": map[string]any{"code": -32601, "message": "nope"}})
		}
	}
}

func fakeCodexTurn(f *fakeRPC, tid, turnID, text string, stop chan struct{}) {
	base := map[string]any{"threadId": tid, "turnId": turnID}
	with := func(kv ...any) map[string]any {
		m := map[string]any{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	f.notify("turn/started", map[string]any{"threadId": tid, "turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}})
	f.notify("item/started", with("item", map[string]any{"type": "userMessage", "id": "u1", "content": []any{map[string]any{"type": "text", "text": text}}}))
	if strings.Contains(text, "slow") {
		<-stop
		f.notify("turn/completed", map[string]any{"threadId": tid, "turn": map[string]any{"id": turnID, "status": "interrupted", "items": []any{}}})
		return
	}
	f.notify("item/started", with("item", map[string]any{"type": "agentMessage", "id": "a1", "text": ""}))
	f.notify("item/agentMessage/delta", with("itemId", "a1", "delta", "Hel"))
	f.notify("item/agentMessage/delta", with("itemId", "a1", "delta", "lo"))
	f.notify("item/completed", with("item", map[string]any{"type": "agentMessage", "id": "a1", "text": "Hello"}))

	cmd := map[string]any{"type": "commandExecution", "id": "c1", "command": "npm test", "cwd": "/work/app", "status": "inProgress", "commandActions": []any{}}
	f.notify("item/started", with("item", cmd))
	res := f.request("item/commandExecution/requestApproval", with("itemId", "c1", "command", "npm test", "cwd", "/work/app", "startedAtMs", 1))
	var dec struct {
		Decision string `json:"decision"`
	}
	_ = json.Unmarshal(res, &dec)
	fakeLog("codex-decisions.jsonl", map[string]any{"kind": "command", "decision": dec.Decision})
	if dec.Decision == "accept" || dec.Decision == "acceptForSession" {
		f.notify("item/commandExecution/outputDelta", with("itemId", "c1", "delta", "ok 1\n"))
		cmd["status"], cmd["aggregatedOutput"], cmd["exitCode"] = "completed", "ok 1\n", 0
	} else {
		cmd["status"] = "declined"
	}
	f.notify("item/completed", with("item", cmd))

	fc := map[string]any{"type": "fileChange", "id": "f1", "status": "inProgress", "changes": []any{
		map[string]any{"path": "/work/app/a.txt", "kind": map[string]any{"type": "update", "move_path": nil}, "diff": "@@ -1 +1 @@\n-old\n+hello\n"}}}
	f.notify("item/started", with("item", fc))
	res = f.request("item/fileChange/requestApproval", with("itemId", "f1", "startedAtMs", 1))
	dec.Decision = ""
	_ = json.Unmarshal(res, &dec)
	fakeLog("codex-decisions.jsonl", map[string]any{"kind": "file", "decision": dec.Decision})
	if dec.Decision == "accept" {
		fc["status"] = "completed"
	} else {
		fc["status"] = "declined"
	}
	f.notify("item/completed", with("item", fc))
	f.notify("thread/tokenUsage/updated", with("tokenUsage", map[string]any{
		"total": map[string]any{"inputTokens": 1500, "outputTokens": 300}, "last": map[string]any{"inputTokens": 500, "outputTokens": 100}}))
	f.notify("turn/completed", map[string]any{"threadId": tid, "turn": map[string]any{"id": turnID, "status": "completed", "items": []any{}}})
}

// ---------------- fake claude ----------------

type fakeMCP struct {
	cmd   *exec.Cmd
	in    *bufio.Writer
	out   *bufio.Reader
	next  int
	inRaw interface{ Close() error }
}

func startFakeMCP(configPath string) *fakeMCP {
	b, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	var cfg struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if json.Unmarshal(b, &cfg) != nil {
		return nil
	}
	s, ok := cfg.MCPServers["salcara"]
	if !ok {
		return nil
	}
	cmd := exec.Command(s.Command, s.Args...)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if cmd.Start() != nil {
		return nil
	}
	m := &fakeMCP{cmd: cmd, in: bufio.NewWriter(stdin), out: bufio.NewReader(stdout), inRaw: stdin}
	m.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "fake", "version": "1"}})
	m.in.WriteString(`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n")
	m.in.Flush()
	m.call("tools/list", map[string]any{})
	return m
}

func (m *fakeMCP) call(method string, params any) json.RawMessage {
	m.next++
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.next, "method": method, "params": params})
	m.in.Write(append(b, '\n'))
	m.in.Flush()
	for {
		line, err := m.out.ReadBytes('\n')
		if err != nil {
			return nil
		}
		var r struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(line, &r) == nil && r.ID == m.next {
			return r.Result
		}
	}
}

// approve asks through MCP; returns behavior.
func (m *fakeMCP) approve(tool string, input map[string]any, id string) string {
	if m == nil {
		return "deny"
	}
	res := m.call("tools/call", map[string]any{"name": "approve", "arguments": map[string]any{"tool_name": tool, "input": input, "tool_use_id": id}})
	var r struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	_ = json.Unmarshal(res, &r)
	if len(r.Content) == 0 {
		return "deny"
	}
	var d struct {
		Behavior string `json:"behavior"`
	}
	_ = json.Unmarshal([]byte(r.Content[0].Text), &d)
	return d.Behavior
}

func fakeClaude(args []string) {
	cwd, _ := os.Getwd()
	fakeLog("claude-args.jsonl", map[string]any{"args": args, "base": os.Getenv("ANTHROPIC_BASE_URL"),
		"token": os.Getenv("ANTHROPIC_AUTH_TOKEN"), "cwd": cwd, "apikey": os.Getenv("ANTHROPIC_API_KEY")})
	session, mcpFile := "", ""
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--session-id", "--resume":
			session = args[i+1]
		case "--mcp-config":
			mcpFile = args[i+1]
		}
	}
	mcp := startFakeMCP(mcpFile)
	out := bufio.NewWriter(os.Stdout)
	emit := func(v any) {
		b, _ := json.Marshal(v)
		out.Write(append(b, '\n'))
		out.Flush()
	}
	inited := false
	n := 0
	br := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var u struct {
			Message struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &u) != nil || len(u.Message.Content) == 0 {
			continue
		}
		text := u.Message.Content[0].Text
		if !inited {
			inited = true
			emit(map[string]any{"type": "system", "subtype": "init", "session_id": session, "cwd": cwd, "model": "claude-fake-1"})
		}
		if strings.Contains(text, "sleep") {
			time.Sleep(30 * time.Second)
			continue
		}
		n++
		mid := "msg_" + strconv.Itoa(n)
		se := func(ev map[string]any) {
			emit(map[string]any{"type": "stream_event", "session_id": session, "parent_tool_use_id": nil, "event": ev})
		}
		se(map[string]any{"type": "message_start", "message": map[string]any{"id": mid}})
		se(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
		se(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "Hi "}})
		se(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "there"}})
		asst := func(block map[string]any) {
			emit(map[string]any{"type": "assistant", "session_id": session, "parent_tool_use_id": nil,
				"message": map[string]any{"id": mid, "role": "assistant", "model": "claude-fake-1", "content": []any{block}}})
		}
		asst(map[string]any{"type": "text", "text": "Hi there"})
		tuID := "toolu_" + strconv.Itoa(n)
		input := map[string]any{"command": "ls", "description": "List files"}
		asst(map[string]any{"type": "tool_use", "id": tuID, "name": "Bash", "input": input})
		behavior := mcp.approve("Bash", input, tuID)
		fakeLog("claude-decisions.jsonl", map[string]any{"tool": "Bash", "behavior": behavior})
		res := map[string]any{"type": "tool_result", "tool_use_id": tuID, "content": "file1\nfile2\n"}
		if behavior != "allow" {
			res = map[string]any{"type": "tool_result", "tool_use_id": tuID, "content": "denied", "is_error": true}
		}
		emit(map[string]any{"type": "user", "session_id": session, "parent_tool_use_id": nil, "message": map[string]any{"role": "user", "content": []any{res}}})
		if strings.Contains(text, "edit") {
			eid := "toolu_e" + strconv.Itoa(n)
			ein := map[string]any{"file_path": filepath.Join(cwd, "a.txt"), "old_string": "old", "new_string": "new"}
			asst(map[string]any{"type": "tool_use", "id": eid, "name": "Edit", "input": ein})
			b := mcp.approve("Edit", ein, eid)
			fakeLog("claude-decisions.jsonl", map[string]any{"tool": "Edit", "behavior": b})
			emit(map[string]any{"type": "user", "session_id": session, "parent_tool_use_id": nil, "message": map[string]any{"role": "user",
				"content": []any{map[string]any{"type": "tool_result", "tool_use_id": eid, "content": "ok"}}}})
		}
		emit(map[string]any{"type": "result", "subtype": "success", "is_error": false, "result": "Hi there", "session_id": session,
			"total_cost_usd": 0.0123, "usage": map[string]any{"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 5}})
	}
}
