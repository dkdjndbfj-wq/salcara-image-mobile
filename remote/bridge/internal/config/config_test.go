package config

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"salcara/bridge/internal/protocol"
)

func TestRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "config.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	c := s.Get()
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(c.DeviceID) {
		t.Fatalf("bad uuid %q", c.DeviceID)
	}
	if c.DeviceName == "" || c.Approval != ApprovalAsk {
		t.Fatalf("defaults not filled: %+v", c)
	}
	var notified bool
	s.OnChange(func(old, new Config) { notified = old.AccountKey == "" && new.AccountKey == "sk-a" })
	err = s.Update(func(c *Config) error {
		c.RelayRoot = "https://relay.example.com"
		c.AccountKey = "sk-a"
		c.ClaudeKey = "sk-claude"
		c.Projects = append(c.Projects, protocol.Project{Path: "/tmp/x", Name: "x"})
		c.Autostart = true
		return nil
	})
	if err != nil || !notified {
		t.Fatalf("update err=%v notified=%v", err, notified)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(path)
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("perm %v", st.Mode().Perm())
		}
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	c2 := s2.Get()
	if c2.DeviceID != c.DeviceID || c2.AccountKey != "sk-a" || len(c2.Projects) != 1 || !c2.Autostart {
		t.Fatalf("round trip mismatch: %+v", c2)
	}
	if c2.EffectiveCodexKey() != "sk-a" || c2.EffectiveClaudeKey() != "sk-claude" {
		t.Fatal("effective keys")
	}
	if c2.EffectiveHubURL() != "https://relay.example.com/salcara-hub" {
		t.Fatal(c2.EffectiveHubURL())
	}
	// Get returns copies.
	c2.Projects[0].Name = "changed"
	if s2.Get().Projects[0].Name != "x" {
		t.Fatal("Get leaked internal slice")
	}
}

func TestNormalizeRelayRoot(t *testing.T) {
	cases := map[string]string{
		"https://a.com/":      "https://a.com",
		" https://a.com/v1/ ": "https://a.com",
		"a.com/V1":            "https://a.com",
		"http://1.2.3.4:8080": "http://1.2.3.4:8080",
		"":                    "",
	}
	for in, want := range cases {
		if got := NormalizeRelayRoot(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestProjectName(t *testing.T) {
	for in, want := range map[string]string{`C:\code\app`: "app", "/home/u/proj/": "proj", "/": "/"} {
		if got := ProjectName(in); got != want {
			t.Errorf("%q → %q", in, got)
		}
	}
}
