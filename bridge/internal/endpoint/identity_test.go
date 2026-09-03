//go:build !windows

package endpoint_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// AN ABSENT ENDPOINT DIRECTORY IS NOT A SWAPPED ONE.
//
// The measured defect: a client that scrubs XDG_RUNTIME_DIR derives the tmpdir
// form while the app listens under /run/user/<uid>, so the bridge captured the
// chain for a directory that had never existed and printed "the endpoint
// ancestor /tmp/vex-studio-1000 changed before use" - a sentence about a swap
// attack, for an ordinary "Vex is somewhere else". The derivation rung is the
// fix; this is the sentence for the case that remains.
func TestCaptureDirectoryChainNamesAnAbsentDirectoryAsAbsent(t *testing.T) {
	missing := filepath.Join(resolvedTempDir(t), "vex-studio-absent")
	if _, err := os.Lstat(missing); !os.IsNotExist(err) {
		t.Fatalf("the fixture path exists: %v", err)
	}

	identity, err := endpoint.CaptureDirectoryChain(missing)
	if err == nil {
		t.Fatalf("an absent directory captured a chain: %+v", identity)
	}
	var absent *endpoint.DirectoryMissingError
	if !errors.As(err, &absent) {
		t.Fatalf("refusal %q is not a DirectoryMissingError", err)
	}
	if absent.Path != missing {
		t.Fatalf("the refusal names %q, want the endpoint directory %q", absent.Path, missing)
	}
	if strings.Contains(err.Error(), string(endpoint.RefuseEndpointAncestorChanged)) {
		t.Fatalf("an absent directory still reports an ancestor change: %q", err)
	}
}

// The two sentences, and the clause that separates them. Naming a cause that
// does not apply ("your client did not forward XDG_RUNTIME_DIR") to a client
// that DID forward it is the same defect this test's neighbour closes.
func TestEndpointDirectoryMissingRefusalNamesTheForwardingCauseOnlyWhenItApplies(t *testing.T) {
	const dir = "/tmp/vex-studio-1000"
	forwarded := endpoint.EndpointDirectoryMissingRefusal(dir, true)
	scrubbed := endpoint.EndpointDirectoryMissingRefusal(dir, false)

	for _, sentence := range []string{forwarded, scrubbed} {
		if !strings.HasPrefix(sentence, string(endpoint.RefuseEndpointDirectoryMissing)+": ") {
			t.Fatalf("refusal %q does not carry its code prefix", sentence)
		}
		if !strings.Contains(sentence, dir) {
			t.Fatalf("refusal %q does not name the directory", sentence)
		}
		if !strings.Contains(sentence, "does not exist") {
			t.Fatalf("refusal %q does not say the directory is absent", sentence)
		}
	}
	if strings.Contains(forwarded, "XDG_RUNTIME_DIR") {
		t.Fatalf("a client that forwarded the variable is told it did not: %q", forwarded)
	}
	if !strings.Contains(scrubbed, "XDG_RUNTIME_DIR") {
		t.Fatalf("a scrubbed environment is not told the actionable cause: %q", scrubbed)
	}
}
