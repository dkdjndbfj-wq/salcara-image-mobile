package agents

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"salcara/bridge/internal/protocol"
)

// claudeHistory reads Claude Code transcripts (~/.claude/projects/<project>/<sessionId>.jsonl), caching
// per-file summaries by size+mtime so listing stays cheap.
type claudeHistory struct {
	dir   string
	mu    sync.Mutex
	cache map[string]*histEntry
}

type histEntry struct {
	mod  time.Time
	size int64
	info protocol.SessionInfo
	ok   bool
}

func newClaudeHistory(dir string) *claudeHistory {
	return &claudeHistory{dir: dir, cache: map[string]*histEntry{}}
}

func sortSessions(list []protocol.SessionInfo) {
	sort.SliceStable(list, func(i, j int) bool { return list[i].UpdatedAt > list[j].UpdatedAt })
}

func (h *claudeHistory) files() []string {
	m, _ := filepath.Glob(filepath.Join(h.dir, "*", "*.jsonl"))
	out := m[:0]
	for _, p := range m {
		if strings.HasPrefix(filepath.Base(p), "agent-") {
			continue // sub-agent transcripts of older versions
		}
		out = append(out, p)
	}
	return out
}

func (h *claudeHistory) path(id string) (string, error) {
	if id == "" || strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return "", errors.New("无效的会话 ID")
	}
	m, _ := filepath.Glob(filepath.Join(h.dir, "*", id+".jsonl"))
	if len(m) == 0 {
		return "", errors.New("找不到这个会话")
	}
	if len(m) > 1 { // the newest wins
		sort.Slice(m, func(i, j int) bool { return modTimeOf(m[i]).After(modTimeOf(m[j])) })
	}
	return m[0], nil
}

func modTimeOf(p string) time.Time {
	st, err := os.Stat(p)
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

func (h *claudeHistory) modTime(id string) (time.Time, error) {
	p, err := h.path(id)
	if err != nil {
		return time.Time{}, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return time.Time{}, err
	}
	return st.ModTime(), nil
}

// summary returns the cached SessionInfo of a transcript (status fields are filled by the agent).
func (h *claudeHistory) summary(path string, st os.FileInfo) (protocol.SessionInfo, bool) {
	h.mu.Lock()
	e := h.cache[path]
	h.mu.Unlock()
	if e != nil && e.size == st.Size() && e.mod.Equal(st.ModTime()) {
		return e.info, e.ok
	}
	info, ok := scanTranscript(path, st)
	h.mu.Lock()
	h.cache[path] = &histEntry{mod: st.ModTime(), size: st.Size(), info: info, ok: ok}
	h.mu.Unlock()
	return info, ok
}

func (h *claudeHistory) info(id string) (protocol.SessionInfo, bool) {
	p, err := h.path(id)
	if err != nil {
		return protocol.SessionInfo{}, false
	}
	st, err := os.Stat(p)
	if err != nil {
		return protocol.SessionInfo{}, false
	}
	return h.summary(p, st)
}

func (h *claudeHistory) list() []protocol.SessionInfo {
	type fi struct {
		path string
		st   os.FileInfo
	}
	var files []fi
	for _, p := range h.files() {
		if st, err := os.Stat(p); err == nil {
			files = append(files, fi{p, st})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].st.ModTime().After(files[j].st.ModTime()) })
	var out []protocol.SessionInfo
	for _, f := range files {
		if len(out) >= maxSessions {
			break
		}
		if info, ok := h.summary(f.path, f.st); ok {
			out = append(out, info)
		}
	}
	return out
}

func claudeClient(entrypoint string) string {
	switch {
	case entrypoint == "claude-desktop" || strings.Contains(entrypoint, "desktop"):
		return "Claude Desktop"
	default:
		return "Claude Code"
	}
}

