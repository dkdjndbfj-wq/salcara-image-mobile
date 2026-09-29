package toolcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleTOML = `# my codex config
model = "gpt-5.5"
model_provider = "openai"
approval_policy = "on-request"
notify = [
  "python3",
  "/x/notify.py", # [not a header]
]

# profiles below
[profiles.fast]
model = "gpt-5.5-mini"

[model_providers.salcara]
name = "old"
base_url = "https://old.example.com/v1"
experimental_bearer_token = "sk-old"

# comment about mcp
[mcp_servers.fs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
desc = """
[fake.header]
"""
`

func TestApplyCodexTOMLReplaceAndPreserve(t *testing.T) {
	p := CodexParams{BaseURL: "https://relay.example.com/v1", Token: `sk-"new"`}
	out := ApplyCodexTOML(sampleTOML, p)
	for _, want := range []string{
		"# my codex config",
		`model = "gpt-5.5"`,
		`model_provider = "salcara"`,
		`approval_policy = "on-request"`,
		`"/x/notify.py", # [not a header]`,
		"[profiles.fast]",
		`model = "gpt-5.5-mini"`,
		"[model_providers.salcara]",
		`base_url = "https://relay.example.com/v1"`,
		`wire_api = "responses"`,
		"requires_openai_auth = false",
		"supports_websockets = false",
		`experimental_bearer_token = "sk-\"new\""`,
		"# comment about mcp",
		"[mcp_servers.fs]",
		"[fake.header]",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	for _, gone := range []string{`model_provider = "openai"`, "sk-old", "old.example.com", `name = "old"`} {
		if strings.Contains(out, gone) {
			t.Errorf("still contains %q", gone)
		}
	}
	if strings.Count(out, "[model_providers.salcara]") != 1 {
		t.Error("duplicate table")
	}
	// table replaced in place: before the mcp comment, after profiles
	if !(strings.Index(out, "[profiles.fast]") < strings.Index(out, "[model_providers.salcara]") &&
		strings.Index(out, "[model_providers.salcara]") < strings.Index(out, "# comment about mcp")) {
		t.Errorf("table not in place:\n%s", out)
	}
	if again := ApplyCodexTOML(out, p); again != out {
		t.Errorf("not idempotent:\n--- first\n%s\n--- second\n%s", out, again)
	}
	inspectProv, base, tok, _ := InspectCodexTOML(out)
	if inspectProv != "salcara" || base != p.BaseURL || tok != p.Token {
		t.Errorf("inspect: %q %q %q", inspectProv, base, tok)
	}
}

func TestApplyCodexTOMLInsert(t *testing.T) {
	// empty file
	out := ApplyCodexTOML("", CodexParams{BaseURL: "https://r/v1", EnvKey: CodexEnvKey})
	if !strings.HasPrefix(out, `model_provider = "salcara"`+"\n\n[model_providers.salcara]") {
		t.Errorf("empty insert:\n%s", out)
	}
	if !strings.Contains(out, `env_key = "SUB2API_API_KEY"`) || strings.Contains(out, "experimental_bearer_token") {
		t.Errorf("env mode:\n%s", out)
	}
	// file with only tables and a leading comment: model_provider must go before the first header
	in := "# hello\n[features]\ngoals = true\n"
	out = ApplyCodexTOML(in, CodexParams{BaseURL: "https://r/v1", Token: "k"})
	if strings.Index(out, "model_provider") > strings.Index(out, "[features]") {
		t.Errorf("model_provider after header:\n%s", out)
	}
	if !strings.HasPrefix(out, "# hello\nmodel_provider") {
		t.Errorf("leading comment not kept first:\n%s", out)
	}
	if ApplyCodexTOML(out, CodexParams{BaseURL: "https://r/v1", Token: "k"}) != out {
		t.Error("insert not idempotent")
	}
	// CRLF preserved
	crlf := ApplyCodexTOML("model = \"x\"\r\n", CodexParams{BaseURL: "u", Token: "k"})
	if !strings.Contains(crlf, "\r\n") || strings.Contains(strings.ReplaceAll(crlf, "\r\n", ""), "\n") {
		t.Errorf("crlf: %q", crlf)
	}
	// remove
	rm := RemoveCodexTOML(out)
	if strings.Contains(rm, "salcara") || !strings.Contains(rm, "[features]") || !strings.Contains(rm, "# hello") {
		t.Errorf("remove:\n%s", rm)
	}
}

func TestCodexFileApplyRestore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	orig := "model = \"o3\"\n"
	os.WriteFile(path, []byte(orig), 0o644)
	if err := ApplyCodex(path, CodexParams{BaseURL: "https://r/v1", Token: "k1"}); err != nil {
		t.Fatal(err)
	}
	// second apply must not overwrite the backup of the original
	if err := ApplyCodex(path, CodexParams{BaseURL: "https://r/v1", Token: "k2"}); err != nil {
		t.Fatal(err)
	}
	st := CodexStatusFor(path, "https://r/v1", "k2")
	if !st.Configured || !st.HasBackup || st.AuthMode != "token" {
		t.Fatalf("status %+v", st)
	}
	if err := RestoreCodex(path); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != orig {
		t.Fatalf("restore got %q", b)
	}
	if hasBackup(path) {
		t.Fatal("backup not removed")
	}
}

