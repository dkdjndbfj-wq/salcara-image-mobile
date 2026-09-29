// Package macapp handles "Salcara Bridge.app" on macOS: installing itself into ~/Applications when it was
// opened from a place that is not a stable home (Downloads, a mounted disk image, or a Gatekeeper
// "App Translocation" mount), and relaunching detached from LaunchServices.
//
// Why: autostart must point at a path that still exists after a reboot. A translocated app runs from a
// random read-only mount (/private/var/folders/…/AppTranslocation/<uuid>/d/…) that disappears, and
// ~/Downloads gets cleaned up. ~/Applications needs no administrator password.
//
// The logic is plain path/file handling so it is tested on every OS; only main calls it on darwin.
package macapp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// AppName is the bundle directory name.
const AppName = "Salcara Bridge.app"

// Executable is CFBundleExecutable (Contents/MacOS/<Executable>).
const Executable = "SalcaraBridge"

// EnvInstalledFrom is set on the relaunched copy so the console can say where it came from.
const EnvInstalledFrom = "SALCARA_INSTALLED_FROM"

// EnvDetached marks a process that was already relaunched (never detach or install twice).
const EnvDetached = "SALCARA_DETACHED"

// InstallDir is ~/Applications.
func InstallDir(home string) string { return filepath.Join(home, "Applications") }

// InstallPath is ~/Applications/Salcara Bridge.app.
func InstallPath(home string) string { return filepath.Join(InstallDir(home), AppName) }

// BundleOf returns the enclosing "*.app" of exe (<X.app>/Contents/MacOS/<exe>), or "".
func BundleOf(exe string) string {
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	app := filepath.Dir(contents)
	if filepath.Base(macos) == "MacOS" && filepath.Base(contents) == "Contents" && strings.HasSuffix(strings.ToLower(app), ".app") {
		return app
	}
	return ""
}

func under(p, dir string) bool {
	if dir == "" {
		return false
	}
	dir = filepath.Clean(dir)
	p = filepath.Clean(p)
	return p == dir || strings.HasPrefix(p, dir+string(filepath.Separator))
}

// Transient reports whether a bundle path is somewhere autostart must not point to, with a short reason.
func Transient(bundle, home, tmp string) (string, bool) {
	lower := strings.ToLower(bundle)
	switch {
	case strings.Contains(bundle, "/AppTranslocation/"):
		return "translocated", true // Gatekeeper's random read-only copy
	case under(bundle, "/Volumes"):
		return "volume", true // opened straight from a .dmg or USB stick
	case home != "" && under(lower, strings.ToLower(filepath.Join(home, "Downloads"))):
		return "downloads", true
	case under(bundle, "/private/var/folders"), under(bundle, "/var/folders"), under(bundle, "/tmp"), under(bundle, "/private/tmp"):
		return "temp", true // e.g. opened from inside an archive viewer
	case tmp != "" && under(bundle, tmp):
		return "temp", true
	}
	return "", false
}

// NeedsInstall decides whether the running bundle should copy itself to ~/Applications. It returns the
// source bundle and the destination. Bundles already in /Applications or ~/Applications stay put, and so
// does anything that isn't an app bundle (a bare binary run from Terminal).
func NeedsInstall(exe, home, tmp string) (src, dst string, ok bool) {
	src = BundleOf(exe)
	if src == "" || home == "" {
		return "", "", false
	}
	if under(src, "/Applications") || under(src, InstallDir(home)) {
		return "", "", false
	}
	if _, transient := Transient(src, home, tmp); !transient {
		return "", "", false
	}
	return src, InstallPath(home), true
}

// Install copies the bundle src to dst atomically: into a sibling temp folder first, then swapped in, so a
// failed copy never leaves a half-written app. Modes (the executable bit) and symlinks are preserved;
// extended attributes are not copied, so the copy carries no com.apple.quarantine flag.
func Install(src, dst string) error {
	if st, err := os.Stat(src); err != nil || !st.IsDir() {
		return fmt.Errorf("找不到程序包：%s", src)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".salcara-new-" + randHex()
	if err := copyTree(src, tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return fmt.Errorf("复制到 %s 失败：%w", filepath.Dir(dst), err)
	}
	var old string
	if _, err := os.Lstat(dst); err == nil {
		old = dst + ".salcara-old-" + randHex()
		if err := os.Rename(dst, old); err != nil {
			_ = os.RemoveAll(tmp)
			return fmt.Errorf("无法替换旧版本：%w", err)
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		if old != "" {
			_ = os.Rename(old, dst)
		}
		_ = os.RemoveAll(tmp)
		return err
	}
	if old != "" {
		_ = os.RemoveAll(old)
	}
	return nil
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case info.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case info.Mode().IsRegular():
			return copyFile(p, target, info.Mode().Perm())
		}
		return nil // sockets, devices: nothing sensible to copy
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, mode) // umask may have stripped bits
}

func randHex() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ErrNotBundle is returned by ExecutableIn for a folder that isn't a Salcara Bridge bundle.
var ErrNotBundle = errors.New("不是 Salcara Bridge 程序包")

// ExecutableIn returns <bundle>/Contents/MacOS/SalcaraBridge if it exists.
func ExecutableIn(bundle string) (string, error) {
	p := filepath.Join(bundle, "Contents", "MacOS", Executable)
	if st, err := os.Stat(p); err != nil || !st.Mode().IsRegular() {
		return "", ErrNotBundle
	}
	return p, nil
}
