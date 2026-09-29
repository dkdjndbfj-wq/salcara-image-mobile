package mcpapproval

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestServe(t *testing.T) {
	// tools/call requests are served concurrently, so the handler must not share state unguarded.
	var mu sync.Mutex
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Salcara-Token") != "tok" || r.URL.Path != "/perm" {
			w.WriteHeader(403)
			return
		}
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		got = req
		mu.Unlock()
		if req["tool_name"] == "Bash" {
			io.WriteString(w, `{"behavior":"allow","updatedInput":{"command":"ls"}}`)
		} else {
			io.WriteString(w, `{"behavior":"deny","message":"no"}`)
		}
	}))
	defer srv.Close()

	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Write","input":{}}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"resources/list"}`,
	}, "\n") + "\n"
	pr, pw := io.Pipe()
	go func() {
		Serve(strings.NewReader(in), pw, srv.URL+"/perm", "tok", "sess-1")
		pw.Close()
	}()
	res := map[int]map[string]any{}
	sc := bufio.NewScanner(pr)
	for sc.Scan() {
		var m map[string]any
		json.Unmarshal(sc.Bytes(), &m)
		res[int(m["id"].(float64))] = m
	}
	init := res[1]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-03-26" || init["capabilities"].(map[string]any)["tools"] == nil {
		t.Fatalf("init %+v", init)
	}
	tools := res[2]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "approve" {
		t.Fatalf("tools %+v", tools)
	}
	text := func(id int) string {
		return res[id]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	if text(3) != `{"behavior":"allow","updatedInput":{"command":"ls"}}` {
		t.Fatalf("allow %s", text(3))
	}
	if text(4) != `{"behavior":"deny","message":"no"}` {
		t.Fatalf("deny %s", text(4))
	}
	if res[5]["error"] == nil {
		t.Fatal("unknown method should error")
	}
	mu.Lock()
	defer mu.Unlock()
	if got["session"] != "sess-1" {
		t.Fatalf("session %+v", got)
	}
}

func TestServeBridgeDown(t *testing.T) {
	in := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{}}}}` + "\n"
	var sb strings.Builder
	Serve(strings.NewReader(in), &sb, "http://127.0.0.1:1/x", "tok", "s")
	if !strings.Contains(sb.String(), `\"behavior\":\"deny\"`) {
		t.Fatalf("%s", sb.String())
	}
}
