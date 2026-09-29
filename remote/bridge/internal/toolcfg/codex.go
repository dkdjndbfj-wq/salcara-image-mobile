package toolcfg

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ProviderID is the Codex model provider table the bridge owns: [model_providers.salcara].
const ProviderID = "salcara"

// CodexEnvKey is the environment variable used in env_key mode.
const CodexEnvKey = "SUB2API_API_KEY"

// CodexParams describes the provider to write.
type CodexParams struct {
	BaseURL string // relayRoot + "/v1"
	Token   string // written as experimental_bearer_token unless EnvKey is set
	EnvKey  string // when non-empty, write env_key = EnvKey instead of the token
}

// CodexStatus is what the console shows for ~/.codex/config.toml.
type CodexStatus struct {
	Path          string `json:"path"`
	Exists        bool   `json:"exists"`
	Provider      string `json:"provider"` // current top-level model_provider (empty = openai default)
	BaseURL       string `json:"baseUrl"`  // base_url of [model_providers.salcara]
	AuthMode      string `json:"authMode"` // token | env | ""
	TokenMatches  bool   `json:"tokenMatches"`
	Configured    bool   `json:"configured"`
	HasBackup     bool   `json:"hasBackup"`
	Error         string `json:"error,omitempty"`
	OtherProvider bool   `json:"otherProvider"` // another provider is selected
}

// CodexConfigPath is ~/.codex/config.toml (CODEX_HOME respected).
func CodexConfigPath() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return filepath.Join(h, "config.toml")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
}

// ---- line-based TOML scanning ----

type lineKind int

const (
	lkOther  lineKind = iota // blank, comment, or continuation of a multi-line value
	lkHeader                 // [table] or [[array]]
	lkKeyVal                 // key = value (first line of the statement)
)

type tomlLine struct {
	kind   lineKind
	header []string // header key parts (lkHeader)
	key    string   // bare key (lkKeyVal)
	stmtTo int      // lkKeyVal: index of the last line of this statement (multi-line values)
}

var headerRe = regexp.MustCompile(`^\[\[?([^\[\]]*)\]\]?\s*(#.*)?$`)

// scanTOML classifies each line. It understands strings (basic, literal, multi-line) and brackets well
// enough to know which lines start statements and which are table headers.
func scanTOML(lines []string) []tomlLine {
	out := make([]tomlLine, len(lines))
	inML := "" // current multi-line string delimiter
	depth := 0 // open [ / { of a value spanning lines
	stmtStart := -1
	for i, raw := range lines {
		clean := inML == "" && depth == 0
		trimmed := strings.TrimSpace(raw)
		if clean {
			stmtStart = -1
			if m := headerRe.FindStringSubmatch(trimmed); m != nil && !strings.Contains(m[1], "=") {
				out[i] = tomlLine{kind: lkHeader, header: splitDotted(m[1])}
				continue
			}
			if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
				if k, ok := keyOf(trimmed); ok {
					out[i] = tomlLine{kind: lkKeyVal, key: k, stmtTo: i}
					stmtStart = i
				}
			}
		}
		inML, depth = advance(raw, inML, depth)
		if stmtStart >= 0 {
			out[stmtStart].stmtTo = i
		}
	}
	return out
}

// advance scans one line and returns the multi-line string / bracket state at its end.
func advance(s, inML string, depth int) (string, int) {
	i := 0
	for i < len(s) {
		if inML != "" {
			j := strings.Index(s[i:], inML)
			if j < 0 {
				return inML, depth
			}
			i += j + len(inML)
			inML = ""
			continue
		}
		c := s[i]
		switch {
		case c == '#':
			return inML, depth
		case strings.HasPrefix(s[i:], `"""`):
			inML = `"""`
			i += 3
		case strings.HasPrefix(s[i:], `'''`):
			inML = `'''`
			i += 3
		case c == '"':
			i++
			for i < len(s) && s[i] != '"' {
				if s[i] == '\\' {
					i++
				}
				i++
			}
			i++
		case c == '\'':
			i++
			for i < len(s) && s[i] != '\'' {
				i++
			}
			i++
		case c == '[' || c == '{':
			depth++
			i++
		case c == ']' || c == '}':
			if depth > 0 {
				depth--
			}
			i++
		default:
			i++
		}
	}
	return inML, depth
}

// keyOf returns the (first-part, unquoted) key of a "key = value" line.
func keyOf(line string) (string, bool) {
	inQ := byte(0)
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inQ != 0 {
			if c == inQ {
				inQ = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			inQ = c
			continue
		}
		if c == '=' {
			parts := splitDotted(line[:i])
			if len(parts) == 0 {
				return "", false
			}
			return strings.Join(parts, "."), true
		}
	}
	return "", false
}