// readLines calls f for each complete line of r (lines can be very long).
func readLines(r io.Reader, f func([]byte) bool) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 1 {
			if !f(line) {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// firstUserText extracts the typed text of a user transcript line ("" if it isn't a real prompt).
func firstUserText(l *claudeLine) string {
	if l.Type != "user" || l.IsMeta || l.IsCompactSummary || l.IsSidechain {
		return ""
	}
	var msg claudeMessage
	if json.Unmarshal(l.Message, &msg) != nil {
		return ""
	}
	blocks, s := parseBlocks(msg.Content)
	if s == "" {
		for _, b := range blocks {
			if b.Type == "text" {
				s = b.Text
				break
			}
		}
	}
	if !realUserText(s) {
		return ""
	}
	return s
}

// scanTranscript reads the head (title, cwd, entrypoint) and tail (model, latest cwd, AI title).
func scanTranscript(path string, st os.FileInfo) (protocol.SessionInfo, bool) {
	id := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	info := protocol.SessionInfo{SessionKey: "claude:" + id, Tool: "claude", Client: "Claude Code",
		UpdatedAt: st.ModTime().UnixMilli(), Status: "idle", Controllable: true}
	f, err := os.Open(path)
	if err != nil {
		return info, false
	}
	defer f.Close()
	title, entry, aiTitle, summary := "", "", "", ""
	read := int64(0)
	readLines(io.LimitReader(f, 4<<20), func(line []byte) bool {
		read += int64(len(line))
		var l claudeLine
		if json.Unmarshal(line, &l) != nil {
			return true
		}
		if info.Cwd == "" && l.Cwd != "" {
			info.Cwd = l.Cwd
		}
		if entry == "" && l.Entrypoint != "" {
			entry = l.Entrypoint
		}
		if l.Type == "ai-title" && l.AITitle != "" {
			aiTitle = l.AITitle
		}
		if l.Type == "summary" && l.Summary != "" && summary == "" {
			summary = l.Summary
		}
		if title == "" {
			title = firstUserText(&l)
		}
		return title == "" || info.Cwd == "" || entry == ""
	})
	// tail
	const tail = 256 << 10
	off := st.Size() - tail
	if off < 0 {
		off = 0
	}
	if _, err := f.Seek(off, io.SeekStart); err == nil {
		first := off > 0
		readLines(f, func(line []byte) bool {
			if first { // probably a partial line
				first = false
				return true
			}
			var l claudeLine
			if json.Unmarshal(line, &l) != nil {
				return true
			}
			if l.Cwd != "" {
				info.Cwd = l.Cwd
			}
			if l.Type == "ai-title" && l.AITitle != "" {
				aiTitle = l.AITitle
			}
			if l.Type == "assistant" && !l.IsSidechain {
				var msg claudeMessage
				if json.Unmarshal(l.Message, &msg) == nil && msg.Model != "" && msg.Model != "<synthetic>" {
					info.Model = msg.Model
				}
			}
			if title == "" {
				title = firstUserText(&l)
			}
			return true
		})
	}
	switch {
	case title != "":
		info.Title = titleText(title)
	case aiTitle != "":
		info.Title = titleText(aiTitle)
	case summary != "":
		info.Title = titleText(summary)
	default:
		return info, false // no conversation in it
	}
	info.Client = claudeClient(entry)
	return info, true
}

// open converts a whole transcript to events (≤400, oldest first).
func (h *claudeHistory) open(id string) (protocol.SessionInfo, []protocol.Event, error) {
	p, err := h.path(id)
	if err != nil {
		return protocol.SessionInfo{}, nil, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return protocol.SessionInfo{}, nil, err
	}
	info, _ := h.summary(p, st)
	f, err := os.Open(p)
	if err != nil {
		return info, nil, err
	}
	defer f.Close()
	m := newClaudeMapper(info.SessionKey, info.Cwd)
	var evs []protocol.Event
	readLines(f, func(line []byte) bool {
		var l claudeLine
		if json.Unmarshal(line, &l) == nil {
			evs = append(evs, m.entry(&l)...)
			if len(evs) > 4*maxHistoryEvents {
				evs = dedupeEvents(evs, 2*maxHistoryEvents)
			}
		}
		return true
	})
	return info, dedupeEvents(evs, maxHistoryEvents), nil
}

// ---- live watching of transcripts written outside the bridge ----

type watchedFile struct {
	offset int64
	mod    time.Time
	status string
	mapper *claudeMapper
}

// watch polls transcript mtimes and emits incremental events for sessions the bridge doesn't run
// (terminal, IDE and Claude Desktop sessions), so they show live on the phone.
func (a *claudeAgent) watch(ctx context.Context, interval time.Duration) {
	state := map[string]*watchedFile{}
	first := true
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		a.watchOnce(state, first)
		first = false
		select {
		case <-ctx.Done():
			return
		case <-a.closeCh:
			return
		case <-tick.C:
		}
	}
}

func (a *claudeAgent) watchOnce(state map[string]*watchedFile, baseline bool) {
	for _, p := range a.hist.files() {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		id := strings.TrimSuffix(filepath.Base(p), ".jsonl")
		w := state[p]
		if baseline {
			state[p] = &watchedFile{offset: st.Size(), mod: st.ModTime(), status: activityStatus(st.ModTime())}
			continue
		}
		a.mu.Lock()
		owned := a.ownedLocked(id)
		a.mu.Unlock()
		if w == nil {
			w = &watchedFile{status: "idle"}
			if st.Size() > 1<<20 { // an old big file that just appeared (copied/synced): don't replay it
				w.offset = st.Size()
			}
			state[p] = w
		}
		if st.Size() < w.offset {
			w.offset = st.Size() // truncated / rewritten
		}
		changed := st.Size() != w.offset || !st.ModTime().Equal(w.mod)
		w.mod = st.ModTime()
		if owned {
			w.offset = st.Size() // the bridge streams these itself
			w.status = "idle"
			continue
		}
		info, ok := a.hist.summary(p, st)
		status := activityStatus(st.ModTime())
		if changed && st.Size() > w.offset {
			var evs []protocol.Event
			if w.mapper == nil {
				w.mapper = newClaudeMapper("claude:"+id, info.Cwd)
			}
			w.offset = readFrom(p, w.offset, st.Size(), func(line []byte) {
				var l claudeLine
				if json.Unmarshal(line, &l) == nil {
					evs = append(evs, w.mapper.entry(&l)...)
				}
			})
			w.mapper.trim()
			if ok && (status != w.status || len(evs) > 0) {
				info.Status, info.Controllable = status, status != "running"
				a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})
				w.status = status
			}
			if len(evs) > maxHistoryEvents {
				evs = evs[len(evs)-maxHistoryEvents:]
			}
			for _, e := range evs {
				a.emit(e)
			}
			continue
		}
		if ok && status != w.status {
			info.Status, info.Controllable = status, status != "running"
			a.emit(protocol.Event{SessionKey: info.SessionKey, Type: "session.updated", Session: ptrInfo(info)})
			w.status = status
		}
	}
}

func activityStatus(mod time.Time) string {
	if time.Since(mod) < externalActive {
		return "running"
	}
	return "idle"
}

// readFrom reads complete lines in [from, to) and returns the offset after the last complete line.
func readFrom(path string, from, to int64, f func([]byte)) int64 {
	file, err := os.Open(path)
	if err != nil {
		return from
	}
	defer file.Close()
	if _, err := file.Seek(from, io.SeekStart); err != nil {
		return from
	}
	br := bufio.NewReaderSize(io.LimitReader(file, to-from), 1<<20)
	off := from
	for {
		line, err := br.ReadBytes('\n')
		if err != nil { // incomplete last line: keep it for next time
			return off
		}
		off += int64(len(line))
		f(line)
	}
}
