//go:build !windows && !darwin

package autostart

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Command is exec.Command.
func Command(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }

func desktopPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "autostart", "salcara-bridge.desktop")
}

func quoteExec(s string) string {
	if !strings.ContainsAny(s, " \t\"'\\$`") {
		return s
	}
	r := strings.NewReplacer(`\`, `\\\\`, `"`, `\\"`, "`", "\\\\`", "$", `\\$`)
	return `"` + r.Replace(s) + `"`
}

// Enable writes an XDG autostart entry.
func Enable(exe string) error {
	p := desktopPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	content := "[Desktop Entry]\nType=Application\nName=Salcara Bridge\nComment=Salcara 远程编程助手\n" +
		"Exec=" + quoteExec(exe) + " --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
	return os.WriteFile(p, []byte(content), 0o644)
}

// Disable removes the autostart entry.
func Disable() error {
	err := os.Remove(desktopPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Enabled reports whether the entry exists.
func Enabled() bool {
	_, err := os.Stat(desktopPath())
	return err == nil
}

// OpenBrowser opens url with xdg-open.
func OpenBrowser(url string) error { return exec.Command("xdg-open", url).Start() }

// OpenPath opens a folder (or a file's folder) in the file manager.
func OpenPath(p string) error {
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		p = filepath.Dir(p)
	}
	return exec.Command("xdg-open", p).Start()
}
