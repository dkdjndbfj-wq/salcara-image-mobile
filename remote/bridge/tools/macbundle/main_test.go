package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"image/png"
	"io"
	"strings"
	"testing"
)

func TestBundleZip(t *testing.T) {
	entries, err := bundleEntries([]byte("\xcf\xfa\xed\xfefake"), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	z, err := writeZip(entries)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(z), int64(len(z)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	exe := files["Salcara Bridge.app/Contents/MacOS/SalcaraBridge"]
	if exe == nil {
		t.Fatal("executable missing")
	}
	if exe.Mode().Perm() != 0o755 || exe.ExternalAttrs>>16 != 0o100755 || exe.CreatorVersion>>8 != 3 {
		t.Fatalf("exec bits: mode %v attrs %#o creator %d", exe.Mode(), exe.ExternalAttrs>>16, exe.CreatorVersion>>8)
	}
	if d := files["Salcara Bridge.app/Contents/MacOS/"]; d == nil || !d.Mode().IsDir() {
		t.Fatal("dir entry")
	}
	rc, _ := files["Salcara Bridge.app/Contents/Info.plist"].Open()
	plist, _ := io.ReadAll(rc)
	rc.Close()
	if err := xml.Unmarshal(plist, new(struct{})); err != nil {
		t.Fatalf("Info.plist not XML: %v", err)
	}
	for _, want := range []string{"<key>CFBundleIdentifier</key>\n\t<string>top.salcara.bridge</string>",
		"<key>CFBundleExecutable</key>\n\t<string>SalcaraBridge</string>", "<key>LSUIElement</key>\n\t<true/>",
		"<key>LSMinimumSystemVersion</key>\n\t<string>11.0</string>", "<string>1.2.3</string>"} {
		if !strings.Contains(string(plist), want) {
			t.Fatalf("Info.plist missing %q", want)
		}
	}
}

func TestIcns(t *testing.T) {
	b, err := icns()
	if err != nil {
		t.Fatal(err)
	}
	if string(b[:4]) != "icns" || int(binary.BigEndian.Uint32(b[4:8])) != len(b) {
		t.Fatal("bad icns header")
	}
	types := map[string]int{}
	for off := 8; off < len(b); {
		typ := string(b[off : off+4])
		n := int(binary.BigEndian.Uint32(b[off+4:]))
		img, err := png.Decode(bytes.NewReader(b[off+8 : off+n]))
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		types[typ] = img.Bounds().Dx()
		off += n
	}
	want := map[string]int{"ic07": 128, "ic08": 256, "ic09": 512, "ic10": 1024, "ic11": 32, "ic12": 64, "ic13": 256, "ic14": 512}
	for k, v := range want {
		if types[k] != v {
			t.Fatalf("%s = %d, want %d (%v)", k, types[k], v, types)
		}
	}
}

func TestRenderIcon(t *testing.T) {
	img := renderIcon(128)
	// corner transparent, centre of the tile's left edge gradient-blue, a point on the S white.
	if img.NRGBAAt(2, 2).A != 0 {
		t.Fatal("corner should be transparent")
	}
	c := img.NRGBAAt(24, 64)
	if c.A != 255 || c.B < 200 || c.R > 120 {
		t.Fatalf("tile colour %+v", c)
	}
	// (41.5,21.5) in logo space is the S's start point; a bit inside the stroke is white.
	polys := parsePath(logoS)
	if len(polys) != 1 || !inside(polys, 32, 43) || inside(polys, 10, 10) {
		t.Fatalf("path parse: %d polys", len(polys))
	}
}
