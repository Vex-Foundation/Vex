//go:build !windows

package lifecycle

// Acquire has no meaning off Windows: the front's four framed planes arrive
// through the Microsoft C runtime's inherited-handle block, which exists only
// there. The stub keeps `go build ./...` and `go vet ./...` green on linux and
// darwin and makes a run on the wrong platform SAY SO, the same split
// cmd/probe-pipe-acl and cmd/vex-mcp/dial_unix.go already use.
//
// Every platform-independent test builds its planes with FromFiles instead.
func Acquire() (*Planes, error) { return nil, ErrPlanesUnsupported }
