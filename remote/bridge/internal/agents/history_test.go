package agents

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"salcara/bridge/internal/protocol"
)

type httpResp struct {
	status int
	body   string
}

func httpPost(url, token, body string) (httpResp, error) {
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("X-Salcara-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return httpResp{}, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return httpResp{resp.StatusCode, string(b)}, nil
}

// Recorded transcript lines (shape taken from real Claude Code 2.1 transcripts).
const transcript = `{"type":"file-history-snapshot","messageId":"x","snapshot":{}}
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"},"isMeta":false,"uuid":"u0","timestamp":"2026-09-01T10:00:00.000Z","entrypoint":"claude-desktop","cwd":"/work/site","sessionId":"S"}
{"parentUuid":"u0","isSidechain":false,"type":"user","message":{"role":"user","content":"把按钮改成蓝色"},"uuid":"u1","timestamp":"2026-09-01T10:00:01.000Z","entrypoint":"claude-desktop","cwd":"/work/site","sessionId":"S"}
{"parentUuid":"u1","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_A","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"Need to find the button","signature":"x"}]},"type":"assistant","uuid":"a1","timestamp":"2026-09-01T10:00:02.000Z","cwd":"/work/site"}
{"parentUuid":"a1","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_A","type":"message","role":"assistant","content":[{"type":"text","text":"我来修改。"}]},"type":"assistant","uuid":"a2","timestamp":"2026-09-01T10:00:03.000Z","cwd":"/work/site"}
{"parentUuid":"a2","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_A","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_E","name":"Edit","input":{"file_path":"/work/site/btn.css","old_string":"color: red;","new_string":"color: blue;"}}]},"type":"assistant","uuid":"a3","timestamp":"2026-09-01T10:00:04.000Z","cwd":"/work/site"}
{"parentUuid":"a3","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_E","type":"tool_result","content":"The file has been updated."}]},"uuid":"r1","timestamp":"2026-09-01T10:00:05.000Z","toolUseResult":{"filePath":"/work/site/btn.css"},"cwd":"/work/site"}
{"parentUuid":"r1","isSidechain":true,"type":"user","message":{"role":"user","content":"sidechain prompt"},"uuid":"sc","timestamp":"2026-09-01T10:00:06.000Z","cwd":"/work/site"}
{"type":"ai-title","aiTitle":"按钮改色","sessionId":"S"}
`

func writeTranscript(t *testing.T, home, id, content string, age time.Duration) string {
	dir := filepath.Join(home, "projects", "-work-site")
	os.MkdirAll(dir, 0o700)
	p := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-age)
	os.Chtimes(p, old, old)
	return p
}

func TestClaudeHistory(t *testing.T) {
	f := newFixture(t, "ask")
	id := "11111111-2222-4333-8444-555555555555"
	writeTranscript(t, f.home, id, transcript, time.Hour)
	writeTranscript(t, f.home, "empty", `{"type":"file-history-snapshot"}`+"\n", time.Hour)
	cl := f.m.Get("claude")
	list, err := cl.Sessions(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("%v %+v", err, list)
	}
	s := list[0]
	if s.Title != "把按钮改成蓝色" || s.Client != "Claude Desktop" || s.Cwd != "/work/site" || s.Model != "claude-opus-5-5" ||
		s.Status != "idle" || !s.Controllable {
		t.Fatalf("info %+v", s)
	}
	_, evs, err := cl.Open(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range evs {
		got = append(got, e.Type+":"+e.Kind+e.Role+":"+e.Status)
	}
	if strings.Join(got, ",") != "message:user:,reasoning::,message:assistant:,tool:file_change:done" {
		t.Fatalf("events %v", got)
	}
	tool := evs[3]
	if tool.Title != "修改 btn.css" || !strings.Contains(tool.Diff, "-color: red;\n+color: blue;") || tool.ID != "toolu_E" {
		t.Fatalf("tool %+v", tool)
	}
	if evs[2].ID != "msg_A:1" || evs[1].ID != "msg_A:0" {
		t.Fatalf("ids %s %s", evs[1].ID, evs[2].ID)
	}
	// external recent activity → not controllable
	now := time.Now()
	os.Chtimes(filepath.Join(f.home, "projects", "-work-site", id+".jsonl"), now, now)
	list, _ = cl.Sessions(context.Background())
	if list[0].Status != "running" || list[0].Controllable {
		t.Fatalf("external running %+v", list[0])
	}
	if err := cl.Send(context.Background(), id, "hi"); err == nil || err.Error() != errExternalRunning {
		t.Fatalf("send to external running session: %v", err)
	}
}

func TestClaudeWatch(t *testing.T) {
	f := newFixture(t, "ask")
	id := "aaaaaaaa-2222-4333-8444-555555555555"
	p := writeTranscript(t, f.home, id, transcript, time.Hour)
	f.m.Watch(context.Background())
	time.Sleep(200 * time.Millisecond) // baseline
	if n := f.rec.count(func(e protocol.Event) bool { return true }); n != 0 {
		t.Fatalf("baseline should be silent, got %d", n)
	}
	fh, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o600)
	fh.WriteString(`{"type":"user","message":{"role":"user","content":"再加个边框"},"uuid":"u9","timestamp":"2026-09-01T11:00:00.000Z","cwd":"/work/site"}` + "\n")
	fh.WriteString(`{"type":"assistant","message":{"id":"msg_B","role":"assistant","content":[{"type":"tool_use","id":"toolu_B","name":"Bash","input":{"command":"npm run build"}}]},"uuid":"a9","timestamp":"2026-09-01T11:00:01.000Z"}` + "\n")
	fh.WriteString(`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_B","type":"tool_result","content":"built","is_error":false}]}}`) // no newline yet → partial
	fh.Close()
	up := f.rec.wait(t, "session.updated", func(e protocol.Event) bool { return e.Type == "session.updated" })
	if up.Session.Status != "running" || up.Session.Controllable {
		t.Fatalf("status %+v", up.Session)
	}
	f.rec.wait(t, "user msg", func(e protocol.Event) bool { return e.Type == "message" && e.Text == "再加个边框" })
	f.rec.wait(t, "tool running", func(e protocol.Event) bool {
		return e.Type == "tool" && e.ID == "toolu_B" && e.Status == "running" && e.Title == "运行 npm run build"
	})
	fh, _ = os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o600)
	fh.WriteString("\n")
	fh.Close()
	f.rec.wait(t, "tool done", func(e protocol.Event) bool {
		return e.Type == "tool" && e.ID == "toolu_B" && e.Status == "done" && e.Output == "built"
	})
}
