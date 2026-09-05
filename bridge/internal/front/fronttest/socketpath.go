// Package fronttest holds the helpers the front's test suites share. It is
// imported by tests only; nothing in a shipped binary depends on it.
package fronttest

import (
	"os"
	"path/filepath"
	"testing"
)

// SocketPath returns a path for a unix socket that stands in for the named
// pipe, short enough to bind on every platform the suites run on.
//
// A unix socket path is bounded by sun_path: 108 bytes on Linux and Windows,
// 104 on macOS. `t.TempDir()` embeds the full test name, and a descriptive
// name such as TestReadbackMismatchReportsSddlReadbackMismatchAndExits pushed
// the path past the bound on the Windows runner, where bind answered EINVAL
// ("bind: invalid argument") for eight suites at once (run 33641189028). The
// directory is therefore created directly under the OS temp root with a
// two-letter prefix, and removed when the test ends.
func SocketPath(t testing.TB) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vf")
	if err != nil {
		t.Fatalf("creating the socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "s")
}
