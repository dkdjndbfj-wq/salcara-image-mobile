// Package hubclient keeps this computer registered and online at the Salcara hub (PROTOCOL.md §2): it
// registers the device, holds the /bridge/stream SSE connection open, executes commands from the phone and
// uploads agent events in batches.
package hubclient

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"salcara/bridge/internal/agents"
	"salcara/bridge/internal/config"
	"salcara/bridge/internal/protocol"
)

// Connection states shown in the console.
const (
	StateNotLoggedIn = "not_logged_in" // 未登录
	StateConnecting  = "connecting"    // 连接中
	StateConnected   = "connected"     // 已连接
	StateInvalidKey  = "invalid_key"   // Key 无效
)

// Status is a snapshot of the hub connection.
type Status struct {
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
	Since     int64  `json:"since"` // ms
	HubURL    string `json:"hubUrl"`
	DeviceID  string `json:"deviceId"`
	Queued    int    `json:"queued"`
	LastEvent int64  `json:"lastEventSent,omitempty"`
}

// Options configure a Client. Zero durations use the production defaults.
type Options struct {
	Store   *config.Store
	Version string
	Logger  *log.Logger
	HTTP    *http.Client // for normal requests; the stream uses its own no-timeout client based on Transport

	HeartbeatTimeout time.Duration // no data for this long → reconnect (60s)
	BackoffMin       time.Duration // 1s
	BackoffMax       time.Duration // 60s
	FlushInterval    time.Duration // 300ms
	FlushBatch       int           // 50
	QueueCap         int           // 5000
	ReregisterEvery  time.Duration // 5m
	ToolCheckEvery   time.Duration // 60s

	OnStatus func(Status) // called on every state change
}

// Client is the hub connection.
type Client struct {
	o   Options
	log *log.Logger

	mgrMu sync.RWMutex
	mgr   agents.Manager

	mu         sync.Mutex
	status     Status
	cancelConn context.CancelFunc
	lastFP     string
	lastReg    time.Time
	tools      []protocol.Tool

	wake  chan struct{}
	regCh chan struct{}

	qmu      sync.Mutex
	queue    []protocol.Event
	flushNow chan struct{}
	lastSent atomic.Int64

	streamHTTP *http.Client
}

var errUnauthorized = errors.New("Key 无效或不是中转站用户")

// New creates a client; call SetManager before Run.
func New(o Options) *Client {
	if o.HeartbeatTimeout == 0 {
		o.HeartbeatTimeout = 60 * time.Second
	}
	if o.BackoffMin == 0 {
		o.BackoffMin = time.Second
	}
	if o.BackoffMax == 0 {
		o.BackoffMax = 60 * time.Second
	}
	if o.FlushInterval == 0 {
		o.FlushInterval = 300 * time.Millisecond
	}
	if o.FlushBatch == 0 {
		o.FlushBatch = 50
	}
	if o.QueueCap == 0 {
		o.QueueCap = 5000
	}
	if o.ReregisterEvery == 0 {
		o.ReregisterEvery = 5 * time.Minute
	}
	if o.ToolCheckEvery == 0 {
		o.ToolCheckEvery = 60 * time.Second
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if o.Logger == nil {
		o.Logger = log.New(io.Discard, "", 0)
	}
	tr := o.HTTP.Transport
	if tr == nil {
		tr = &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second}
	}
	c := &Client{
		o:          o,
		log:        o.Logger,
		wake:       make(chan struct{}, 1),
		regCh:      make(chan struct{}, 1),
		flushNow:   make(chan struct{}, 1),
		streamHTTP: &http.Client{Transport: tr},
	}
	c.status = Status{State: StateNotLoggedIn, Since: nowMS()}
	return c
}

// SetManager attaches the agents manager (commands fail with an error until it is set).
func (c *Client) SetManager(m agents.Manager) {
	c.mgrMu.Lock()
	c.mgr = m
	c.mgrMu.Unlock()
}

func (c *Client) manager() agents.Manager {
	c.mgrMu.RLock()
	defer c.mgrMu.RUnlock()
	return c.mgr
}

