package endpoint

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

type directoryIdentity struct {
	path string
	info os.FileInfo
}

// DirectoryChainIdentity pins every existing ancestor through the socket's
// parent. The bridge verifies it again after dial and before any handshake byte.
type DirectoryChainIdentity struct {
	entries []directoryIdentity
}

// EndpointAncestorChangedRefusal is the frozen local-refusal shape shared
// independently with the TypeScript host.
func EndpointAncestorChangedRefusal(path string) string {
	return fmt.Sprintf("%s: The Vex Studio endpoint ancestor %s changed before use.",
		RefuseEndpointAncestorChanged, path)
}

// DirectoryMissingError is the endpoint directory NOT BEING THERE, which is a
// different fact from an ancestor that changed, and now says so.
//
// A distinct type rather than a distinct string because cmd/vex-mcp adds one
// clause this package cannot know: whether this process was given an
// XDG_RUNTIME_DIR at all. Callers match it with errors.As.
type DirectoryMissingError struct {
	// Path is the endpoint directory, absolute, as the plan named it.
	Path string
}

func (err *DirectoryMissingError) Error() string {
	return EndpointDirectoryMissingRefusal(err.Path, true)
}

// EndpointDirectoryMissingRefusal is the sentence for an endpoint directory
// that does not exist.
//
// WHY IT IS NOT "changed before use". A client that scrubs the environment
// derives the tmpdir form while the app, which can see XDG_RUNTIME_DIR, listens
// under it. The bridge then captured the chain for a /tmp/vex-studio-<uid> that
// had never existed and reported that its ancestor CHANGED - a sentence
// describing a swap attack, printed for an ordinary "Vex is somewhere else".
// The /run/user/<uid> rung in endpoint.go is what stops the two sides
// diverging; this is what the user is told when a directory is absent anyway.
//
// xdgRuntimeDirForwarded reports whether THIS process received the variable. It
// gates the second clause, because naming a cause that does not apply is the
// same defect in a smaller font.
func EndpointDirectoryMissingRefusal(path string, xdgRuntimeDirForwarded bool) string {
	sentence := fmt.Sprintf("%s: The Vex Studio endpoint directory %s does not exist. "+
		"Vex is not running for this configuration", RefuseEndpointDirectoryMissing, path)
	if xdgRuntimeDirForwarded {
		return sentence + "."
	}
	return sentence + ", or it is listening under XDG_RUNTIME_DIR, which this " +
		"client did not forward to the bridge."
}

func ancestorPaths(path string) []string {
	paths := []string{}
	for current := path; ; current = filepath.Dir(current) {
		paths = append(paths, current)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
	}
	for left, right := 0, len(paths)-1; left < right; left, right = left+1, right-1 {
		paths[left], paths[right] = paths[right], paths[left]
	}
	return paths
}

// CaptureDirectoryChain records device/inode identity through os.SameFile.
// The lexical chain pins intermediate symlinks themselves. The realpath chain
// also pins their target ancestors, because a stable intermediate link alone
// does not prove that its target chain was not replaced.
//
// SECURITY RESIDUAL. Go opens the endpoint by path rather than relative to held
// directory descriptors. A filesystem that removes and recreates an entry
// with the same path, kind, device and immediately reused inode between checks
// is indistinguishable to this identity proof. Descriptor-relative operations
// would close that residual, but no cross-platform stdlib API exposes them.
func CaptureDirectoryChain(parentDir string) (*DirectoryChainIdentity, error) {
	abs, err := filepath.Abs(parentDir)
	if err != nil {
		return nil, fmt.Errorf("%s", EndpointAncestorChangedRefusal(parentDir))
	}
	// ABSENT IS NOT CHANGED, and it is reported first: every check below fails
	// on a missing directory too, and the sentence they carry describes a
	// replacement that never happened.
	if _, statErr := os.Lstat(abs); errors.Is(statErr, fs.ErrNotExist) {
		return nil, &DirectoryMissingError{Path: abs}
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("%s", EndpointAncestorChangedRefusal(abs))
	}

	paths := append(ancestorPaths(abs), ancestorPaths(resolved)...)
	entries := make([]directoryIdentity, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		info, statErr := os.Lstat(path)
		if statErr != nil {
			return nil, fmt.Errorf("%s", EndpointAncestorChangedRefusal(path))
		}
		if !info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			return nil, fmt.Errorf("%s", EndpointAncestorChangedRefusal(path))
		}
		entries = append(entries, directoryIdentity{path: path, info: info})
	}
	return &DirectoryChainIdentity{entries: entries}, nil
}

// Verify refuses a same-path replacement, including an ancestor symlink swap.
func (identity *DirectoryChainIdentity) Verify() error {
	for _, recorded := range identity.entries {
		current, err := os.Lstat(recorded.path)
		if err != nil {
			return fmt.Errorf("%s", EndpointAncestorChangedRefusal(recorded.path))
		}
		if current.IsDir() != recorded.info.IsDir() ||
			current.Mode()&os.ModeSymlink != recorded.info.Mode()&os.ModeSymlink ||
			!os.SameFile(recorded.info, current) {
			return fmt.Errorf("%s", EndpointAncestorChangedRefusal(recorded.path))
		}
	}
	return nil
}
