// Command macbundle packages a (universal) macOS build of the bridge as "Salcara Bridge.app" inside a zip:
//
//	go run ./tools/macbundle -bin SalcaraBridge-macos-universal -version 1.1.0 -out SalcaraBridge-macos.zip
//
// Zip layout (unzip straight into ~/Applications or /Applications):
//
//	Salcara Bridge.app/Contents/Info.plist
//	Salcara Bridge.app/Contents/PkgInfo
//	Salcara Bridge.app/Contents/MacOS/SalcaraBridge        (mode 0755)
//	Salcara Bridge.app/Contents/Resources/AppIcon.icns
//
// Unix permissions are stored in the zip's external attributes (mode<<16, "made by" Unix), which Archive
// Utility, ditto and unzip all honour, so the executable bit survives. With -dir the bundle is also
// written to a folder (for inspection).
package main

import (
	"archive/zip"
	"bytes"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	appDir     = "Salcara Bridge.app"
	executable = "SalcaraBridge"
	bundleID   = "top.salcara.bridge"
)

func infoPlist(version string) string {
	kv := [][2]string{
		{"CFBundleDevelopmentRegion", "zh_CN"},
		{"CFBundleDisplayName", "Salcara Bridge"},
		{"CFBundleExecutable", executable},
		{"CFBundleIconFile", "AppIcon"},
		{"CFBundleIdentifier", bundleID},
		{"CFBundleInfoDictionaryVersion", "6.0"},
		{"CFBundleName", "Salcara Bridge"},
		{"CFBundlePackageType", "APPL"},
		{"CFBundleShortVersionString", version},
		{"CFBundleSignature", "????"},
		{"CFBundleVersion", version},
		{"LSApplicationCategoryType", "public.app-category.developer-tools"},
		{"LSMinimumSystemVersion", "11.0"},
		{"NSHumanReadableCopyright", "Salcara 远程编程助手"},
		// Shown in the macOS privacy prompts when Codex / Claude Code (started by the bridge) touch these.
		{"NSDocumentsFolderUsageDescription", "手机远程发起的 Codex / Claude Code 任务需要读写“文稿”里的项目文件。"},
		{"NSDesktopFolderUsageDescription", "手机远程发起的 Codex / Claude Code 任务需要读写“桌面”上的项目文件。"},
		{"NSDownloadsFolderUsageDescription", "手机远程发起的 Codex / Claude Code 任务需要读写“下载”里的项目文件。"},
		{"NSRemovableVolumesUsageDescription", "手机远程发起的任务需要读写移动硬盘上的项目文件。"},
		{"NSNetworkVolumesUsageDescription", "手机远程发起的任务需要读写网络磁盘上的项目文件。"},
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`)
	for _, p := range kv {
		fmt.Fprintf(&b, "\t<key>%s</key>\n\t<string>%s</string>\n", p[0], html.EscapeString(p[1]))
	}
	// LSUIElement: agent app — no Dock icon, no menu bar; the UI is the web console.
	b.WriteString("\t<key>LSUIElement</key>\n\t<true/>\n\t<key>NSHighResolutionCapable</key>\n\t<true/>\n</dict>\n</plist>\n")
	return b.String()
}

type entry struct {
	name string
	data []byte
	mode fs.FileMode
}

func bundleEntries(bin []byte, version string) ([]entry, error) {
	icon, err := icns()
	if err != nil {
		return nil, err
	}
	c := appDir + "/Contents/"
	return []entry{
		{appDir + "/", nil, fs.ModeDir | 0o755},
		{c, nil, fs.ModeDir | 0o755},
		{c + "Info.plist", []byte(infoPlist(version)), 0o644},
		{c + "PkgInfo", []byte("APPL????"), 0o644},
		{c + "MacOS/", nil, fs.ModeDir | 0o755},
		{c + "MacOS/" + executable, bin, 0o755},
		{c + "Resources/", nil, fs.ModeDir | 0o755},
		{c + "Resources/AppIcon.icns", icon, 0o644},
	}, nil
}

func writeZip(entries []entry) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mod := time.Now()
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Modified: mod}
		h.SetMode(e.mode) // external attrs = mode<<16, creator = Unix
		if e.mode.IsDir() {
			h.Method = zip.Store
		} else {
			h.Method = zip.Deflate
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			return nil, err
		}
		if len(e.data) > 0 {
			if _, err := w.Write(e.data); err != nil {
				return nil, err
			}
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeDir(root string, entries []entry) error {
	for _, e := range entries {
		p := filepath.Join(root, filepath.FromSlash(e.name))
		if e.mode.IsDir() {
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.WriteFile(p, e.data, e.mode.Perm()); err != nil {
			return err
		}
		if err := os.Chmod(p, e.mode.Perm()); err != nil {
			return err
		}
	}
	return nil
}

func main() {
	bin := flag.String("bin", "", "macOS executable (universal) to put in Contents/MacOS")
	version := flag.String("version", "1.0.0", "CFBundleShortVersionString")
	out := flag.String("out", "", "zip file to write")
	dir := flag.String("dir", "", "also write the .app into this folder")
	iconOut := flag.String("icon", "", "also write AppIcon.icns here")
	flag.Parse()
	if *bin == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: macbundle -bin EXE -version V -out ZIP [-dir DIR]")
		os.Exit(2)
	}
	b, err := os.ReadFile(*bin)
	if err != nil {
		fail(err)
	}
	entries, err := bundleEntries(b, *version)
	if err != nil {
		fail(err)
	}
	z, err := writeZip(entries)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(*out, z, 0o644); err != nil {
		fail(err)
	}
	if *dir != "" {
		if err := writeDir(*dir, entries); err != nil {
			fail(err)
		}
	}
	if *iconOut != "" {
		for _, e := range entries {
			if strings.HasSuffix(e.name, ".icns") {
				if err := os.WriteFile(*iconOut, e.data, 0o644); err != nil {
					fail(err)
				}
			}
		}
	}
	fmt.Printf("wrote %s (%d bytes, %s %s)\n", *out, len(z), appDir, *version)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "macbundle:", err)
	os.Exit(1)
}