// Status returns the current connection status.
func (c *Client) Status() Status {
	c.mu.Lock()
	s := c.status
	c.mu.Unlock()
	cfg := c.o.Store.Get()
	s.HubURL = cfg.EffectiveHubURL()
	s.DeviceID = cfg.DeviceID
	c.qmu.Lock()
	s.Queued = len(c.queue)
	c.qmu.Unlock()
	s.LastEvent = c.lastSent.Load()
	return s
}

// Tools returns the tools found by the last detection.
func (c *Client) Tools() []protocol.Tool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]protocol.Tool(nil), c.tools...)
}

func (c *Client) setState(state, errText string) {
	c.mu.Lock()
	changed := c.status.State != state || c.status.Error != errText
	if c.status.State != state {
		c.status.Since = nowMS()
	}
	c.status.State, c.status.Error = state, errText
	c.mu.Unlock()
	if changed {
		if errText != "" {
			c.log.Printf("hub: %s (%s)", state, errText)
		} else {
			c.log.Printf("hub: %s", state)
		}
		if c.o.OnStatus != nil {
			c.o.OnStatus(c.Status())
		}
	}
}

// Kick drops the current connection and reconnects immediately (after login/config changes).
func (c *Client) Kick() {
	c.mu.Lock()
	if c.cancelConn != nil {
		c.cancelConn()
	}
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// Reregister sends the device info again soon (projects changed, device renamed…).
func (c *Client) Reregister() {
	select {
	case c.regCh <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is done.
func (c *Client) Run(ctx context.Context) {
	go c.flushLoop(ctx)
	go c.registerLoop(ctx)
	backoff := c.o.BackoffMin
	for ctx.Err() == nil {
		cfg := c.o.Store.Get()
		if !cfg.LoggedIn() {
			c.setState(StateNotLoggedIn, "")
			c.waitWake(ctx, 0)
			continue
		}
		connCtx, cancel := context.WithCancel(ctx)
		c.mu.Lock()
		c.cancelConn = cancel
		c.mu.Unlock()
		if st := c.Status().State; st != StateConnected {
			c.setState(StateConnecting, c.Status().Error)
		} else {
			c.setState(StateConnecting, "")
		}
		started := time.Now()
		err := c.register(connCtx, true)
		if err == nil {
			err = c.stream(connCtx)
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errUnauthorized) {
			c.setState(StateInvalidKey, err.Error())
			c.waitWake(ctx, 5*time.Minute)
			backoff = c.o.BackoffMin
			continue
		}
		if connCtx.Err() != nil && !errors.Is(err, errHeartbeat) {
			// cancelled by Kick: reconnect right away
			backoff = c.o.BackoffMin
			continue
		}
		msg := "连接中断"
		if err != nil {
			msg = err.Error()
		}
		c.setState(StateConnecting, msg)
		if time.Since(started) > 2*time.Minute {
			backoff = c.o.BackoffMin
		}
		c.waitWake(ctx, backoff)
		backoff *= 2
		if backoff > c.o.BackoffMax {
			backoff = c.o.BackoffMax
		}
	}
}

func (c *Client) waitWake(ctx context.Context, d time.Duration) {
	var timer <-chan time.Time
	if d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		timer = t.C
	}
	select {
	case <-ctx.Done():
	case <-c.wake:
	case <-timer:
	}
}

func (c *Client) base() string { return c.o.Store.Get().EffectiveHubURL() + "/v1" }

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.o.Store.Get().AccountKey)
	req.Header.Set("X-Salcara-Device-Secret", c.o.Store.Get().DeviceSecret)
	req.Header.Set("User-Agent", "SalcaraBridge/"+c.o.Version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// PairStart asks the Hub for a one-time code shown only in the local desktop
// app. The phone must enter it before it can see this computer or send commands.
func (c *Client) PairStart(ctx context.Context) (string, int64, error) {
	if c.Status().State != StateConnected {
		return "", 0, errors.New("电脑尚未连接中转站")
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/bridge/pair/start", map[string]string{"deviceId": c.o.Store.Get().DeviceID})
	if err != nil {
		return "", 0, err
	}
	resp, err := c.o.HTTP.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", 0, checkResp(resp)
	}
	var result struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result); err != nil {
		return "", 0, err
	}
	if len(result.Code) != 8 {
		return "", 0, errors.New("中转站返回的配对码无效")
	}
	return result.Code, result.ExpiresAt, nil
}

func (c *Client) post(ctx context.Context, path string, body any) error {
	req, err := c.newRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	resp, err := c.o.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return checkResp(resp)
}

func checkResp(resp *http.Response) error {
	if resp.StatusCode/100 == 2 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return errUnauthorized
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil && e.Error != "" {
		return fmt.Errorf("中转站返回 %d：%s", resp.StatusCode, e.Error)
	}
	if resp.StatusCode == http.StatusNotFound {
		return errors.New("这个中转站还没有部署远程编程服务 (404)")
	}
	return fmt.Errorf("中转站返回 %d", resp.StatusCode)
}

// Device builds the registration body, detecting tools.
func (c *Client) Device(ctx context.Context) protocol.Device {
	cfg := c.o.Store.Get()
	d := protocol.Device{
		DeviceID: cfg.DeviceID,
		Name:     cfg.DeviceName,
		OS:       runtime.GOOS,
		Version:  c.o.Version,
		Tools:    []protocol.Tool{},
		Projects: cfg.Projects,
	}
	if m := c.manager(); m != nil {
		for _, a := range m.Agents() {
			dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			d.Tools = append(d.Tools, a.Detect(dctx))
			cancel()
		}
	}
	c.mu.Lock()
	c.tools = append([]protocol.Tool(nil), d.Tools...)
	c.mu.Unlock()
	return d
}

func fingerprint(d protocol.Device) string {
	b, _ := json.Marshal(d)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

func (c *Client) register(ctx context.Context, force bool) error {
	d := c.Device(ctx)
	fp := fingerprint(d)
	c.mu.Lock()
	same := fp == c.lastFP && time.Since(c.lastReg) < c.o.ReregisterEvery
	c.mu.Unlock()
	if same && !force {
		return nil
	}
	if err := c.post(ctx, "/bridge/register", d); err != nil {
		return err
	}
	c.mu.Lock()
	c.lastFP, c.lastReg = fp, time.Now()
	c.mu.Unlock()
	return nil
}

// registerLoop re-registers every ReregisterEvery and whenever tools/projects/name change.
func (c *Client) registerLoop(ctx context.Context) {
	t := time.NewTicker(c.o.ToolCheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-c.regCh:
		}
		if c.Status().State != StateConnected {
			continue
		}
		if err := c.register(ctx, false); err != nil {
			c.log.Printf("hub: re-register: %v", err)
			if errors.Is(err, errUnauthorized) {
				c.Kick()
			}
		}
	}
}

var errHeartbeat = errors.New("连接超时，正在重连")

func (c *Client) stream(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg := c.o.Store.Get()
	req, err := c.newRequest(ctx, http.MethodGet, "/bridge/stream?deviceId="+cfg.DeviceID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.streamHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return checkResp(resp)
	}
	c.setState(StateConnected, "")
	// Changes made while we were (re)connecting — e.g. a project added right after login, whose
	// Reregister() was skipped because we weren't connected yet — are sent now if the device differs
	// from what was registered.
	c.Reregister()

	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	var timedOut atomic.Bool
	go func() {
		step := c.o.HeartbeatTimeout / 6
		if step < 10*time.Millisecond {
			step = 10 * time.Millisecond
		}
		t := time.NewTicker(step)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, last.Load())) > c.o.HeartbeatTimeout {
					timedOut.Store(true)
					cancel()
					return
				}
			}
		}
	}()

	rd := bufio.NewReaderSize(resp.Body, 64*1024)
	var evName string
	var data strings.Builder
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			if timedOut.Load() {
				return errHeartbeat
			}
			if err == io.EOF {
				return errors.New("服务器断开了连接")
			}
			return err
		}
		last.Store(time.Now().UnixNano())
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if data.Len() > 0 {
				c.handleSSE(ctx, evName, data.String())
			}
			evName = ""
			data.Reset()
		case strings.HasPrefix(line, ":"):
			// keep-alive comment
		case strings.HasPrefix(line, "event:"):
			evName = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(line[5:], " "))
		}
	}
}

