// Package config stores the bridge settings in os.UserConfigDir()/SalcaraBridge/config.json.
//
// Security note: API keys are stored in plain JSON. The file is created with mode 0600 (owner read/write only)
// inside the user's own profile directory (on Windows: %AppData%\SalcaraBridge, which is already private to the
// Windows user account). Any obfuscation would not be real protection against software running as the same
// user, so we deliberately don't pretend otherwise.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"salcara/bridge/internal/protocol"
)

// Approval policies (PROTOCOL.md §5).
const (
	ApprovalAsk       = "ask"
	ApprovalAutoEdits = "auto_edits"
	ApprovalAutoAll   = "auto_all"
)

// Codex auth modes for the one-click Codex configuration.
const (
	CodexAuthToken = "token" // experimental_bearer_token in config.toml
	CodexAuthEnv   = "env"   // env_key = "SUB2API_API_KEY" (+ setx on Windows)
)

// Config is the on-disk configuration.
type Config struct {
	RelayRoot  string `json:"relayRoot"`
	HubURL     string `json:"hubUrl,omitempty"` // empty = RelayRoot + "/salcara-hub"
	AccountKey string `json:"accountKey"`
	CodexKey   string `json:"codexKey,omitempty"`  // empty = AccountKey
	ClaudeKey  string `json:"claudeKey,omitempty"` // empty = AccountKey

	DeviceID     string             `json:"deviceId"`
	DeviceSecret string             `json:"deviceSecret"`
	DeviceName   string             `json:"deviceName"`
	Projects     []protocol.Project `json:"projects"`

	Approval           string `json:"approval"`
	Autostart          bool   `json:"autostart"`
	AutostartDecided   bool   `json:"autostartDecided"` // set once autostart was enabled on first login (or the user chose)
	OpenConsoleOnStart bool   `json:"openConsoleOnStart"`
	CodexModel         string `json:"codexModel,omitempty"`
	ClaudeModel        string `json:"claudeModel,omitempty"`
	CodexAuthMode      string `json:"codexAuthMode,omitempty"`
}

// Clone returns a deep copy.
func (c Config) Clone() Config {
	c.Projects = append([]protocol.Project(nil), c.Projects...)
	return c
}

// EffectiveHubURL is the hub base (without /v1).
func (c Config) EffectiveHubURL() string {
	if h := strings.TrimRight(strings.TrimSpace(c.HubURL), "/"); h != "" {
		return h
	}
	if c.RelayRoot == "" {
		return ""
	}
	return strings.TrimRight(c.RelayRoot, "/") + "/salcara-hub"
}

func (c Config) EffectiveCodexKey() string {
	if c.CodexKey != "" {
		return c.CodexKey
	}
	return c.AccountKey
}

func (c Config) EffectiveClaudeKey() string {
	if c.ClaudeKey != "" {
		return c.ClaudeKey
	}
	return c.AccountKey
}

// LoggedIn reports whether relay address and account key are set.
func (c Config) LoggedIn() bool { return c.RelayRoot != "" && c.AccountKey != "" }

// NormalizeRelayRoot trims spaces, trailing slashes and a trailing /v1 ("https://x.com/v1/" → "https://x.com").
func NormalizeRelayRoot(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "/")
	if strings.HasSuffix(strings.ToLower(s), "/v1") {
		s = strings.TrimRight(s[:len(s)-3], "/")
	}
	if s != "" && !strings.Contains(s, "://") {
		s = "https://" + s
	}
	return s
}

// ValidApproval reports whether p is a known policy.
func ValidApproval(p string) bool {
	return p == ApprovalAsk || p == ApprovalAutoEdits || p == ApprovalAutoAll
}

// Dir returns the config directory (os.UserConfigDir()/SalcaraBridge).
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "SalcaraBridge"), nil
}

// Store is a concurrency-safe handle on the config file.
type Store struct {
	path string
	mu   sync.RWMutex
	cfg  Config
	subs []func(old, new Config)
}

// Open loads (or creates) the config file at path. An empty path means Dir()/config.json.
func Open(path string) (*Store, error) {
	if path == "" {
		dir, err := Dir()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(dir, "config.json")
	}
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.cfg); err != nil {
			// Keep the broken file for the user and start fresh rather than refusing to run.
			_ = os.Rename(path, path+".broken")
			s.cfg = Config{}
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	changed := s.fillDefaults()
	if changed {
		if err := s.saveLocked(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) fillDefaults() bool {
	changed := false
	if s.cfg.DeviceID == "" {
		s.cfg.DeviceID = NewUUID()
		changed = true
	}
	if s.cfg.DeviceSecret == "" {
		s.cfg.DeviceSecret = RandomToken(32)
		changed = true
	}
	if s.cfg.DeviceName == "" {
		h, _ := os.Hostname()
		if h == "" {
			h = "我的电脑"
		}
		s.cfg.DeviceName = h
		changed = true
	}
	if !ValidApproval(s.cfg.Approval) {
		s.cfg.Approval = ApprovalAsk
		changed = true
	}
	if s.cfg.CodexAuthMode == "" {
		s.cfg.CodexAuthMode = CodexAuthToken
		changed = true
	}
	if s.cfg.Projects == nil {
		s.cfg.Projects = []protocol.Project{}
		changed = true
	}
	return changed
}

// Path is the config file location.
func (s *Store) Path() string { return s.path }

// Get returns a copy of the current config.
func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg.Clone()
}

// Update applies fn to a copy, saves it and notifies subscribers. If fn returns an error nothing changes.
func (s *Store) Update(fn func(c *Config) error) error {
	s.mu.Lock()
	old := s.cfg.Clone()
	next := s.cfg.Clone()
	if err := fn(&next); err != nil {
		s.mu.Unlock()
		return err
	}
	s.cfg = next
	s.fillDefaults()
	if err := s.saveLocked(); err != nil {
		s.cfg = old
		s.mu.Unlock()
		return err
	}
	cur := s.cfg.Clone()
	subs := append([]func(old, new Config){}, s.subs...)
	s.mu.Unlock()
	for _, f := range subs {
		f(old, cur)
	}
	return nil
}

// OnChange registers fn to be called after every successful Update.
func (s *Store) OnChange(fn func(old, new Config)) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	if err := os.Rename(tmp, s.path); err != nil {
		// Windows can refuse to rename over a file held open elsewhere; fall back to a direct write.
		_ = os.Remove(tmp)
		if err2 := os.WriteFile(s.path, b, 0o600); err2 != nil {
			return fmt.Errorf("保存配置失败: %w", err2)
		}
	}
	_ = os.Chmod(s.path, 0o600)
	return nil
}

// NewUUID returns a random RFC 4122 version 4 UUID.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// RandomToken returns n random bytes hex-encoded.
func RandomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// ProjectName derives a display name from a folder path (last element, handling both separators).
func ProjectName(p string) string {
	t := strings.TrimRight(p, `/\`)
	if i := strings.LastIndexAny(t, `/\`); i >= 0 {
		t = t[i+1:]
	}
	if t == "" {
		return p // "/" or "C:\"
	}
	return t
}
