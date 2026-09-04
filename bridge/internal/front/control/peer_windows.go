//go:build windows

package control

import (
	"errors"
	"syscall"
)

// errorBrokenPipe is ERROR_BROKEN_PIPE, what a Windows named pipe read returns
// when the client end is gone. errorPipeNotConnected is ERROR_PIPE_NOT_CONNECTED,
// the same fact observed a moment later.
const (
	errorBrokenPipe       syscall.Errno = 109
	errorPipeNotConnected syscall.Errno = 233
)

func isBrokenPipe(err error) bool {
	return errors.Is(err, errorBrokenPipe) || errors.Is(err, errorPipeNotConnected)
}
