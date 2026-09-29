package agents

import (
	"os"
	"testing"

	"salcara/bridge/internal/testfake"
)

// The test binary doubles as fake `codex`, fake `claude` and the `mcp-approval` helper when
// SALCARA_FAKE=1 is set in its environment (children inherit it from the test).
func TestMain(m *testing.M) {
	if os.Getenv("SALCARA_FAKE") == "1" {
		testfake.Run(os.Args[1:])
		os.Exit(0)
	}
	os.Exit(m.Run())
}
