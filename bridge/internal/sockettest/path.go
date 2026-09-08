// Package sockettest owns temporary AF_UNIX paths for bridge tests.
// Nothing in a shipped binary depends on it.
package sockettest

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
)

// Path creates a private socket directory directly under os.TempDir. Test
// names and testing.TempDir's GOTMPDIR must not consume the sun_path budget.
// The short random prefix follows the front fixtures' existing convention.
func Path(t testing.TB) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vf")
	if err != nil {
		t.Fatalf("creating the socket directory: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("removing the socket directory %q: %v", dir, err)
		}
	})
	path := filepath.Join(dir, "s")
	CheckPath(t, path)
	return path
}

// CheckPath enforces the production portable byte limit before a fixture
// binds, including fixtures whose endpoint-derived location is under test.
// The 103-byte payload leaves room for the terminator on macOS (104-byte
// storage), Linux and Windows (108-byte storage). A long OS temp root must
// fail here by name instead of surfacing as an opaque bind error or a skip.
func CheckPath(t testing.TB, path string) {
	t.Helper()
	if len(path) > endpoint.SunPathMaxBytes {
		t.Fatalf("unix socket fixture path is %d bytes, exceeds SunPathMaxBytes=%d: %q; use a shorter temporary root", len(path), endpoint.SunPathMaxBytes, path)
	}
}
