//go:build darwin

package main

import (
	"os"
	"os/exec"

	"salcara/bridge/internal/autostart"
	"salcara/bridge/internal/macapp"
)

// macStartup runs before anything else on macOS and returns true when this process should exit because
// a copy continues in its place:
//
//  1. Self-install: opened from ~/Downloads, a disk image or an App Translocation mount → copy the bundle
//     to ~/Applications/Salcara Bridge.app and start that copy. This happens in the first process, while
//     the (possibly translocated) source is certainly still mounted.
//  2. Detach from LaunchServices: an LSUIElement app has no window, so when it is already running a second
//     double-click in Finder only "activates" it and nothing visible happens. If LaunchServices started us
//     (parent is launchd, not --background, inside an .app), start a detached copy and quit at once: every
//     double-click then launches a fresh process, which opens the console of the running bridge.
func macStartup(background bool) bool {
	// The desktop shell owns its embedded Bridge process and window. Never
	// self-install or detach a child binary from inside the Electron bundle.
	if os.Getenv("SALCARA_EMBEDDED_WINDOW") == "1" {
		return false
	}
	if os.Getenv(macapp.EnvDetached) != "" {
		return false
	}
	exe := autostart.Executable()
	home, _ := os.UserHomeDir()
	if src, dst, ok := macapp.NeedsInstall(exe, home, os.TempDir()); ok {
		if err := macapp.Install(src, dst); err != nil {
			startupNotes = append(startupNotes, "install to ~/Applications failed: "+err.Error())
		} else {
			// Our copy carries no quarantine flag; clear it anyway in case the folder had one.
			_ = exec.Command("/usr/bin/xattr", "-dr", "com.apple.quarantine", dst).Run()
			if newExe, err := macapp.ExecutableIn(dst); err == nil {
				err := macapp.SpawnDetached(newExe, os.Args[1:], macapp.EnvDetached+"=1", macapp.EnvInstalledFrom+"="+src)
				if err == nil {
					return true
				}
				startupNotes = append(startupNotes, "start installed copy: "+err.Error())
			}
		}
	}
	if background || os.Getppid() != 1 || macapp.BundleOf(exe) == "" {
		return false
	}
	return macapp.SpawnDetached(exe, os.Args[1:], macapp.EnvDetached+"=1") == nil
}
