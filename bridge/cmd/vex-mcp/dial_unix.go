//go:build !windows

package main

import (
	"context"
	"fmt"
	"runtime"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
)

// dialPipe does not exist off Windows, and says so rather than silently
// falling back to something that is not a pipe.
//
// It is the LAST of three guards on the same rule: planOverride refuses pipe
// syntax on a unix target by name (`override_pipe_on_unix`), dialEndpoint
// re-checks runtime.GOOS at the dial site, and this build-tagged stub means a
// unix binary contains no code that could open one at all.
func dialPipe(_ context.Context, path string) (handshake.Conn, error) {
	return nil, fmt.Errorf("named pipes do not exist on %s; refusing to open %s",
		runtime.GOOS, path)
}
