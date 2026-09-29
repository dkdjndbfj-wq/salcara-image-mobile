// Package autostart registers the bridge to start at login and opens URLs in the default browser.
//
//   - Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run  "SalcaraBridge" = "<exe>" --background
//   - macOS:   ~/Library/LaunchAgents/top.salcara.bridge.plist (loaded by launchd at login)
//   - Linux:   ~/.config/autostart/salcara-bridge.desktop
package autostart

import (
	"os"
	"path/filepath"
)

// AppName is the registry value / file base name.
const AppName = "SalcaraBridge"

// Executable returns the absolute path of the running binary (symlinks resolved).
func Executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		return r
	}
	return exe
}
