package control

import (
	"errors"
	"io"
	"net"
	"syscall"
)

// isPeerGone separates "the peer left" from "the handle failed", which is the
// only distinction PEER_CLOSED's structural reason carries (protocol section
// 6.3). Both end the connection; neither is a domain cause.
func isPeerGone(err error) bool {
	return errors.Is(err, io.EOF) ||
		errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, syscall.ECONNRESET) ||
		isBrokenPipe(err)
}
