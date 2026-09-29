package hub

import (
	"bytes"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Downloads: GET/HEAD {prefix}/download/<file> (and /download/<file>) serves the bridge installers from
// Config.DownloadsDir without authentication, so users can install with
//
//	curl -fsSL https://relay.example.com/salcara-hub/download/install-mac.sh | bash
//
// Only a plain file name directly inside the folder is accepted (no sub-folders, no "..", no hidden
// files, no symlinks). Install scripts (.sh / .ps1) are templates: {{SALCARA_BASE_URL}} becomes the
// public hub URL of this request (e.g. https://relay.example.com/salcara-hub) and {{SALCARA_RELAY_URL}}
// the relay itself (https://relay.example.com), so one script works for every deployment.

const (
	placeholderBase  = "{{SALCARA_BASE_URL}}"
	placeholderRelay = "{{SALCARA_RELAY_URL}}"
	maxTemplateSize  = 1 << 20
)

var (
	downloadNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	hostRe         = regexp.MustCompile(`^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$`)
	prefixRe       = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+)*$`)
)

// downloadName extracts the file name from a /download/<file> path; ok=false if the path isn't one.
func (h *Hub) downloadName(path string) (string, string, bool) {
	prefix := ""
	if h.cfg.Prefix != "" && strings.HasPrefix(path, h.cfg.Prefix+"/download/") {
		prefix = h.cfg.Prefix
		path = path[len(h.cfg.Prefix):]
	}
	if !strings.HasPrefix(path, "/download/") {
		return "", "", false
	}
	return strings.TrimPrefix(path, "/download/"), prefix, true
}

func contentTypeFor(name string) (ct string, inline bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".sh":
		return "text/x-shellscript; charset=utf-8", true
	case ".ps1":
		return "text/plain; charset=utf-8", true
	case ".txt", ".md":
		return "text/plain; charset=utf-8", true
	case ".json":
		return "application/json; charset=utf-8", true
	case ".zip":
		return "application/zip", false
	case ".exe":
		return "application/vnd.microsoft.portable-executable", false
	case ".dmg":
		return "application/x-apple-diskimage", false
	case ".gz", ".tgz":
		return "application/gzip", false
	}
	return "application/octet-stream", false
}

func isTemplate(name string) bool {
	e := strings.ToLower(filepath.Ext(name))
	return e == ".sh" || e == ".ps1"
}

// publicBase works out the URL the client used to reach the hub (scheme://host[/prefix]). An explicit
// Config.PublicURL wins. Behind a trusted proxy X-Forwarded-Proto / -Host / -Prefix are honoured. Every
// part is validated because the result is pasted into a shell script that users pipe into bash.
func (h *Hub) publicBase(r *http.Request, prefix string) (base, relay string, ok bool) {
	if h.cfg.PublicURL != "" {
		u := h.cfg.PublicURL
		relay = u
		if h.cfg.Prefix != "" && strings.HasSuffix(u, h.cfg.Prefix) {
			relay = strings.TrimSuffix(u, h.cfg.Prefix)
		}
		return u, relay, true
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if h.cfg.TrustProxy {
		if p := firstHeaderValue(r, "X-Forwarded-Proto"); p != "" {
			scheme = strings.ToLower(p)
		}
		if fh := firstHeaderValue(r, "X-Forwarded-Host"); fh != "" {
			host = fh
		}
		if fp := firstHeaderValue(r, "X-Forwarded-Prefix"); fp != "" && prefix == "" {
			prefix = "/" + strings.Trim(fp, "/")
			if prefix == "/" {
				prefix = ""
			}
		}
	}
	if scheme != "http" && scheme != "https" || !hostRe.MatchString(host) || !prefixRe.MatchString(prefix) {
		return "", "", false
	}
	relay = scheme + "://" + host
	return relay + prefix, relay, true
}

func firstHeaderValue(r *http.Request, name string) string {
	v, _, _ := strings.Cut(r.Header.Get(name), ",")
	return strings.TrimSpace(v)
}

func (h *Hub) handleDownload(w http.ResponseWriter, r *http.Request, name, prefix string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "不支持的请求方法")
		return
	}
	if h.cfg.DownloadsDir == "" {
		writeError(w, http.StatusNotFound, "这个中转站没有提供下载")
		return
	}
	// Decode once more: "%2e%2e" arrives as ".." in r.URL.Path already, but be strict about anything odd.
	if dec, err := url.PathUnescape(name); err != nil || dec != name || !downloadNameRe.MatchString(name) || strings.Contains(name, "..") {
		writeError(w, http.StatusNotFound, "文件不存在")
		return
	}
	p := filepath.Join(h.cfg.DownloadsDir, name)
	st, err := os.Lstat(p)
	if err != nil || !st.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "文件不存在")
		return
	}
	ct, inline := contentTypeFor(name)
	hd := w.Header()
	hd.Set("Content-Type", ct)
	hd.Set("X-Content-Type-Options", "nosniff")
	if inline {
		hd.Set("Content-Disposition", `inline; filename="`+name+`"`)
	} else {
		hd.Set("Content-Disposition", `attachment; filename="`+name+`"`)
	}
	if isTemplate(name) {
		if st.Size() > maxTemplateSize {
			writeError(w, http.StatusInternalServerError, "脚本太大")
			return
		}
		b, err := os.ReadFile(p)
		if err != nil {
			writeError(w, http.StatusNotFound, "文件不存在")
			return
		}
		base, relay, ok := h.publicBase(r, prefix)
		if !ok {
			writeError(w, http.StatusBadRequest, "无法确定中转站地址")
			return
		}
		b = bytes.ReplaceAll(b, []byte(placeholderBase), []byte(base))
		b = bytes.ReplaceAll(b, []byte(placeholderRelay), []byte(relay))
		hd.Set("Cache-Control", "no-cache")
		hd.Set("Vary", "Host, X-Forwarded-Host, X-Forwarded-Proto")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b))
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeError(w, http.StatusNotFound, "文件不存在")
		return
	}
	defer f.Close()
	hd.Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, "", st.ModTime(), f)
}
