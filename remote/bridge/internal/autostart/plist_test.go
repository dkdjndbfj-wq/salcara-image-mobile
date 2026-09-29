package autostart

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestLaunchAgentPlist(t *testing.T) {
	exe := "/Users/li <&> x/Applications/Salcara Bridge.app/Contents/MacOS/SalcaraBridge"
	p := LaunchAgentPlist(exe)
	// Must be well-formed XML with the path escaped.
	dec := xml.NewDecoder(strings.NewReader(p))
	dec.Strict = true
	var strs []string
	inString := false
	for {
		tok, err := dec.Token()
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			t.Fatalf("invalid XML: %v\n%s", err, p)
		}
		switch v := tok.(type) {
		case xml.StartElement:
			inString = v.Name.Local == "string"
		case xml.CharData:
			if inString {
				strs = append(strs, string(v))
			}
		case xml.EndElement:
			inString = false
		}
	}
	want := []string{LaunchAgentLabel, exe, "--background", "Aqua", "Interactive", BundleID}
	if strings.Join(strs, "|") != strings.Join(want, "|") {
		t.Fatalf("strings %q", strs)
	}
	for _, s := range []string{"<key>RunAtLoad</key><true/>", "<key>SuccessfulExit</key><false/>", "<key>ThrottleInterval</key>"} {
		if !strings.Contains(p, s) {
			t.Fatalf("missing %s", s)
		}
	}
	if strings.Contains(LaunchAgentPlist("/usr/local/bin/SalcaraBridge"), "AssociatedBundleIdentifiers") {
		t.Fatal("bare binary must not claim the bundle id")
	}
}
