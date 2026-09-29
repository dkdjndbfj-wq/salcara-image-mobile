package agents

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"salcara/bridge/internal/protocol"
)

func TestUnifiedDiff(t *testing.T) {
	d := unifiedDiff("f.txt", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk\n")
	want := "--- a/f.txt\n+++ b/f.txt\n@@ -2,9 +2,10 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n i\n j\n+k\n"
	if d != want {
		t.Fatalf("got\n%s\nwant\n%s", d, want)
	}
	add := addedFileDiff("n.go", "x\ny\n")
	if add != "--- /dev/null\n+++ b/n.go\n@@ -0,0 +1,2 @@\n+x\n+y\n" {
		t.Fatalf("add %q", add)
	}
	if unifiedDiff("s", "same\n", "same\n") != "" {
		t.Fatal("no-op diff")
	}
	far := unifiedDiff("g", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n", "X\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nY\n")
	if strings.Count(far, "@@ -") != 2 {
		t.Fatalf("expected two hunks:\n%s", far)
	}
}

func TestCodexItemMapping(t *testing.T) {
	cases := []struct {
		item string
		kind string
		want string
	}{
		{`{"type":"commandExecution","id":"1","command":"rg foo","cwd":"/w","status":"completed","exitCode":1,"commandActions":[{"type":"search","command":"rg foo","query":"foo","path":null}],"aggregatedOutput":"x"}`, "search", "搜索 “foo”|failed"},
		{`{"type":"commandExecution","id":"1","command":"go test ./...","cwd":"/w","status":"inProgress","commandActions":[{"type":"unknown","command":"go test ./..."}]}`, "command", "运行 go test ./...|running"},
		{`{"type":"fileChange","id":"2","status":"completed","changes":[{"path":"/w/new.txt","kind":{"type":"add"},"diff":"hi\n"}]}`, "file_change", "创建 new.txt|done"},
		{`{"type":"mcpToolCall","id":"3","server":"gh","tool":"search","status":"completed","arguments":{"q":1},"result":{"content":[{"type":"text","text":"r"}]},"error":null}`, "mcp", "调用 gh.search|done"},
		{`{"type":"webSearch","id":"4","query":"go generics","action":{"type":"search","query":"go generics"}}`, "web", "搜索网页 “go generics”|done"},
	}
	for _, c := range cases {
		var it cxItem
		if err := json.Unmarshal([]byte(c.item), &it); err != nil {
			t.Fatal(err)
		}
		e, ok := codexItemEvent("codex:t", it, true, "/w")
		if !ok || e.Kind != c.kind || e.Title+"|"+e.Status != c.want {
			t.Fatalf("%s → %+v", c.item, e)
		}
		if it.Type == "fileChange" && !strings.Contains(e.Diff, "+++ b/w/new.txt\n@@ -0,0 +1,1 @@\n+hi") {
			t.Fatalf("diff %q", e.Diff)
		}
	}
	if codexClient(json.RawMessage(`"appServer"`), "", false) != "Codex App" ||
		codexClient(json.RawMessage(`"vscode"`), "Codex Desktop", false) != "Codex App" ||
		codexClient(json.RawMessage(`{"custom":"x"}`), "", false) != "Codex" ||
		codexClient(json.RawMessage(`"cli"`), "", true) != "Codex" {
		t.Fatal("client mapping")
	}
}

func TestClaudeToolDescriptions(t *testing.T) {
	d := describeClaudeTool("TodoWrite", map[string]any{"todos": []any{
		map[string]any{"content": "a", "status": "completed"}, map[string]any{"content": "b", "status": "in_progress"}}}, "", false)
	if d.title != "更新待办（1/2 完成）" || d.detail != "✓ a\n▶ b" {
		t.Fatalf("%+v", d)
	}
	if d := describeClaudeTool("mcp__github__create_pr", map[string]any{}, "", false); d.kind != "mcp" || d.title != "调用 github.create_pr" {
		t.Fatalf("%+v", d)
	}
	if d := describeClaudeTool("Grep", map[string]any{"pattern": "useEffect"}, "", false); d.kind != "search" || d.title != "搜索 “useEffect”" {
		t.Fatalf("%+v", d)
	}
	if d := describeClaudeTool("Write", map[string]any{"file_path": "/w/x.go", "content": "a\n"}, "/w", false); d.title != "创建 x.go" || !strings.Contains(d.diff, "+a") {
		t.Fatalf("%+v", d)
	}
	long := strings.Repeat("长", 200)
	if d := describeClaudeTool("Bash", map[string]any{"command": long}, "", false); len([]rune(d.title)) != maxTitleChars {
		t.Fatalf("title not truncated: %d", len([]rune(d.title)))
	}
}

func TestClaudeStreamIDsMatchFinal(t *testing.T) {
	m := newClaudeMapper("claude:s", "")
	m.stream(json.RawMessage(`{"type":"message_start","message":{"id":"msg_X"}}`))
	m.stream(json.RawMessage(`{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`))
	p := m.stream(json.RawMessage(`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}`))
	m.stream(json.RawMessage(`{"type":"content_block_start","index":1,"content_block":{"type":"text"}}`))
	q := m.stream(json.RawMessage(`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}`))
	f1 := m.assistant(json.RawMessage(`{"id":"msg_X","content":[{"type":"thinking","thinking":"hm"}]}`), "", 1)
	f2 := m.assistant(json.RawMessage(`{"id":"msg_X","content":[{"type":"text","text":"Hi"}]}`), "", 1)
	if p[0].ID != f1[0].ID || q[0].ID != f2[0].ID || p[0].Type != "reasoning" || q[0].Type != "message" {
		t.Fatalf("%+v %+v %+v %+v", p, q, f1, f2)
	}
}

func TestThrottle(t *testing.T) {
	var got []protocol.Event
	ch := make(chan struct{}, 10)
	th := newThrottle(func(e protocol.Event) { got = append(got, e); ch <- struct{}{} })
	for i := 0; i < 50; i++ {
		th.Update(protocol.Event{Type: "message", ID: "a", Text: strings.Repeat("x", i)})
	}
	<-ch // immediate first
	th.Final(protocol.Event{Type: "message", ID: "a", Text: "done", Final: true})
	<-ch
	time.Sleep(2 * streamInterval)
	if len(got) != 2 || got[1].Text != "done" {
		t.Fatalf("got %d events: %+v", len(got), got)
	}
}

func TestDedupe(t *testing.T) {
	evs := []protocol.Event{{Type: "tool", ID: "1", Status: "running"}, {Type: "message", ID: "m"}, {Type: "tool", ID: "1", Status: "done"}, {Type: "turn"}}
	out := dedupeEvents(evs, 0)
	if len(out) != 3 || out[0].Status != "done" {
		t.Fatalf("%+v", out)
	}
}
