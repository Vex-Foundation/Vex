//go:build !windows

// Command spike-overlapped-stdio measures Windows overlapped inherited stdio.
// This build exists so `go build ./...` and `go vet ./...` stay green on linux
// and darwin, and so a run on the wrong platform SAYS SO instead of silently
// measuring something else. The build-tag split follows
// cmd/vex-mcp/dial_windows.go plus dial_unix.go.
package main

import (
	"fmt"
	"os"
	"runtime"
)

// exitUnsupported is distinct from every exit code the Windows build uses, so
// the harness can tell "wrong platform" from "the measurement broke".
const exitUnsupported = 2

func main() {
	fmt.Fprintf(os.Stderr,
		"spike-overlapped-stdio measures inherited OVERLAPPED stdio handles, which exist only on Windows; %s cannot run it\n",
		runtime.GOOS)
	os.Exit(exitUnsupported)
}