func (c *Client) handleSSE(_ context.Context, name, data string) {
	if name != "command" && name != "" {
		return
	}
	var env protocol.CommandEnvelope
	if err := json.Unmarshal([]byte(data), &env); err != nil || env.CommandID == "" {
		c.log.Printf("hub: bad command: %v", err)
		return
	}
	go c.execute(env)
}

func (c *Client) execute(env protocol.CommandEnvelope) {
	ctx, cancel := context.WithTimeout(context.Background(), 44*time.Second)
	defer cancel()
	typ, _ := env.Command["type"].(string)
	res, err := c.Dispatch(ctx, env.Command)
	rep := protocol.Reply{DeviceID: c.o.Store.Get().DeviceID, CommandID: env.CommandID, OK: err == nil, Result: res}
	if err != nil {
		rep.Error = err.Error()
		rep.Result = nil
		c.log.Printf("command %s failed: %v", typ, err)
	} else {
		c.log.Printf("command %s ok", typ)
	}
	for i := 0; i < 3; i++ {
		rctx, rcancel := context.WithTimeout(context.Background(), 15*time.Second)
		perr := c.post(rctx, "/bridge/reply", rep)
		rcancel()
		if perr == nil {
			return
		}
		c.log.Printf("hub: reply %s: %v", env.CommandID, perr)
		time.Sleep(time.Duration(i+1) * 500 * time.Millisecond)
	}
}

