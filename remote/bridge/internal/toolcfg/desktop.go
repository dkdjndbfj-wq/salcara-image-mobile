package toolcfg

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"salcara/bridge/internal/protocol"
)

// DetectClaudeDesktop looks for the Claude desktop app. Its third-party inference is configured inside the app
// (Developer → Configure Third-Party Inference), so we only report whether it is installed.
func DetectClaudeDesktop() protocol.Tool {
	t := protocol.Tool{ID: "claude-desktop", Name: "Claude Desktop"}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		// Squirrel installer: %LOCALAPPDATA%\AnthropicClaude\app-<version>\claude.exe
		root := filepath.Join(local, "AnthropicClaude")
		if entries, err := os.ReadDir(root); err == nil {
			var versions []string
			for _, e := range entries {
				if e.IsDir() && strings.HasPrefix(e.Name(), "app-") {
					versions = append(versions, strings.TrimPrefix(e.Name(), "app-"))
				}
			}
			sort.Strings(versions)
			if len(versions) > 0 {
				t.Available, t.Version = true, versions[len(versions)-1]
				return t
			}
			if exists(filepath.Join(root, "claude.exe")) {
				t.Available = true
				return t
			}
		}
		for _, p := range []string{
			filepath.Join(local, "Programs", "Claude", "Claude.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "Claude", "Claude.exe"),
		} {
			if exists(p) {
				t.Available = true
				return t
			}
		}
		// MSIX install: the package folder is not listable, but the app writes its config under %APPDATA%\Claude.
		if appdata := os.Getenv("APPDATA"); appdata != "" && exists(filepath.Join(appdata, "Claude", "config.json")) {
			t.Available = true
		}
	case "darwin":
		for _, app := range []string{"/Applications/Claude.app", filepath.Join(home, "Applications", "Claude.app")} {
			if exists(app) {
				t.Available = true
				t.Version = plistVersion(filepath.Join(app, "Contents", "Info.plist"))
				return t
			}
		}
		// Installed elsewhere (e.g. a custom folder): the app keeps its settings here.
		if exists(filepath.Join(ClaudeDesktopConfigDir(), "config.json")) || exists(filepath.Join(ClaudeDesktopConfigDir(), "claude_desktop_config.json")) {
			t.Available = true
		}
	default:
		if exists(filepath.Join(ClaudeDesktopConfigDir(), "claude_desktop_config.json")) {
			t.Available = true
		}
	}
	return t
}

// ClaudeDesktopConfigDir is where Claude Desktop keeps its settings:
// macOS ~/Library/Application Support/Claude, Windows %APPDATA%\Claude, Linux ~/.config/Claude.
func ClaudeDesktopConfigDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Claude")
	case "windows":
		if a := os.Getenv("APPDATA"); a != "" {
			return filepath.Join(a, "Claude")
		}
		return filepath.Join(home, "AppData", "Roaming", "Claude")
	default:
		if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
			return filepath.Join(x, "Claude")
		}
		return filepath.Join(home, ".config", "Claude")
	}
}

var plistVersionRe = regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>`)

func plistVersion(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if m := plistVersionRe.FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return ""
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
