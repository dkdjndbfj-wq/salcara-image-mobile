//go:build !windows

package agents

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeExe(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

// launchdEnv simulates a LaunchAgent / Finder launch: bare PATH, a fresh HOME, no shell probe.
func launchdEnv(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	t.Setenv("NVM_DIR", "")
	t.Setenv(ShellPathEnv, "1")
	return home
}

func TestFindExecutableInWellKnownDirs(t *testing.T) {
	home := launchdEnv(t)
	writeExe(t, filepath.Join(home, ".npm-global", "bin", "codex"), "#!/bin/sh\necho 1.0\n")
	writeExe(t, filepath.Join(home, ".claude", "local", "claude"), "#!/bin/sh\necho 2.0\n")
	// not executable → must be skipped
	if err := os.MkdirAll(filepath.Join(home, ".bun", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(home, ".bun", "bin", "gemini"), []byte("x"), 0o644)

	if p, ok := findExecutable("codex", ""); !ok || p != filepath.Join(home, ".npm-global", "bin", "codex") {
		t.Fatalf("codex: %q %v", p, ok)
	}
	if p, ok := findExecutable("claude", ""); !ok || p != filepath.Join(home, ".claude", "local", "claude") {
		t.Fatalf("claude: %q %v", p, ok)
	}
	if _, ok := findExecutable("gemini", ""); ok {
		t.Fatal("non-executable file must not be found")
	}
	if _, ok := findExecutable("definitely-not-a-tool", ""); ok {
		t.Fatal("found a missing tool")
	}
}

func TestNvmOrderingAndDefaultAlias(t *testing.T) {
	home := launchdEnv(t)
	for _, v := range []string{"v9.11.2", "v18.19.0", "v20.11.1", "v20.9.0"} {
		writeExe(t, filepath.Join(home, ".nvm", "versions", "node", v, "bin", "node"), "#!/bin/sh\n")
	}
	dirs := nvmBinDirs(home)
	var got []string
	for _, d := range dirs {
		got = append(got, nodeVersionOf(d))
	}
	if strings.Join(got, ",") != "v20.11.1,v20.9.0,v18.19.0,v9.11.2" {
		t.Fatalf("order %v", got)
	}
	os.MkdirAll(filepath.Join(home, ".nvm", "alias"), 0o755)
	os.WriteFile(filepath.Join(home, ".nvm", "alias", "default"), []byte("18\n"), 0o644)
	if first := nodeVersionOf(nvmBinDirs(home)[0]); first != "v18.19.0" {
		t.Fatalf("default alias not preferred: %s", first)
	}
	writeExe(t, filepath.Join(home, ".nvm", "versions", "node", "v18.19.0", "bin", "claude"), "#!/bin/sh\n")
	if p, ok := findExecutable("claude", ""); !ok || !strings.Contains(p, "v18.19.0") {
		t.Fatalf("claude via nvm: %q %v", p, ok)
	}
}

// The core macOS bug: the tool is a `#!/usr/bin/env node` script and node lives in a different directory
// (Homebrew) than the tool (npm global prefix). The child must still find node.
func TestChildEnvFindsNodeForEnvShebang(t *testing.T) {
	home := launchdEnv(t)
	nodeDir := filepath.Join(home, ".volta", "bin")
	writeExe(t, filepath.Join(nodeDir, "node"), "#!/bin/sh\necho \"fake-node $1\"\n")
	tool := filepath.Join(home, ".npm-global", "bin", "codex")
	writeExe(t, tool, "#!/usr/bin/env node\n")

	env := childEnv(tool, map[string]string{"X_SET": "1"}, nil)
	var path string
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			if path != "" {
				t.Fatal("PATH set twice")
			}
			path = strings.TrimPrefix(kv, "PATH=")
		}
	}
	parts := filepath.SplitList(path)
	if len(parts) == 0 || parts[0] != filepath.Dir(tool) {
		t.Fatalf("tool dir not first: %s", path)
	}
	if !strings.Contains(path, nodeDir) || !strings.Contains(path, "/usr/bin") {
		t.Fatalf("PATH missing dirs: %s", path)
	}
	cmd := exec.Command(tool)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.HasPrefix(string(out), "fake-node "+tool) {
		t.Fatalf("env node shebang failed: %v %q", err, out)
	}
	// And without augmentation it fails, proving the test is meaningful.
	cmd = exec.Command(tool)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + home}
	if out, err := cmd.CombinedOutput(); err == nil && strings.HasPrefix(string(out), "fake-node") {
		t.Skip("a real node on /usr/bin shadows the fake; nothing to compare")
	}
}

func TestLoginShellProbe(t *testing.T) {
	dir := t.TempDir()
	shell := filepath.Join(dir, "fakesh")
	// Behaves like `zsh -ilc <script>` whose rc file prints a banner and sets PATH.
	writeExe(t, shell, "#!/bin/sh\necho 'Welcome to oh-my-zsh'\nPATH=/from/login/shell:/usr/bin:/bin\nexport PATH\n[ \"$1\" = -ilc ] || exit 3\neval \"$2\"\necho trailing-noise\n")
	if got := probeShellPath(shell, 3*time.Second); got != "/from/login/shell:/usr/bin:/bin" {
		t.Fatalf("probe = %q", got)
	}
	// A hanging rc file must not block longer than the timeout.
	hang := filepath.Join(dir, "hangsh")
	writeExe(t, hang, "#!/bin/sh\nsleep 30\n")
	start := time.Now()
	if got := probeShellPath(hang, 300*time.Millisecond); got != "" {
		t.Fatalf("hang probe = %q", got)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("probe took %v", d)
	}
	if probeShellPath("relative-sh", time.Second) != "" {
		t.Fatal("relative shell accepted")
	}
}

func TestParseProbe(t *testing.T) {
	out := "banner PATH=/nope\n" + probeBegin + "\nHOME=/h\nPATH=/a:/b\nX=1\n" + probeEnd + "\n"
	if got := parseProbe(out); got != "/a:/b" {
		t.Fatalf("%q", got)
	}
	if parseProbe("no markers PATH=/x") != "" || parseProbe(probeBegin+"\nPATH=/x\n") != "" {
		t.Fatal("parsed without both markers")
	}
}

func TestSearchPathOrderAndDedupe(t *testing.T) {
	home := launchdEnv(t)
	os.MkdirAll(filepath.Join(home, ".bun", "bin"), 0o755)
	t.Setenv("PATH", "/usr/bin:relative/dir::/bin:/usr/bin")
	p := SearchPath()
	parts := filepath.SplitList(p)
	if parts[0] != "/usr/bin" || parts[1] != "/bin" {
		t.Fatalf("own PATH should come first: %v", parts)
	}
	seen := map[string]bool{}
	for _, d := range parts {
		if seen[d] || !filepath.IsAbs(d) {
			t.Fatalf("bad entry %q in %v", d, parts)
		}
		seen[d] = true
	}
	if !seen[filepath.Join(home, ".bun", "bin")] {
		t.Fatalf("bun dir missing: %v", parts)
	}
	if seen[filepath.Join(home, ".volta", "bin")] {
		t.Fatal("non-existing dir included")
	}
}
