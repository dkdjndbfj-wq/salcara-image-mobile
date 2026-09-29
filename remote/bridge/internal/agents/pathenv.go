package agents

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// On macOS a LaunchAgent or a Finder-launched app starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, and on
// Linux an XDG autostart entry often gets a similarly bare PATH. Codex and Claude Code are usually installed
// by Homebrew, npm (global prefix, nvm, volta, fnm, asdf…) or bun, and the npm builds are node scripts
// (`#!/usr/bin/env node`), so node itself must be on the child's PATH too. The bridge therefore searches,
// and hands its children, an augmented PATH:
//
//  1. the PATH of the user's login shell ($SHELL -ilc, 3s timeout, once per run) — the user's real PATH;
//  2. the bridge's own PATH;
//  3. well-known install locations that exist on disk.
//
// Windows is untouched: GUI programs there inherit the full user PATH, and npm shims are handled separately.

// ShellPathEnv disables the login-shell probe when set to "1" (tests, or a user whose shell rc misbehaves).
const ShellPathEnv = "SALCARA_NO_SHELL_PATH"

const shellProbeTimeout = 3 * time.Second

var (
	shellPathOnce sync.Once
	shellPathVal  string
)

// loginShellPath returns the PATH printed by the user's login shell ("" if unavailable). Cached per run.
func loginShellPath() string {
	if runtime.GOOS == "windows" || os.Getenv(ShellPathEnv) == "1" {
		return ""
	}
	shellPathOnce.Do(func() {
		shellPathVal = probeShellPath(os.Getenv("SHELL"), shellProbeTimeout)
	})
	return shellPathVal
}

const (
	probeBegin = "__SALCARA_ENV_BEGIN__"
	probeEnd   = "__SALCARA_ENV_END__"
)

// probeShellPath runs `<shell> -ilc 'echo BEGIN; /usr/bin/env; echo END'` and extracts PATH. Using env(1)
// instead of `echo $PATH` works in fish too (fish exports list variables colon-joined). Interactive rc files
// may print banners, so only the text between the markers is parsed.
func probeShellPath(shell string, timeout time.Duration) string {
	if shell == "" {
		if runtime.GOOS == "darwin" {
			shell = "/bin/zsh"
		} else {
			shell = "/bin/sh"
		}
	}
	if !filepath.IsAbs(shell) {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	script := "echo " + probeBegin + "; /usr/bin/env; echo " + probeEnd
	cmd := exec.CommandContext(ctx, shell, "-ilc", script)
	prepareCmd(cmd) // own process group: a timeout kills rc-file children too
	cmd.Cancel = func() error { killTree(cmd); return nil }
	cmd.WaitDelay = time.Second
	cmd.Stdin = nil // /dev/null: an interactive shell must not wait for input
	cmd.Env = append(os.Environ(), "TERM=dumb", "SALCARA_SHELL_PROBE=1")
	var out bytes.Buffer
	cmd.Stdout = &out
	_ = cmd.Run() // rc files may exit non-zero after printing; the markers decide
	return parseProbe(out.String())
}

// parseProbe extracts PATH=… from the env output between the markers.
func parseProbe(out string) string {
	i := strings.LastIndex(out, probeBegin)
	if i < 0 {
		return ""
	}
	body := out[i+len(probeBegin):]
	j := strings.Index(body, probeEnd)
	if j < 0 {
		return ""
	}
	for _, line := range strings.Split(body[:j], "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "PATH=") {
			return strings.TrimPrefix(line, "PATH=")
		}
	}
	return ""
}

// extraBinDirs lists well-known tool/node locations under home (only those that exist).
func extraBinDirs(home string) []string {
	var dirs []string
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".claude", "local"), // Claude Code "local" install: ~/.claude/local/claude
			filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, ".npm", "bin"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".volta", "bin"),
			filepath.Join(home, ".asdf", "shims"),
			filepath.Join(home, ".local", "share", "mise", "shims"),
			filepath.Join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
			filepath.Join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin"),
			filepath.Join(home, ".fnm", "aliases", "default", "bin"),
			filepath.Join(home, "Library", "pnpm"),
			filepath.Join(home, ".local", "share", "pnpm"),
			filepath.Join(home, ".yarn", "bin"),
			filepath.Join(home, "n", "bin"),
			filepath.Join(home, ".cargo", "bin"),
		)
		dirs = append(dirs, nvmBinDirs(home)...)
	}
	dirs = append(dirs,
		"/opt/homebrew/bin", "/opt/homebrew/sbin", // Homebrew on Apple silicon
		"/usr/local/bin", "/usr/local/sbin", // Homebrew on Intel, official node .pkg
		"/opt/local/bin", // MacPorts
		"/home/linuxbrew/.linuxbrew/bin",
		"/snap/bin",
	)
	out := dirs[:0]
	for _, d := range dirs {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			out = append(out, d)
		}
	}
	return out
}

// nvmBinDirs returns ~/.nvm/versions/node/*/bin, the nvm default alias first, then newest version first.
func nvmBinDirs(home string) []string {
	root := os.Getenv("NVM_DIR")
	if root == "" {
		root = filepath.Join(home, ".nvm")
	}
	matches, _ := filepath.Glob(filepath.Join(root, "versions", "node", "*", "bin"))
	if len(matches) == 0 {
		return nil
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return versionLess(nodeVersionOf(matches[j]), nodeVersionOf(matches[i]))
	})
	// `nvm alias default 20` → prefer the newest v20.x.
	if b, err := os.ReadFile(filepath.Join(root, "alias", "default")); err == nil {
		want := strings.TrimPrefix(strings.TrimSpace(string(b)), "v")
		if want != "" && !strings.Contains(want, "/") && want != "node" && want != "stable" {
			for i, m := range matches {
				v := strings.TrimPrefix(nodeVersionOf(m), "v")
				if v == want || strings.HasPrefix(v, want+".") {
					return append([]string{m}, append(append([]string{}, matches[:i]...), matches[i+1:]...)...)
				}
			}
		}
	}
	return matches
}

func nodeVersionOf(binDir string) string { return filepath.Base(filepath.Dir(binDir)) }

// versionLess compares "v20.11.0"-style versions numerically (non-numeric parts compare as 0).
func versionLess(a, b string) bool {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// joinPathLists merges PATH-style lists, keeping the first occurrence of each directory and dropping
// empty and relative entries (a relative PATH entry would resolve against the child's cwd).
func joinPathLists(lists ...[]string) string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, d := range l {
			if d == "" || !filepath.IsAbs(d) {
				continue
			}
			d = filepath.Clean(d)
			if seen[d] {
				continue
			}
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, string(os.PathListSeparator))
}

func splitPath(p string) []string {
	if p == "" {
		return nil
	}
	return filepath.SplitList(p)
}

// SearchPath is the PATH the bridge uses to find tools and gives its children. On Windows it is $PATH.
func SearchPath() string {
	if runtime.GOOS == "windows" {
		return os.Getenv("PATH")
	}
	home, _ := os.UserHomeDir()
	return joinPathLists(splitPath(loginShellPath()), splitPath(os.Getenv("PATH")), extraBinDirs(home))
}

// lookPathIn finds an executable regular file called name in the PATH-style list dirs.
func lookPathIn(name, dirs string) (string, bool) {
	for _, d := range splitPath(dirs) {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0 {
			return p, true
		}
	}
	return "", false
}
