package macapp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNeedsInstall(t *testing.T) {
	home := "/Users/li"
	exe := func(b string) string { return filepath.Join(b, "Contents", "MacOS", Executable) }
	cases := []struct {
		bundle string
		want   bool
	}{
		{"/private/var/folders/x1/abc/T/AppTranslocation/1234-ABCD/d/Salcara Bridge.app", true},
		{"/Users/li/Downloads/Salcara Bridge.app", true},
		{"/Users/li/Downloads/SalcaraBridge-macos/Salcara Bridge.app", true},
		{"/Volumes/Salcara Bridge/Salcara Bridge.app", true},
		{"/private/tmp/x/Salcara Bridge.app", true},
		{"/Applications/Salcara Bridge.app", false},
		{"/Users/li/Applications/Salcara Bridge.app", false},
		{"/Users/li/Tools/Salcara Bridge.app", false}, // the user chose a place: respect it
	}
	for _, c := range cases {
		src, dst, ok := NeedsInstall(exe(c.bundle), home, "")
		if ok != c.want {
			t.Errorf("%s: ok=%v want %v", c.bundle, ok, c.want)
			continue
		}
		if ok && (src != c.bundle || dst != "/Users/li/Applications/Salcara Bridge.app") {
			t.Errorf("%s: src=%s dst=%s", c.bundle, src, dst)
		}
	}
	if _, _, ok := NeedsInstall("/Users/li/Downloads/SalcaraBridge-macos-arm64", home, ""); ok {
		t.Error("bare binary must not be installed as an app")
	}
}

func TestInstallCopiesBundle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix modes / symlinks")
	}
	root := t.TempDir()
	src := filepath.Join(root, "Downloads", AppName)
	macos := filepath.Join(src, "Contents", "MacOS")
	os.MkdirAll(macos, 0o755)
	os.MkdirAll(filepath.Join(src, "Contents", "Resources"), 0o755)
	os.WriteFile(filepath.Join(macos, Executable), []byte("#!/bin/sh\necho new\n"), 0o755)
	os.WriteFile(filepath.Join(src, "Contents", "Info.plist"), []byte("<plist/>"), 0o644)
	os.Symlink("../MacOS/"+Executable, filepath.Join(src, "Contents", "Resources", "link"))

	home := filepath.Join(root, "home")
	dst := InstallPath(home)
	// An older install is replaced.
	os.MkdirAll(filepath.Join(dst, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(dst, "Contents", "MacOS", Executable), []byte("old"), 0o755)
	os.WriteFile(filepath.Join(dst, "stale"), []byte("x"), 0o644)

	if err := Install(src, dst); err != nil {
		t.Fatal(err)
	}
	exe, err := ExecutableIn(dst)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(exe)
	if st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("exec bit lost: %v", st.Mode())
	}
	if b, _ := os.ReadFile(exe); string(b) != "#!/bin/sh\necho new\n" {
		t.Fatalf("content %q", b)
	}
	if l, err := os.Readlink(filepath.Join(dst, "Contents", "Resources", "link")); err != nil || l != "../MacOS/"+Executable {
		t.Fatalf("symlink %q %v", l, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "stale")); !os.IsNotExist(err) {
		t.Fatal("old install not replaced")
	}
	entries, _ := os.ReadDir(InstallDir(home))
	if len(entries) != 1 {
		t.Fatalf("leftovers in ~/Applications: %v", entries)
	}
	if err := Install(filepath.Join(root, "missing.app"), dst); err == nil {
		t.Fatal("missing source accepted")
	}
	if _, err := ExecutableIn(dst); err != nil {
		t.Fatal("failed install damaged the existing app")
	}
}
