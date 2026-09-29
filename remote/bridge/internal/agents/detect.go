package agents

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// candidatePaths lists well-known install locations tried after PATH on Windows (npm shims live in
// %APPDATA%\npm and the bridge may start at login before PATH is complete). On macOS / Linux the same job is
// done by SearchPath (pathenv.go), plus a few app-bundle locations that are not bin directories.
func candidatePaths(name string) []string {
	home, _ := os.UserHomeDir()
	var out []string
	if runtime.GOOS == "windows" {
		appdata := os.Getenv("APPDATA")
		local := os.Getenv("LOCALAPPDATA")
		if appdata == "" && home != "" {
			appdata = filepath.Join(home, "AppData", "Roaming")
		}
		if local == "" && home != "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		for _, dir := range []string{
			filepath.Join(home, ".local", "bin"),
			filepath.Join(appdata, "npm"),
			filepath.Join(local, "Programs", name),
			filepath.Join(local, "Microsoft", "WinGet", "Links"),
			filepath.Join(home, "scoop", "shims"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".volta", "bin"),
		} {
			if dir == "" {
				continue
			}
			out = append(out, filepath.Join(dir, name+".exe"), filepath.Join(dir, name+".cmd"))
		}
		return out
	}
	if runtime.GOOS == "darwin" && name == "codex" {
		// The Codex desktop app ships its own CLI inside the bundle (location not guaranteed; checked last).
		for _, app := range []string{"/Applications/Codex.app", filepath.Join(home, "Applications", "Codex.app")} {
			out = append(out,
				filepath.Join(app, "Contents", "Resources", "codex"),
				filepath.Join(app, "Contents", "Resources", "bin", "codex"),
				filepath.Join(app, "Contents", "MacOS", "codex"))
		}
	}
	return out
}

// findExecutable resolves a tool: explicit override, PATH, then the well-known locations.
func findExecutable(name, override string) (string, bool) {
	if override != "" {
		if st, err := os.Stat(override); err == nil && !st.IsDir() {
			return override, true
		}
		if p, err := exec.LookPath(override); err == nil {
			return p, true
		}
		if runtime.GOOS != "windows" && !strings.ContainsRune(override, '/') {
			if p, ok := lookPathIn(override, SearchPath()); ok {
				return p, true
			}
		}
		return "", false
	}
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath(name); err == nil {
			if abs, err := filepath.Abs(p); err == nil {
				p = abs
			}
			return p, true
		}
	} else if p, ok := lookPathIn(name, SearchPath()); ok {
		return p, true
	}
	for _, c := range candidatePaths(name) {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, true
		}
	}
	return "", false
}

// nativeCodexExe finds the real codex.exe behind an npm codex.cmd shim on Windows, so arguments are
// not re-parsed by cmd.exe. Returns "" if not found.
func nativeCodexExe(shim string) string {
	if !strings.EqualFold(filepath.Ext(shim), ".cmd") {
		return ""
	}
	base := filepath.Join(filepath.Dir(shim), "node_modules", "@openai")
	for _, pattern := range []string{
		filepath.Join(base, "codex", "vendor", "*", "codex", "codex.exe"),
		filepath.Join(base, "codex", "node_modules", "@openai", "codex-win32-*", "vendor", "*", "codex", "codex.exe"),
		filepath.Join(base, "codex-win32-*", "vendor", "*", "codex", "codex.exe"),
	} {
		if m, _ := filepath.Glob(pattern); len(m) > 0 {
			arch := "x86_64"
			if runtime.GOARCH == "arm64" {
				arch = "aarch64"
			}
			for _, p := range m {
				if strings.Contains(p, arch) {
					return p
				}
			}
			return m[0]
		}
	}
	return ""
}

var versionRe = regexp.MustCompile(`\d+\.\d+(\.\d+)?([\-+.][0-9A-Za-z.\-]+)?`)

type versionCacheEntry struct {
	mod     time.Time
	version string
	ok      bool
}

var (
	versionMu    sync.Mutex
	versionCache = map[string]versionCacheEntry{}
)

// toolVersion runs `<exe> --version` (cached per binary mtime). ok=false if it doesn't run.
func toolVersion(ctx context.Context, exe string) (string, bool) {
	st, err := os.Stat(exe)
	if err != nil {
		return "", false
	}
	versionMu.Lock()
	if e, hit := versionCache[exe]; hit && e.mod.Equal(st.ModTime()) {
		versionMu.Unlock()
		return e.version, e.ok
	}
	versionMu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--version")
	prepareCmd(cmd)
	cmd.Env = childEnv(exe, nil, nil)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err = cmd.Run()
	text := strings.TrimSpace(out.String())
	ok := err == nil
	v := ""
	if line, _, _ := strings.Cut(text, "\n"); line != "" {
		v = versionRe.FindString(line)
		if v == "" {
			v = truncHead(line, 40)
		}
	}
	if ctx.Err() == nil { // don't cache timeouts
		versionMu.Lock()
		versionCache[exe] = versionCacheEntry{mod: st.ModTime(), version: v, ok: ok}
		versionMu.Unlock()
	}
	return v, ok
}

// childEnv builds a child environment: the bridge's env minus `drop`, plus `set`, with PATH = the tool's own
// directory + SearchPath() (npm-installed tools are `#!/usr/bin/env node` scripts, so node must be findable
// even when the bridge was started by launchd with a bare PATH). On Windows PATH is the bridge's PATH with
// the tool's directory prepended.
func childEnv(exe string, set map[string]string, drop []string) []string {
	env := os.Environ()
	out := make([]string, 0, len(env)+len(set)+1)
	skip := func(k string) bool {
		for _, d := range drop {
			if strings.EqualFold(k, d) {
				return true
			}
		}
		for s := range set {
			if strings.EqualFold(k, s) {
				return true
			}
		}
		return false
	}
	pathKey := "PATH"
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if strings.EqualFold(k, "PATH") {
			pathKey = k // keep Windows' "Path" spelling
			continue
		}
		if skip(k) {
			continue
		}
		out = append(out, kv)
	}
	var first []string
	if exe != "" {
		first = []string{filepath.Dir(exe)}
	}
	var path string
	if runtime.GOOS == "windows" {
		path = strings.Join(append(first, splitPath(os.Getenv("PATH"))...), string(os.PathListSeparator))
	} else {
		path = joinPathLists(first, splitPath(SearchPath()))
	}
	if _, overridden := set["PATH"]; !overridden {
		out = append(out, pathKey+"="+path)
	}
	for k, v := range set {
		out = append(out, k+"="+v)
	}
	return out
}
