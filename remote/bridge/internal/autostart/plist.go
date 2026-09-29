package autostart

import (
	"html"
	"strings"

	"salcara/bridge/internal/macapp"
)

// LaunchAgentLabel is the macOS LaunchAgent label (and plist file name without .plist).
const LaunchAgentLabel = "top.salcara.bridge"

// legacyLaunchAgentLabel was used by 1.0.0 builds; Enable/Disable remove its plist.
const legacyLaunchAgentLabel = "com.salcara.bridge"

// BundleID is CFBundleIdentifier of "Salcara Bridge.app".
const BundleID = "top.salcara.bridge"

// LaunchAgentPlist renders the LaunchAgent that starts exe at login:
//
//   - RunAtLoad: start when the user logs in;
//   - KeepAlive.SuccessfulExit=false: restart after a crash, but not after "退出" in the console (exit 0);
//   - ThrottleInterval 60: at most one restart a minute (e.g. port taken by another program);
//   - LimitLoadToSessionType Aqua: only in the graphical login session (not for ssh logins);
//   - AssociatedBundleIdentifiers: macOS 13+ shows "Salcara Bridge" with its icon under
//     System Settings → General → Login Items instead of an anonymous binary.
func LaunchAgentPlist(exe string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + LaunchAgentLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + html.EscapeString(exe) + `</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
`)
	if macapp.BundleOf(exe) != "" {
		b.WriteString("  <key>AssociatedBundleIdentifiers</key><string>" + BundleID + "</string>\n")
	}
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}
