package endpoint

import (
	"fmt"
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
