//go:build !windows

package endpoint_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
)

// resolvedTempDir is t.TempDir with the symlinks already taken out of it, for
// the cases that compare a PATH the product reports back.
//
// CaptureDirectoryChain pins the realpath chain as well as the lexical one -
// that is the whole point of the check - so the ancestor it names in a refusal
// is resolved. On macOS t.TempDir sits under `/var/folders/...`, and `/var` is
// a symlink to `/private/var`, so an expectation built from the raw temporary
// root disagrees with the product on darwin and nowhere else. Anchoring on the
// resolved root removes that platform artefact without touching the symlinks
// these cases deliberately create, which are their actual subject. Same
// anchoring as the host's studio/__tests__/mcp-host-bind.test.ts.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving the temporary root: %v", err)
	}
	return resolved
}

func TestDirectoryChainIdentityRefusesAncestorSwap(t *testing.T) {
	root := t.TempDir()
	ancestor := filepath.Join(root, "operator-root")
	parent := filepath.Join(ancestor, "private")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		t.Fatal(err)
	}

	identity, err := endpoint.CaptureDirectoryChain(parent)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(ancestor, filepath.Join(root, "held-original")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := identity.Verify(); err == nil {
		t.Fatal("ancestor replacement passed directory identity verification")
	}
}

func TestDirectoryChainIdentityPinsIntermediateSymlinkTargetChain(t *testing.T) {
	root := resolvedTempDir(t)
	targetRoot := filepath.Join(root, "target-root")
	heldTarget := filepath.Join(root, "held-target")
	realParent := filepath.Join(targetRoot, "private")
	if err := os.MkdirAll(realParent, 0o700); err != nil {
		t.Fatal(err)
	}

	lexicalRoot := filepath.Join(root, "operator-root")
	if err := os.Symlink(targetRoot, lexicalRoot); err != nil {
		t.Skipf("this filesystem does not support symlinks: %v", err)
	}
	lexicalParent := filepath.Join(lexicalRoot, "private")
	identity, err := endpoint.CaptureDirectoryChain(lexicalParent)
	if err != nil {
		t.Fatal(err)
	}

	// The lexical link and final directory identity remain stable. Only the
	// real target ancestor changes from a directory into a symlink, so the
	// independently captured realpath chain is required.
	if err := os.Rename(targetRoot, heldTarget); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(heldTarget, targetRoot); err != nil {
		t.Fatal(err)
	}

	if err := identity.Verify(); err == nil {
		t.Fatal("replacement behind a stable intermediate symlink passed verification")
	} else if want := endpoint.EndpointAncestorChangedRefusal(targetRoot); err.Error() != want {
		t.Fatalf("refusal %q, want %q", err.Error(), want)
	}
}
