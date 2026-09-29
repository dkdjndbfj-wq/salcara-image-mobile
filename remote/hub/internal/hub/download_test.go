package hub

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const scriptTpl = "#!/bin/bash\nHUB=\"{{SALCARA_BASE_URL}}\"\nRELAY=\"{{SALCARA_RELAY_URL}}\"\n"

func downloadsEnv(t *testing.T, mod func(*Config)) (*env, string) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "install-mac.sh"), []byte(scriptTpl), 0o644)
	os.WriteFile(filepath.Join(dir, "install-windows.ps1"), []byte("$Hub = '{{SALCARA_BASE_URL}}'\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "SalcaraBridge-macos.zip"), []byte("PK\x03\x04zipdata"), 0o644)
	os.WriteFile(filepath.Join(dir, ".hidden"), []byte("secret"), 0o644)
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "x.zip"), []byte("nested"), 0o644)
	secret := filepath.Join(t.TempDir(), "devices.json")
	os.WriteFile(secret, []byte(`{"secret":true}`), 0o600)
	os.Symlink(secret, filepath.Join(dir, "link.zip"))
	e := newEnv(t, func(c *Config) {
		c.DownloadsDir = dir
		if mod != nil {
			mod(c)
		}
	})
	return e, dir
}

func (e *env) get(path string, hdr map[string]string) (int, http.Header, string) {
	e.t.Helper()
	req, _ := http.NewRequest("GET", e.srv.URL+path, nil)
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(b)
}

func TestDownloadServesFiles(t *testing.T) {
	e, _ := downloadsEnv(t, nil)
	for _, p := range []string{"/salcara-hub/download/SalcaraBridge-macos.zip", "/download/SalcaraBridge-macos.zip"} {
		code, h, body := e.get(p, nil)
		if code != 200 || body != "PK\x03\x04zipdata" {
			t.Fatalf("%s: %d %q", p, code, body)
		}
		if h.Get("Content-Type") != "application/zip" || !strings.HasPrefix(h.Get("Content-Disposition"), "attachment") {
			t.Fatalf("%s headers %v", p, h)
		}
	}
	// no auth needed, HEAD works, ranges work (resumable downloads)
	req, _ := http.NewRequest("HEAD", e.srv.URL+"/salcara-hub/download/SalcaraBridge-macos.zip", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 || resp.ContentLength != 11 {
		t.Fatalf("HEAD %v %+v", err, resp)
	}
	resp.Body.Close()
	code, _, body := e.get("/salcara-hub/download/SalcaraBridge-macos.zip", map[string]string{"Range": "bytes=4-"})
	if code != http.StatusPartialContent || body != "zipdata" {
		t.Fatalf("range %d %q", code, body)
	}
	if code := e.do("POST", "/salcara-hub/download/SalcaraBridge-macos.zip", "", nil, nil); code != http.StatusMethodNotAllowed {
		t.Fatalf("POST %d", code)
	}
}

func TestDownloadRejectsTraversal(t *testing.T) {
	e, _ := downloadsEnv(t, nil)
	bad := []string{
		"/salcara-hub/download/",
		"/salcara-hub/download/.hidden",
		"/salcara-hub/download/sub/x.zip",
		"/salcara-hub/download/sub",
		"/salcara-hub/download/link.zip", // symlink out of the folder
		"/salcara-hub/download/missing.zip",
		"/salcara-hub/download/..%2fdevices.json",
		"/salcara-hub/download/%2e%2e%2fdevices.json",
		"/salcara-hub/download/..%5cdevices.json",
		"/salcara-hub/download/a%00.zip",
		"/download/..",
	}
	for _, p := range bad {
		code, _, body := e.get(p, nil)
		if code == 200 || strings.Contains(body, "secret") || strings.Contains(body, "nested") {
			t.Errorf("%s: %d %q", p, code, body)
		}
	}
	// Raw ".." segments that a client doesn't clean up itself.
	conn, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /salcara-hub/download/../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	raw, _ := io.ReadAll(conn)
	if strings.HasPrefix(string(raw), "HTTP/1.1 200") || strings.Contains(string(raw), "root:") {
		t.Fatalf("raw traversal: %s", raw)
	}
}

func TestDownloadDisabled(t *testing.T) {
	e := newEnv(t, nil)
	if code, _, _ := e.get("/salcara-hub/download/install-mac.sh", nil); code != 404 {
		t.Fatalf("%d", code)
	}
}

func TestInstallScriptTemplating(t *testing.T) {
	e, _ := downloadsEnv(t, nil)
	// Direct: base from Host; X-Forwarded-* ignored without TrustProxy.
	code, h, body := e.get("/salcara-hub/download/install-mac.sh", map[string]string{
		"Host": "relay.example.com", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example"})
	if code != 200 || !strings.Contains(body, `HUB="http://relay.example.com/salcara-hub"`) || !strings.Contains(body, `RELAY="http://relay.example.com"`) {
		t.Fatalf("%d %q", code, body)
	}
	if !strings.HasPrefix(h.Get("Content-Type"), "text/x-shellscript") || h.Get("Cache-Control") != "no-cache" {
		t.Fatalf("headers %v", h)
	}
	// Prefix-less path → no prefix in the base.
	_, _, body = e.get("/download/install-mac.sh", map[string]string{"Host": "127.0.0.1:8787"})
	if !strings.Contains(body, `HUB="http://127.0.0.1:8787"`) {
		t.Fatalf("%q", body)
	}
	// Hostile Host header must never reach the script.
	code, _, body = e.get("/salcara-hub/download/install-mac.sh", map[string]string{"Host": "a.com\";rm -rf ~;\""})
	if code == 200 || strings.Contains(body, "rm -rf") {
		t.Fatalf("injection: %d %q", code, body)
	}
}

func TestInstallScriptBehindProxy(t *testing.T) {
	e, _ := downloadsEnv(t, func(c *Config) { c.TrustProxy = true })
	hdr := map[string]string{"Host": "127.0.0.1:8787", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "relay.example.com, inner"}
	_, _, body := e.get("/salcara-hub/download/install-mac.sh", hdr)
	if !strings.Contains(body, `HUB="https://relay.example.com/salcara-hub"`) || !strings.Contains(body, `RELAY="https://relay.example.com"`) {
		t.Fatalf("%q", body)
	}
	// nginx stripping the prefix: X-Forwarded-Prefix restores it.
	hdr["X-Forwarded-Prefix"] = "/salcara-hub/"
	_, _, body = e.get("/download/install-windows.ps1", hdr)
	if body != "$Hub = 'https://relay.example.com/salcara-hub'\n" {
		t.Fatalf("%q", body)
	}
	for _, bad := range []map[string]string{
		{"X-Forwarded-Proto": "javascript"},
		{"X-Forwarded-Host": "x.com/$(id)"},
		{"X-Forwarded-Prefix": "/a b"},
	} {
		code, _, body := e.get("/download/install-mac.sh", bad)
		if code != 400 || strings.Contains(body, "$(id)") {
			t.Fatalf("%v → %d %q", bad, code, body)
		}
	}
}

func TestInstallScriptPublicURL(t *testing.T) {
	e, _ := downloadsEnv(t, func(c *Config) { c.PublicURL = "https://r.example.com/salcara-hub/"; c.TrustProxy = true })
	_, _, body := e.get("/salcara-hub/download/install-mac.sh", map[string]string{"X-Forwarded-Host": "other.example"})
	if !strings.Contains(body, `HUB="https://r.example.com/salcara-hub"`) || !strings.Contains(body, `RELAY="https://r.example.com"`) {
		t.Fatalf("%q", body)
	}
}