func TestClaudeSettings(t *testing.T) {
	in := []byte(`{
  "model": "opus",
  "permissions": {"allow": ["Bash(ls:*)"], "deny": []},
  "env": {"FOO": "bar", "ANTHROPIC_BASE_URL": "https://old"},
  "hooks": {}
}`)
	out, err := ApplyClaudeJSON(in, "https://relay.example.com", "sk-c")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, out)
	}
	env := m["env"].(map[string]any)
	if env["FOO"] != "bar" || env[EnvBaseURL] != "https://relay.example.com" || env[EnvAuthToken] != "sk-c" || env[EnvNoTraffic] != "1" {
		t.Fatalf("env %v", env)
	}
	if m["model"] != "opus" || m["permissions"] == nil || m["hooks"] == nil {
		t.Fatalf("lost keys: %s", out)
	}
	// key order preserved
	s := string(out)
	if !(strings.Index(s, `"model"`) < strings.Index(s, `"permissions"`) && strings.Index(s, `"permissions"`) < strings.Index(s, `"env"`) && strings.Index(s, `"env"`) < strings.Index(s, `"hooks"`)) {
		t.Errorf("order changed:\n%s", s)
	}
	again, _ := ApplyClaudeJSON(out, "https://relay.example.com", "sk-c")
	if string(again) != s {
		t.Error("not idempotent")
	}
	rm, err := RemoveClaudeJSON(out)
	if err != nil || strings.Contains(string(rm), "ANTHROPIC") || !strings.Contains(string(rm), `"FOO"`) {
		t.Errorf("remove: %v %s", err, rm)
	}
	// empty / missing file
	out, err = ApplyClaudeJSON(nil, "u", "k")
	if err != nil || !strings.Contains(string(out), `"ANTHROPIC_AUTH_TOKEN": "k"`) {
		t.Errorf("empty: %v %s", err, out)
	}
	// invalid JSON is refused
	if _, err := ApplyClaudeJSON([]byte(`{"a":`), "u", "k"); err == nil {
		t.Error("expected error for invalid json")
	}
}

func TestClaudeFileApplyRestore(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".claude", "settings.json")
	// no original → restore strips our keys
	if err := ApplyClaude(path, "https://r", "k"); err != nil {
		t.Fatal(err)
	}
	if st := ClaudeStatusFor(path, "https://r", "k"); !st.Configured || st.HasBackup {
		t.Fatalf("%+v", st)
	}
	if err := RestoreClaude(path); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if strings.TrimSpace(string(b)) != "{}" {
		t.Fatalf("got %q", b)
	}
	// with original → backup restored byte-for-byte
	orig := `{"theme":"dark"}`
	os.WriteFile(path, []byte(orig), 0o600)
	ApplyClaude(path, "https://r", "k")
	RestoreClaude(path)
	b, _ = os.ReadFile(path)
	if string(b) != orig {
		t.Fatalf("got %q", b)
	}
}
