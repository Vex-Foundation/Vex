//go:build !windows

package main

import (
	"fmt"
	"os"
	"runtime"
)

// THE NON-WINDOWS BUILD SAYS SO AND STOPS.
//
// It exists so `go build ./...` and `go vet ./...` stay green on linux and
// darwin - the platforms this repository is developed on - and so a run on the
// wrong platform is a distinct, loud outcome rather than a silent measurement
// of something else. Same split, same reason, as
// cmd/vex-pipe-front/main_unsupported.go and cmd/vex-mcp/dial_unix.go.
func main() {
	fmt.Fprintf(os.Stderr,
		"probe-pipe-acl measures the access control on a Windows named pipe, which exists only on Windows; %s cannot run it\n",
		runtime.GOOS)
	os.Exit(exitUnsupported)
}
