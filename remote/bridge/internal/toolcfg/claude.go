package toolcfg

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Environment keys written into ~/.claude/settings.json "env".
const (
	EnvBaseURL   = "ANTHROPIC_BASE_URL"
	EnvAuthToken = "ANTHROPIC_AUTH_TOKEN"
	EnvNoTraffic = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
)

// ClaudeStatus is what the console shows for Claude Code.
type ClaudeStatus struct {
	Path         string `json:"path"`
	Exists       bool   `json:"exists"`
	BaseURL      string `json:"baseUrl"`
	TokenMatches bool   `json:"tokenMatches"`
	Configured   bool   `json:"configured"`
	HasBackup    bool   `json:"hasBackup"`
	APIKeySet    bool   `json:"apiKeySet"` // env.ANTHROPIC_API_KEY is also set (takes a different auth path)
	Error        string `json:"error,omitempty"`
}

// ClaudeSettingsPath is ~/.claude/settings.json (CLAUDE_CONFIG_DIR respected).
func ClaudeSettingsPath() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "settings.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "settings.json")
}

// ordered is a JSON object that keeps its key order and the raw form of values it doesn't touch.
type ordered struct {
	keys []string
	vals map[string]json.RawMessage
}

func parseOrdered(b []byte) (*ordered, error) {
	o := &ordered{vals: map[string]json.RawMessage{}}
	if len(bytes.TrimSpace(b)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("不是 JSON 对象")
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, _ := kt.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		if _, dup := o.vals[k]; !dup {
			o.keys = append(o.keys, k)
		}
		o.vals[k] = raw
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return o, nil
}

func (o *ordered) set(k string, v json.RawMessage) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *ordered) del(k string) {
	if _, ok := o.vals[k]; !ok {
		return
	}
	delete(o.vals, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *ordered) marshal() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("{")
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteString(",")
		}
		kb, _ := json.Marshal(k)
		buf.WriteString("\n  ")
		buf.Write(kb)
		buf.WriteString(": ")
		var ind bytes.Buffer
		if err := json.Indent(&ind, o.vals[k], "  ", "  "); err != nil {
			return nil, err
		}
		buf.Write(ind.Bytes())
	}
	if len(o.keys) > 0 {
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	return buf.Bytes(), nil
}

func (o *ordered) str(k string) string {
	var s string
	_ = json.Unmarshal(o.vals[k], &s)
	return s
}

func jsonStr(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return b
}

func envOf(root *ordered) (*ordered, error) {
	raw, ok := root.vals["env"]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return &ordered{vals: map[string]json.RawMessage{}}, nil
	}
	env, err := parseOrdered(raw)
	if err != nil {
		return nil, fmt.Errorf("settings.json 里的 env 不是对象: %w", err)
	}
	return env, nil
}

// ApplyClaudeJSON sets env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
// preserving every other key and the key order.
func ApplyClaudeJSON(content []byte, baseURL, token string) ([]byte, error) {
	root, err := parseOrdered(content)
	if err != nil {
		return nil, fmt.Errorf("settings.json 格式有误，未修改: %w", err)
	}
	env, err := envOf(root)
	if err != nil {
		return nil, err
	}
	env.set(EnvBaseURL, jsonStr(baseURL))
	env.set(EnvAuthToken, jsonStr(token))
	env.set(EnvNoTraffic, jsonStr("1"))
	eb, err := env.marshal()
	if err != nil {
		return nil, err
	}
	root.set("env", bytes.TrimSpace(eb))
	return root.marshal()
}

// RemoveClaudeJSON removes the keys ApplyClaudeJSON added (used when there is no backup).
func RemoveClaudeJSON(content []byte) ([]byte, error) {
	root, err := parseOrdered(content)
	if err != nil {
		return nil, fmt.Errorf("settings.json 格式有误，未修改: %w", err)
	}
	env, err := envOf(root)
	if err != nil {
		return nil, err
	}
	env.del(EnvBaseURL)
	env.del(EnvAuthToken)
	env.del(EnvNoTraffic)
	if len(env.keys) == 0 {
		root.del("env")
	} else {
		eb, err := env.marshal()
		if err != nil {
			return nil, err
		}
		root.set("env", bytes.TrimSpace(eb))
	}
	return root.marshal()
}

// ClaudeStatusFor inspects the settings file.
func ClaudeStatusFor(path, baseURL, key string) ClaudeStatus {
	st := ClaudeStatus{Path: path, HasBackup: hasBackup(path)}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			st.Error = err.Error()
		}
		return st
	}
	st.Exists = true
	root, err := parseOrdered(b)
	if err != nil {
		st.Error = "settings.json 格式有误"
		return st
	}
	env, err := envOf(root)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.BaseURL = env.str(EnvBaseURL)
	st.TokenMatches = key != "" && env.str(EnvAuthToken) == key
	_, st.APIKeySet = env.vals["ANTHROPIC_API_KEY"]
	st.Configured = baseURL != "" && strings.TrimRight(st.BaseURL, "/") == strings.TrimRight(baseURL, "/") && st.TokenMatches
	return st
}

// ApplyClaude edits settings.json at path, backing up the original once.
func ApplyClaude(path, baseURL, token string) error {
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	out, perr := ApplyClaudeJSON(b, baseURL, token)
	if perr != nil {
		return perr
	}
	if err := backupOnce(path, b, err == nil); err != nil {
		return err
	}
	return writeFileKeepMode(path, out, 0o600)
}

// RestoreClaude puts the backup back, or removes our keys when there is no backup.
func RestoreClaude(path string) error {
	if ok, err := restoreBackup(path); ok || err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	out, err := RemoveClaudeJSON(b)
	if err != nil {
		return err
	}
	return writeFileKeepMode(path, out, 0o600)
}
