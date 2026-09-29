//go:build !windows

package macapp

import (
	"os"
	"os/exec"
	"syscall"
)

// SpawnDetached starts exe with args in a new session (not a child LaunchServices or a terminal tracks),
// stdio on /dev/null, with extraEnv added. It does not wait.
func SpawnDetached(exe string, args []string, extraEnv ...string) error {
	cmd := exec.Command(exe, args...)
	cmd.Env = append(os.Environ(), extraEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
