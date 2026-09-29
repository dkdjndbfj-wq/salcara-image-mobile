package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const devicesFile = "devices.json"

type persistedDevice struct {
	Device   Device `json:"device"`
	LastSeen int64  `json:"lastSeen"`
}

type persistedState struct {
	Version  int                          `json:"version"`
	Accounts map[string][]persistedDevice `json:"accounts"`
}

// loadDevices reads devices.json into h.accounts. A missing file is fine.
func (h *Hub) loadDevices() error {
	if h.cfg.DataDir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(h.cfg.DataDir, devicesFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var st persistedState
	if err := json.Unmarshal(b, &st); err != nil {
		return fmt.Errorf("parse %s: %w", devicesFile, err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, devs := range st.Accounts {
		a := h.accountLocked(id)
		for _, pd := range devs {
			if pd.Device.DeviceID == "" {
				continue
			}
			a.devices[pd.Device.DeviceID] = &device{info: pd.Device, lastSeen: pd.LastSeen}
		}
	}
	return nil
}

// markDirty asks the saver goroutine to write devices.json soon.
func (h *Hub) markDirty() {
	if h.cfg.DataDir == "" {
		return
	}
	select {
	case h.dirty <- struct{}{}:
	default:
	}
}

func (h *Hub) saver() {
	defer close(h.saverDone)
	for {
		select {
		case <-h.dirty:
			h.saveNow()
		case <-h.done:
			select {
			case <-h.dirty:
				h.saveNow()
			default:
			}
			return
		}
	}
}

func (h *Hub) snapshot() persistedState {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := persistedState{Version: 1, Accounts: map[string][]persistedDevice{}}
	for id, a := range h.accounts {
		if len(a.devices) == 0 {
			continue
		}
		list := make([]persistedDevice, 0, len(a.devices))
		for _, d := range a.devices {
			ls := d.lastSeen
			if d.conn != nil {
				ls = nowMs()
			}
			list = append(list, persistedDevice{Device: d.info, LastSeen: ls})
		}
		st.Accounts[id] = list
	}
	return st
}

func (h *Hub) saveNow() {
	b, err := json.MarshalIndent(h.snapshot(), "", "  ")
	if err == nil {
		err = writeFileAtomic(filepath.Join(h.cfg.DataDir, devicesFile), b, 0o600)
	}
	if err != nil {
		h.log.Error("save devices failed", "err", err)
	}
}

// writeFileAtomic writes to a temp file in the same directory, fsyncs it and
// renames it over path.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".devices-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op after a successful rename
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
