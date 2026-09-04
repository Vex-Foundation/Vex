//go:build !windows

package listener

// Bind has no meaning off Windows. The stub keeps `go build ./...` and
// `go vet ./...` green on linux and darwin and makes a run on the wrong
// platform SAY SO, the same build-tag split cmd/vex-mcp/dial_unix.go uses.
func Bind(pipeName string) (*Binding, error) { return nil, ErrBindUnsupported }
