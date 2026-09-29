//go:build darwin

package autostart

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// Command is exec.Command (no console window concerns on macOS).
func Command(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }

func agentsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents")
}

func plistPath() string { return filepath.Join(agentsDir(), LaunchAgentLabel+".plist") }

func domain() string { return "gui/" + strconv.Itoa(os.Getuid()) }

// Enable writes ~/Library/LaunchAgents/top.salcara.bridge.plist. launchd loads every plist in that folder
// at the next login, so nothing has to be loaded now.
//
// Enable runs on every start (to follow the program if it was moved), and the running bridge may itself be
// this LaunchAgent's job: `launchctl unload`/`bootout` would SIGTERM it. So Enable never unloads — it only
// rewrites the file when the content changed, and clears a "disabled" override left by `launchctl disable`
// / `unload -w` so the agent really starts at the next login.
func Enable(exe string) error {
	removeLegacy()
	p := plistPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	content := []byte(LaunchAgentPlist(exe))
	if old, err := os.ReadFile(p); err != nil || !bytes.Equal(old, content) {
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, content, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, p); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	_ = exec.Command("launchctl", "enable", domain()+"/"+LaunchAgentLabel).Run()
	return nil
}

// Disable removes the plist so the bridge no longer starts at login. The running bridge is left alone
// (booting the job out would kill it when it was started by launchd).
func Disable() error {
	removeLegacy()
	err := os.Remove(plistPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// removeLegacy drops the 1.0.0 plist (com.salcara.bridge) so there is only one agent.
func removeLegacy() {
	old := filepath.Join(agentsDir(), legacyLaunchAgentLabel+".plist")
	if _, err := os.Stat(old); err == nil {
		_ = os.Remove(old)
	}
}

// Enabled reports whether the plist exists.
func Enabled() bool {
	_, err := os.Stat(plistPath())
	return err == nil
}

// OpenBrowser opens url in the default browser.
func OpenBrowser(url string) error { return exec.Command("open", url).Start() }

// OpenPath shows a file or folder in Finder.
func OpenPath(p string) error {
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return exec.Command("open", "-R", p).Start() // reveal the file
	}
	return exec.Command("open", p).Start()
}