// ---- events ----

// Push queues an event for upload (drops the oldest beyond QueueCap).
func (c *Client) Push(ev protocol.Event) {
	if ev.TS == 0 {
		ev.TS = nowMS()
	}
	c.qmu.Lock()
	c.queue = append(c.queue, ev)
	if over := len(c.queue) - c.o.QueueCap; over > 0 {
		c.queue = append([]protocol.Event(nil), c.queue[over:]...)
	}
	n := len(c.queue)
	c.qmu.Unlock()
	if n >= c.o.FlushBatch {
		select {
		case c.flushNow <- struct{}{}:
		default:
		}
	}
}

func (c *Client) flushLoop(ctx context.Context) {
	t := time.NewTicker(c.o.FlushInterval)
	defer t.Stop()
	var retryAt time.Time
	fails := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-c.flushNow:
		}
		if time.Now().Before(retryAt) {
			continue
		}
		st := c.Status().State
		if st == StateNotLoggedIn || st == StateInvalidKey {
			continue
		}
		for {
			c.qmu.Lock()
			n := len(c.queue)
			if n == 0 {
				c.qmu.Unlock()
				break
			}
			if n > 200 {
				n = 200
			}
			batch := append([]protocol.Event(nil), c.queue[:n]...)
			c.qmu.Unlock()

			pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			err := c.post(pctx, "/bridge/events", map[string]any{"deviceId": c.o.Store.Get().DeviceID, "events": batch})
			cancel()
			if err != nil {
				fails++
				d := time.Duration(fails) * time.Second
				if d > 30*time.Second {
					d = 30 * time.Second
				}
				retryAt = time.Now().Add(d)
				c.log.Printf("hub: upload %d events: %v", len(batch), err)
				break
			}
			fails = 0
			c.lastSent.Store(nowMS())
			c.qmu.Lock()
			// the queue may have dropped from the front meanwhile; remove what we sent if still there
			k := 0
			for k < len(batch) && k < len(c.queue) && sameEvent(c.queue[k], batch[k]) {
				k++
			}
			c.queue = c.queue[k:]
			c.qmu.Unlock()
		}
	}
}

func sameEvent(a, b protocol.Event) bool {
	return a.TS == b.TS && a.Type == b.Type && a.SessionKey == b.SessionKey && a.ID == b.ID && a.Text == b.Text &&
		a.Status == b.Status && a.ApprovalID == b.ApprovalID
}

func nowMS() int64 { return time.Now().UnixMilli() }
