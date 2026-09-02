//go:build !windows

// Command vex-pipe-front owns the Windows named pipe for the Vex Studio MCP
// host. This build exists so `go build ./...` and `go vet ./...` stay green on
// linux and darwin, and so a run on the wrong platform SAYS SO instead of
// silently serving nothing. The build-tag split follows
// cmd/spike-overlapped-stdio and cmd/vex-mcp/dial_unix.go.
package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
)

func main() {
	fmt.Fprintf(os.Stderr,
		"vex-pipe-front serves a Windows named pipe over inherited overlapped stdio, which exists only on Windows; %s cannot run it\n",
		runtime.GOOS)
	os.Exit(lifecycle.ExitUnsupported)
}