func splitDotted(s string) []string {
	var parts []string
	var cur strings.Builder
	inQ := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inQ != 0 {
			if c == inQ {
				inQ = 0
			} else {
				cur.WriteByte(c)
			}
			continue
		}
		switch c {
		case '"', '\'':
			inQ = c
		case '.':
			parts = append(parts, strings.TrimSpace(cur.String()))
			cur.Reset()
		case ' ', '\t':
		default:
			cur.WriteByte(c)
		}
	}
	if t := strings.TrimSpace(cur.String()); t != "" || len(parts) > 0 {
		parts = append(parts, t)
	}
	return parts
}

// stringValue extracts a simple quoted value from `key = "value"` / `key = 'value'`.
func stringValue(line string) string {
	i := strings.Index(line, "=")
	if i < 0 {
		return ""
	}
	v := strings.TrimSpace(line[i+1:])
	if strings.HasPrefix(v, `"`) {
		var b strings.Builder
		for j := 1; j < len(v); j++ {
			c := v[j]
			if c == '\\' && j+1 < len(v) {
				j++
				switch v[j] {
				case 'n':
					b.WriteByte('\n')
				case 't':
					b.WriteByte('\t')
				default:
					b.WriteByte(v[j])
				}
				continue
			}
			if c == '"' {
				break
			}
			b.WriteByte(c)
		}
		return b.String()
	}
	if strings.HasPrefix(v, `'`) {
		v = v[1:]
		if j := strings.Index(v, `'`); j >= 0 {
			return v[:j]
		}
		return v
	}
	if j := strings.IndexAny(v, " \t#"); j >= 0 {
		v = v[:j]
	}
	return v
}

