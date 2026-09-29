package hub

import (
	"encoding/json"
	"sort"
	"sync"
	"time"
)

// Device is what the bridge registers (PROTOCOL.md §2). Tools and projects are
// kept as raw JSON so newer bridges can add fields without a hub upgrade.
type Device struct {
	DeviceID string          `json:"deviceId"`
	Name     string          `json:"name"`
	OS       string          `json:"os"`
	Version  string          `json:"version"`
	Tools    json.RawMessage `json:"tools"`
	Projects json.RawMessage `json:"projects"`
}

// DeviceStatus = Device + online + lastSeen (ms).
type DeviceStatus struct {
	Device
	Online   bool  `json:"online"`
	LastSeen int64 `json:"lastSeen"`
}

type storedEvent struct {
	seq        int64
	deviceID   string
	sessionKey string
	data       []byte // full JSON including seq and deviceId
}

// ring is a fixed-capacity FIFO of events ordered by seq.
type ring struct {
	buf   []*storedEvent
	start int
	n     int
}

func newRing(size int) *ring { return &ring{buf: make([]*storedEvent, size)} }

func (r *ring) push(e *storedEvent) {
	if r.n < len(r.buf) {
		r.buf[(r.start+r.n)%len(r.buf)] = e
		r.n++
		return
	}
	r.buf[r.start] = e
	r.start = (r.start + 1) % len(r.buf)
}

// after returns the buffered events with seq > after, oldest first.
func (r *ring) after(after int64) []*storedEvent {
	var out []*storedEvent
	for i := 0; i < r.n; i++ {
		e := r.buf[(r.start+i)%len(r.buf)]
		if e.seq > after {
			out = append(out, e)
		}
	}
	return out
}

type sessionBuf struct {
	ring    *ring
	updated int64 // seq of the last event, for eviction
}

type sseMsg struct {
	event string
	data  []byte
	seq   int64 // >0 for timeline events
}

type appSub struct {
	ch     chan sseMsg
	closed chan struct{}
	once   sync.Once
}

func (s *appSub) close() { s.once.Do(func() { close(s.closed) }) }

type bridgeConn struct {
	cmds   chan []byte
	closed chan struct{}
	once   sync.Once
}

func (c *bridgeConn) close() { c.once.Do(func() { close(c.closed) }) }

type device struct {
	info     Device
	lastSeen int64
	conn     *bridgeConn // nil while offline
}

func (d *device) status() DeviceStatus {
	st := DeviceStatus{Device: d.info, Online: d.conn != nil, LastSeen: d.lastSeen}
	if st.Online {
		st.LastSeen = nowMs()
	}
	if len(st.Tools) == 0 || string(st.Tools) == "null" {
		st.Tools = json.RawMessage("[]")
	}
	if len(st.Projects) == 0 || string(st.Projects) == "null" {
		st.Projects = json.RawMessage("[]")
	}
	return st
}

type account struct {
	id       string
	devices  map[string]*device
	seq      int64
	events   *ring
	sessions map[string]*sessionBuf
	apps     map[*appSub]struct{}
}

func sessionID(deviceID, sessionKey string) string { return deviceID + "\x00" + sessionKey }

func nowMs() int64 { return time.Now().UnixMilli() }

// accountLocked returns (creating if needed) the account. Caller holds h.mu.
func (h *Hub) accountLocked(id string) *account {
	a := h.accounts[id]
	if a == nil {
		a = &account{
			id:       id,
			devices:  map[string]*device{},
			seq:      h.seqBase,
			sessions: map[string]*sessionBuf{},
			apps:     map[*appSub]struct{}{},
		}
		h.accounts[id] = a
	}
	if a.events == nil {
		a.events = newRing(accountRingSize)
	}
	return a
}

// sendLocked delivers msg to every app stream of the account; a stream whose
// queue is full is dropped (the app reconnects with ?after=).
func (a *account) sendLocked(msg sseMsg) {
	for s := range a.apps {
		select {
		case s.ch <- msg:
		default:
			delete(a.apps, s)
			s.close()
		}
	}
}

func (a *account) broadcastDeviceLocked(d *device) {
	data, err := json.Marshal(d.status())
	if err != nil {
		return
	}
	a.sendLocked(sseMsg{event: "device", data: data})
}

func (a *account) deviceStatusesLocked() []DeviceStatus {
	out := make([]DeviceStatus, 0, len(a.devices))
	for _, d := range a.devices {
		out = append(out, d.status())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Online != out[j].Online {
			return out[i].Online
		}
		if out[i].LastSeen != out[j].LastSeen {
			return out[i].LastSeen > out[j].LastSeen
		}
		return out[i].DeviceID < out[j].DeviceID
	})
	return out
}

// appendEventLocked assigns the next seq, stores the event in the account and
// session buffers and fans it out. fields is the decoded event object.
func (a *account) appendEventLocked(deviceID string, fields map[string]json.RawMessage) (*storedEvent, error) {
	seq := a.seq + 1
	fields["seq"], _ = json.Marshal(seq)
	fields["deviceId"], _ = json.Marshal(deviceID)
	if _, ok := fields["ts"]; !ok {
		fields["ts"], _ = json.Marshal(nowMs())
	}
	var sk string
	if raw, ok := fields["sessionKey"]; ok {
		_ = json.Unmarshal(raw, &sk)
	}
	data, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	a.seq = seq
	e := &storedEvent{seq: seq, deviceID: deviceID, sessionKey: sk, data: data}
	a.events.push(e)
	if sk != "" {
		id := sessionID(deviceID, sk)
		sb := a.sessions[id]
		if sb == nil {
			if len(a.sessions) >= maxSessions {
				a.evictSessionLocked()
			}
			sb = &sessionBuf{ring: newRing(sessionRingSize)}
			a.sessions[id] = sb
		}
		sb.ring.push(e)
		sb.updated = seq
	}
	a.sendLocked(sseMsg{event: "event", data: data, seq: seq})
	return e, nil
}

func (a *account) evictSessionLocked() {
	var oldest string
	var min int64 = -1
	for id, sb := range a.sessions {
		if min < 0 || sb.updated < min {
			oldest, min = id, sb.updated
		}
	}
	delete(a.sessions, oldest)
}
