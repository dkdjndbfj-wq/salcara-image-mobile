package agents

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"salcara/bridge/internal/protocol"
)

// Options lets tests (or the core) point the agents at specific executables and folders.
// Zero values mean "discover automatically".
type Options struct {
	CodexPath  string // codex executable
	ClaudePath string // claude executable
	ClaudeHome string // ~/.claude (projects/ inside)
	StateDir   string // where the bridge remembers which Codex threads it started; "" = user config dir

	ClaudeWatchInterval time.Duration // default 2s
	CodexWatchInterval  time.Duration // default 10s
}

type manager struct {
	sink   Sink
	codex  *codexAgent
	claude *claudeAgent
	mux    *http.ServeMux

	mu      sync.Mutex
	watchOn bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	opts    Options
}

// NewManager creates the Codex and Claude Code agents.
func NewManager(sink Sink, settings func() Settings) Manager {
	return NewManagerWithOptions(sink, settings, Options{})
}

// NewManagerWithOptions is NewManager with explicit executable paths / folders.
func NewManagerWithOptions(sink Sink, settings func() Settings, opts Options) Manager {
	if sink == nil {
		sink = func(protocol.Event) {}
	}
	if opts.StateDir == "" {
		if d, err := os.UserConfigDir(); err == nil {
			opts.StateDir = filepath.Join(d, "salcara-bridge")
		}
	}
	if opts.ClaudeWatchInterval <= 0 {
		opts.ClaudeWatchInterval = 2 * time.Second
	}
	if opts.CodexWatchInterval <= 0 {
		opts.CodexWatchInterval = 10 * time.Second
	}
	stateFile := ""
	if opts.StateDir != "" {
		stateFile = filepath.Join(opts.StateDir, "codex-threads.json")
	}
	emit := func(e protocol.Event) { sink(e) }
	m := &manager{sink: sink, opts: opts,
		codex:  newCodexAgent(emit, settings, opts.CodexPath, stateFile),
		claude: newClaudeAgent(emit, settings, opts.ClaudePath, opts.ClaudeHome),
		mux:    http.NewServeMux(),
	}
	m.mux.HandleFunc(PermissionPath, m.claude.permissionHandler)
	return m
}

func (m *manager) Agents() []Agent { return []Agent{m.codex, m.claude} }

func (m *manager) Get(tool string) Agent {
	switch tool {
	case "codex":
		return m.codex
	case "claude":
		return m.claude
	}
	return nil
}

func (m *manager) Watch(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.watchOn {
		return
	}
	m.watchOn = true
	ctx, m.cancel = context.WithCancel(ctx)
	m.wg.Add(2)
	go func() {
		defer m.wg.Done()
		m.claude.watch(ctx, m.opts.ClaudeWatchInterval)
	}()
	go func() {
		defer m.wg.Done()
		m.codex.watch(ctx, m.opts.CodexWatchInterval)
	}()
}

func (m *manager) LocalHandler() http.Handler { return m.mux }

// Respond is a convenience for the core: routes an approval answer to whichever agent raised it.
func (m *manager) Respond(approvalID, decision, message string) bool {
	for _, a := range m.Agents() {
		if a.Respond(approvalID, decision, message) {
			return true
		}
	}
	return false
}

func (m *manager) Close() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
	m.codex.Close()
	m.claude.Close()
	m.wg.Wait()
}