// TOMLString quotes s as a TOML basic string.
func TOMLString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 || r == 0x7f {
				b.WriteString(`\u00`)
				const hexd = "0123456789ABCDEF"
				b.WriteByte(hexd[r>>4])
				b.WriteByte(hexd[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func splitLines(content string) (lines []string, eol string) {
	eol = "\n"
	if strings.Contains(content, "\r\n") {
		eol = "\r\n"
	}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.TrimSuffix(content, "\n")
	if content == "" {
		return nil, eol
	}
	return strings.Split(content, "\n"), eol
}

func joinLines(lines []string, eol string) string {
	// drop trailing blank lines, end with exactly one newline
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, eol) + eol
}

func isOwnTable(h []string) bool {
	return len(h) >= 2 && h[0] == "model_providers" && h[1] == ProviderID
}

// firstHeader returns the index of the first table header (len(lines) if none).
func firstHeader(info []tomlLine) int {
	for i, l := range info {
		if l.kind == lkHeader {
			return i
		}
	}
	return len(info)
}

// removeOwnTables deletes every [model_providers.salcara(.…)] table. It returns the new lines and the
// index where the first removed table was (-1 if none). Comment/blank lines right before the next header
// are kept (they usually describe that next table).
func removeOwnTables(lines []string) ([]string, int) {
	info := scanTOML(lines)
	at := -1
	var out []string
	for i := 0; i < len(lines); {
		if info[i].kind == lkHeader && isOwnTable(info[i].header) {
			end := i + 1
			for end < len(lines) && info[end].kind != lkHeader {
				end++
			}
			// give back trailing comments/blank lines to the next table
			keep := end
			for keep > i+1 && info[keep-1].kind == lkOther && isCommentOrBlank(lines[keep-1]) {
				keep--
			}
			if at < 0 {
				at = len(out)
			}
			out = append(out, lines[keep:end]...)
			i = end
			continue
		}
		out = append(out, lines[i])
		i++
	}
	return out, at
}

func isCommentOrBlank(s string) bool {
	t := strings.TrimSpace(s)
	return t == "" || strings.HasPrefix(t, "#")
}

func codexBlock(p CodexParams) []string {
	b := []string{
		"[model_providers." + ProviderID + "]",
		`name = "Salcara"`,
		"base_url = " + TOMLString(p.BaseURL),
		`wire_api = "responses"`,
		"requires_openai_auth = false",
		"supports_websockets = false",
	}
	if p.EnvKey != "" {
		b = append(b, "env_key = "+TOMLString(p.EnvKey))
	} else {
		b = append(b, "experimental_bearer_token = "+TOMLString(p.Token))
	}
	return b
}

// setTopLevel replaces or inserts `key = value` in the top-level section (before the first header).
func setTopLevel(lines []string, key, value string) []string {
	info := scanTOML(lines)
	fh := firstHeader(info)
	lastStmtEnd := -1
	for i := 0; i < fh; i++ {
		if info[i].kind == lkKeyVal {
			if info[i].key == key {
				out := append([]string{}, lines[:i]...)
				out = append(out, key+" = "+value)
				return append(out, lines[info[i].stmtTo+1:]...)
			}
			lastStmtEnd = info[i].stmtTo
		}
	}
	pos := lastStmtEnd + 1
	if lastStmtEnd < 0 {
		// no top-level statements: put it at the very top, after a leading comment block
		pos = 0
		for pos < fh && strings.HasPrefix(strings.TrimSpace(lines[pos]), "#") {
			pos++
		}
	}
	out := append([]string{}, lines[:pos]...)
	out = append(out, key+" = "+value)
	if pos == 0 && len(lines) > 0 && info[0].kind == lkHeader {
		out = append(out, "")
	}
	return append(out, lines[pos:]...)
}

// removeTopLevel deletes the top-level `key = …` statement if its string value equals want.
func removeTopLevel(lines []string, key, want string) []string {
	info := scanTOML(lines)
	fh := firstHeader(info)
	for i := 0; i < fh; i++ {
		if info[i].kind == lkKeyVal && info[i].key == key && stringValue(lines[i]) == want {
			out := append([]string{}, lines[:i]...)
			return append(out, lines[info[i].stmtTo+1:]...)
		}
	}
	return lines
}

// ApplyCodexTOML returns content with model_provider = "salcara" and a fresh [model_providers.salcara]
// table; everything else (comments, other tables, other keys) is preserved. Idempotent.
func ApplyCodexTOML(content string, p CodexParams) string {
	lines, eol := splitLines(content)
	lines = setTopLevel(lines, "model_provider", TOMLString(ProviderID))
	lines, at := removeOwnTables(lines)
	block := codexBlock(p)
	if at < 0 {
		for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, block...)
	} else {
		out := append([]string{}, lines[:at]...)
		out = append(out, block...)
		rest := lines[at:]
		if len(rest) > 0 && strings.TrimSpace(rest[0]) != "" {
			out = append(out, "")
		}
		lines = append(out, rest...)
	}
	return joinLines(lines, eol)
}

// RemoveCodexTOML undoes ApplyCodexTOML when there is no backup: drops our table and our model_provider.
func RemoveCodexTOML(content string) string {
	lines, eol := splitLines(content)
	lines, _ = removeOwnTables(lines)
	lines = removeTopLevel(lines, "model_provider", ProviderID)
	return joinLines(lines, eol)
}

// InspectCodexTOML reads the relevant values.
func InspectCodexTOML(content string) (provider, baseURL, token, envKey string) {
	lines, _ := splitLines(content)
	info := scanTOML(lines)
	var table []string
	for i, l := range info {
		switch l.kind {
		case lkHeader:
			table = l.header
		case lkKeyVal:
			if table == nil && l.key == "model_provider" {
				provider = stringValue(lines[i])
			}
			if len(table) == 2 && isOwnTable(table) {
				switch l.key {
				case "base_url":
					baseURL = stringValue(lines[i])
				case "experimental_bearer_token":
					token = stringValue(lines[i])
				case "env_key":
					envKey = stringValue(lines[i])
				}
			}
		}
	}
	return
}

// CodexStatusFor inspects the file at path against the expected base URL / key.
func CodexStatusFor(path, baseURL, key string) CodexStatus {
	st := CodexStatus{Path: path, HasBackup: hasBackup(path)}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			st.Error = err.Error()
		}
		return st
	}
	st.Exists = true
	prov, base, tok, env := InspectCodexTOML(string(b))
	st.Provider, st.BaseURL = prov, base
	switch {
	case env != "":
		st.AuthMode = "env"
		st.TokenMatches = os.Getenv(env) == key || env == CodexEnvKey
	case tok != "":
		st.AuthMode = "token"
		st.TokenMatches = tok == key
	}
	st.OtherProvider = prov != "" && prov != ProviderID
	st.Configured = prov == ProviderID && strings.TrimRight(base, "/") == strings.TrimRight(baseURL, "/") && st.TokenMatches
	return st
}

// ApplyCodex edits the file at path (creating it if needed), backing up the original once.
func ApplyCodex(path string, p CodexParams) error {
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := backupOnce(path, b, err == nil); err != nil {
		return err
	}
	return writeFileKeepMode(path, []byte(ApplyCodexTOML(string(b), p)), 0o600)
}

// RestoreCodex puts the backup back, or strips our settings if there is no backup.
func RestoreCodex(path string) error {
	if ok, err := restoreBackup(path); ok || err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return writeFileKeepMode(path, []byte(RemoveCodexTOML(string(b))), 0o600)
}
