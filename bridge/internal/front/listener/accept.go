// Package listener owns the front's side of the named pipe: the security
// descriptor it is created with, the runtime readback that BOUND reports, the
// raw handle count of protocol section 8.1, and the accept loop that never
// disarms.
//
// The accept loop and the raw handle count are PLATFORM-INDEPENDENT and take a
// net.Listener, so the 21-and-22nd rule - the part that is invisible in a test
// and only appears under the burst that fills the bound - is proven on every
// platform the module builds for. Only the pipe's creation and its flag and
// descriptor readback are Windows-only.
package listener

import (
	"errors"
	"net"
	"sync"
)

// MaxRawHandles is the front's raw accepted-connection bound: 21, the frozen
// `maxRaw` of HELLO and the endpoint contract's listener cap (16 established +
// 4 waiting to handshake + ONE overflow slot).
const MaxRawHandles = 21

// RawHandles is the front's count of OPEN HANDLES, not of logical connections
// main knows about.
//
// THE COUNTER BRACKETS THE HANDLE, NOT THE CONVERSATION (section 8.1):
//
//   - Acquire runs on Accept RETURNING a handle, BEFORE OPEN is queued. Counting
//     from OPEN would leave the window between Accept and OPEN uncounted, and a
//     burst would push the real handle count past the bound while the front
//     believed it was under it.
//   - Release runs only after the handle is PHYSICALLY CLOSED - not when the
//     front decides to close it, and not when PEER_CLOSED is queued. Releasing
//     early would admit a replacement against a slot the operating system still
//     holds.
//
// It has TWO owners by construction - the accept goroutine increments, each
// connection's close path decrements - which is exactly why it is a type with a
// lock rather than a field on either of them.
type RawHandles struct {
	mu   sync.Mutex
	live int
	peak int
}

// Acquire brackets one accepted handle and reports the resulting count and
// whether it is within the bound. A caller that gets admitted == false owns the
// slot until it Releases, and must close the handle immediately.
func (r *RawHandles) Acquire() (count int, admitted bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live++
	if r.live > r.peak {
		r.peak = r.live
	}
	return r.live, r.live <= MaxRawHandles
}

// Release records a PHYSICALLY closed handle.
func (r *RawHandles) Release() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.live > 0 {
		r.live--
	}
	return r.live
}

// Live is the number of handles currently open.
func (r *RawHandles) Live() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live
}

// Peak is the greatest number of handles ever open at once, for the structural
// log.
func (r *RawHandles) Peak() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.peak
}

// Sink receives what the accept loop produces. Every method runs on the accept
// goroutine.
type Sink interface {
	// Accepted hands over a handle whose raw slot is already held. Returning
	// false means the front is no longer serving, and the loop closes the
	// handle and releases the slot itself.
	Accepted(conn net.Conn) bool
	// Overflow reports the 22nd connection: already closed, already released,
	// never registered, and never given one byte in either direction.
	Overflow(count int)
	// AcceptFailed reports a failed Accept and decides whether the loop
	// continues. The listener being closed always stops it.
	AcceptFailed(err error) (retry bool)
}

// Serve is the accept loop, and it NEVER DISARMS.
//
// Leaving a connection pending in the operating system's backlog would block
// its bridge inside CreateFile with no answer and no error, which is strictly
// worse than a closed pipe: vex-mcp handles a connection that closes - an
// ordinary "server is busy" - and cannot handle one that never answers, because
// there is nothing to report and nothing to retry.
//
// The 22nd handle is closed SYNCHRONOUSLY on this goroutine, before it is
// handed to anything that retains it. It carries no refusal line, because main
// authors every line the peer sees (section 9) and main has not been told about
// this connection at all.
func Serve(l net.Listener, raw *RawHandles, sink Sink) {
	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || !sink.AcceptFailed(err) {
				return
			}
			continue
		}
		count, admitted := raw.Acquire()
		if !admitted {
			_ = conn.Close()
			raw.Release()
			sink.Overflow(count)
			continue
		}
		if !sink.Accepted(conn) {
			_ = conn.Close()
			raw.Release()
			return
		}
	}
}
