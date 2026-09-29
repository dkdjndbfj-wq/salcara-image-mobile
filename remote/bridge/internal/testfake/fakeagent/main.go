// Command fakeagent is a stand-in for the real `codex` and `claude` CLIs in end-to-end tests
// (see internal/testfake). It can also play `node`: npm installs codex / claude as scripts starting with
// `#!/usr/bin/env node`, so the kernel runs `node /path/to/codex <args>`. When started under the name
// "node", fakeagent drops the script path and behaves like the tool — which only works if the bridge put
// the folder containing "node" on the child's PATH, exactly the macOS LaunchAgent problem under test.
package main

import (
	"os"
	"path/filepath"
	"strings"

	"salcara/bridge/internal/testfake"
)

func main() {
	args := os.Args[1:]
	if strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") == "node" && len(args) > 0 {
		args = args[1:] // the script path
	}
	testfake.Run(args)
}
