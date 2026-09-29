// Package toolcfg points the local coding tools at the relay ("一键接入中转站"): Claude Code's
// ~/.claude/settings.json and Codex's ~/.codex/config.toml. Originals are backed up once to
// <file>.salcara-bak; "恢复原配置" puts the backup back.
package toolcfg

import (
	"errors"
	"os"
	"path/filepath"
)

// BackupSuffix is appended to the original file name.
const BackupSuffix = ".salcara-bak"

func hasBackup(path string) bool {
	st, err := os.Stat(path + BackupSuffix)
	return err == nil && st.Size() > 0
}

// backupOnce saves the original content if the file existed and no backup is present yet.
func backupOnce(path string, orig []byte, existed bool) error {
	if !existed || len(orig) == 0 || hasBackup(path) {
		return nil
	}
	return os.WriteFile(path+BackupSuffix, orig, 0o600)
}

// restoreBackup copies the backup back over path and removes it. ok=false if there was no backup.
func restoreBackup(path string) (bool, error) {
	b, err := os.ReadFile(path + BackupSuffix)
	if errors.Is(err, os.ErrNotExist) || (err == nil && len(b) == 0) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := writeFileKeepMode(path, b, 0o600); err != nil {
		return true, err
	}
	return true, os.Remove(path + BackupSuffix)
}

// writeFileKeepMode writes atomically-ish, keeping the existing file mode (or using def for new files).
func writeFileKeepMode(path string, data []byte, def os.FileMode) error {
	mode := def
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".salcara-tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return os.WriteFile(path, data, mode)
	}
	return nil
}
