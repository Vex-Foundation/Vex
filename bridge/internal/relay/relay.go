// Package relay is the content-blind byte relay between the MCP client's
// stdio and the Vex Studio endpoint, and the ASYMMETRIC shutdown state machine
// the contract requires.
//
// The asymmetry is the whole point, and it is not an optimisation:
//
//   - stdin EOF means the CLIENT is done talking. The write side is
//     half-closed so the host sees a clean FIN, and the socket-to-stdout copy
//     is then DRAINED under a bound, because responses to already-sent
//     requests are still in flight and dropping them would look to the client
//     like the host answered nothing. A transport with NO half-close - a
//     Windows named pipe - skips the FIN, drains under the SAME bound and then
//     closes fully; `halfCloseOrDeadline` owns that choice and the Result says
//     which path was taken.
//   - socket EOF means the HOST is gone. stdout is closed and Run RETURNS
//     WITHOUT WAITING for the stdin reader, which is parked in a read that
//     nothing will ever complete. Waiting there is the hang this package
//     exists to prevent.
//   - a stdout write failure, a socket failure or a signal is a TEARDOWN, run
//     through one owner (closeConn) so the connection is destroyed exactly
//     once no matter which of the three fired first.
//
// A goroutine blocked on a read or write that no longer matters is abandoned
// deliberately: its only remaining owner is process exit, and the alternative
// is a teardown that waits for the very thing that is stuck. Every abandoned
// goroutine writes to a buffered channel, so none of them leaks a blocked send.
package relay

import (
	"errors"
	"io"
	"os"
	"time"
)

// Endpoint is the connection the relay owns. *net.UnixConn satisfies it, and
// so does the *os.File a Windows named pipe opens as; the interface exists so
// the state machine can also be driven by a scripted peer in a test without a
// real socket.
type Endpoint interface {
	io.ReadWriteCloser
}

// HalfCloser is an Endpoint that can close its WRITE side alone, leaving the
// read side open for the drain. *net.UnixConn implements it.
//
// A Windows named pipe DOES NOT. There is no FIN on a pipe: the only way to
// signal "no more input" is to close the handle, which closes both directions
// and would discard the answers still in flight. That difference is the reason
// `halfCloseOrDeadline` exists rather than a bare CloseWrite call, and it is
// documented in the contract's Windows section.
type HalfCloser interface {
	Endpoint
	CloseWrite() error
}

// halfCloseOrDeadline signals the client's stdin EOF to the host in the
// strongest way the transport allows.
//
// It reports whether a real half-close happened. When it did, the host sees a
// clean FIN, answers what is left and closes, and the drain normally finishes
// well inside its bound. When it did not, the connection stays fully open and
// the SAME drain bound is the only thing that ends the session - so the caller
// must report the difference rather than presenting a bound that elapsed as a
// clean close.
func halfCloseOrDeadline(conn Endpoint) (bool, error) {
	halfCloser, ok := conn.(HalfCloser)
	if !ok {
		return false, nil
	}
	if err := halfCloser.CloseWrite(); err != nil {
		return false, err
	}
	return true, nil
}

// DrainDeadline bounds the post-stdin-EOF drain.
//
// It lives HERE rather than in cmd/vex-mcp because this package is what
// enforces it: a bound whose owner cannot see it is a bound its own tests have
// to restate as a literal, and a literal is what let the fixture and the code
// drift without a failure. It matches the host's shutdown deadline (contract
// section 3) so neither side outlives the other, and the fixture's
// `bridgeDrainDeadlineMs` is compared against THIS constant.
const DrainDeadline = 5 * time.Second

// Outcome names how the relay ended. Each maps to one exit code and one
// stderr line in cmd/vex-mcp.
type Outcome int

const (
	// OutcomeClientEOF: stdin reached EOF, the write side was half-closed and
	// the peer's remaining output was drained to completion.
	OutcomeClientEOF Outcome = iota
	// OutcomeDrainDeadline: the same path, except the peer had not closed its
	// side when the drain bound elapsed. Reported, never silent. On a
	// transport with no half-close this is the ORDINARY end of a session, and
	// Result.HalfClosed is what tells the two apart.
	OutcomeDrainDeadline
	// OutcomePeerEOF: the host closed the connection.
	OutcomePeerEOF
	// OutcomeStdoutFailed: the relay could not hand bytes to the client.
	OutcomeStdoutFailed
	// OutcomeSocketFailed: the socket errored in either direction.
	OutcomeSocketFailed
	// OutcomeSignal: the process was asked to stop.
	OutcomeSignal
)

// Result is what Run reports. Err is nil for the two clean outcomes.
type Result struct {
	Outcome Outcome
	Err     error
	Signal  os.Signal
	// HalfClosed records whether the write side was actually half-closed when
	// the client's stdin reached EOF. False on a transport that cannot do it
	// (a Windows named pipe), which changes what a drain deadline MEANS and
	// therefore what the user is told.
	HalfClosed bool
}

// Options are the relay's collaborators and bounds. Every field is required
// except Signals and Prefix.
type Options struct {
	// In is the MCP client's stdin. Never closed here: the process owns it.
	In io.Reader
	// Out is the MCP client's stdout.
	Out io.Writer
	// Conn is the Vex Studio endpoint. Run owns its lifetime and closes it.
	Conn Endpoint
	// Prefix is bytes already read off the socket during the handshake, if
	// any. Written to Out before the copy starts so a coalesced ack loses
	// nothing.
	Prefix []byte
	// DrainDeadline bounds the post-CloseWrite drain.
	DrainDeadline time.Duration
	// Signals delivers termination requests. May be nil.
	Signals <-chan os.Signal
	// closeOut is called when the peer reaches EOF, so the client's reader
	// sees the end of the stream. Optional: a test writing into a buffer has
	// nothing to close.
	CloseOut func() error
}

type copyEnd struct {
	err error
}

// Run drives the relay until one of the six outcomes fires.
//
// It closes Conn exactly once, on every path, before returning.
func Run(opts Options) Result {
	// Guarded by nothing on purpose: closeConn is only ever called from this
	// goroutine, including through the defer. The copiers never close the
	// connection; they only report what happened to it.
	closed := false
	closeConn := func() {
		if closed {
			return
		}
		closed = true
		_ = opts.Conn.Close()
	}
	defer closeConn()

	if len(opts.Prefix) > 0 {
		if _, err := opts.Out.Write(opts.Prefix); err != nil {
			return Result{Outcome: OutcomeStdoutFailed, Err: err}
		}
	}

	// Buffered by exactly one send each: an abandoned copier must be able to
	// finish its send and exit rather than parking on an unread channel.
	toSocket := make(chan copyEnd, 1)
	toStdout := make(chan copyEnd, 1)

	go func() {
		_, err := io.Copy(opts.Conn, opts.In)
		toSocket <- copyEnd{err: err}
	}()
	go func() {
		_, err := io.Copy(opts.Out, opts.Conn)
		toStdout <- copyEnd{err: err}
	}()

	// Exactly one of these three fires. Every branch returns, so the relay has
	// no loop and no state to keep between events.
	select {
	case end := <-toSocket:
		if end.err != nil {
			// The client's stdin or the socket's write side failed. Either way
			// the session cannot continue.
			return Result{Outcome: OutcomeSocketFailed, Err: end.err}
		}
		// stdin EOF: signal it as strongly as the transport allows, then
		// drain. From here the ONLY events that matter are the drain
		// finishing, the bound elapsing, and a signal.
		halfClosed, err := halfCloseOrDeadline(opts.Conn)
		if err != nil {
			return Result{Outcome: OutcomeSocketFailed, Err: err}
		}
		return drain(opts, toStdout, opts.Signals, halfClosed)

	case end := <-toStdout:
		// The socket side ended. Close stdout so the client sees the end of the
		// stream, and RETURN WITHOUT WAITING for toSocket: the stdin reader is
		// parked in a read nothing will complete.
		closeOut(opts)
		if end.err != nil && !errors.Is(end.err, io.EOF) {
			return Result{Outcome: stdoutOrSocket(end.err), Err: end.err}
		}
		return Result{Outcome: OutcomePeerEOF}

	case sig := <-opts.Signals:
		// One owner, one teardown. Closing the connection unblocks both copiers
		// that are waiting on it; a copier blocked on a wedged stdout is
		// abandoned to process exit rather than waited for.
		closeConn()
		return Result{Outcome: OutcomeSignal, Signal: sig}
	}
}

// drain waits, under a bound, for the peer to finish answering after the
// client's stdin reached EOF.
func drain(opts Options, toStdout <-chan copyEnd, signals <-chan os.Signal, halfClosed bool) Result {
	timer := time.NewTimer(opts.DrainDeadline)
	defer timer.Stop()

	select {
	case end := <-toStdout:
		closeOut(opts)
		if end.err != nil && !errors.Is(end.err, io.EOF) {
			return Result{Outcome: stdoutOrSocket(end.err), Err: end.err, HalfClosed: halfClosed}
		}
		return Result{Outcome: OutcomeClientEOF, HalfClosed: halfClosed}
	case <-timer.C:
		// The bound elapsed with the peer still holding its side open. The
		// relay stops, and the caller REPORTS that the drain was cut short
		// rather than presenting it as a clean close. On a transport with no
		// half-close the peer was never TOLD to close, which is why
		// HalfClosed travels with the outcome.
		return Result{Outcome: OutcomeDrainDeadline, HalfClosed: halfClosed}
	case sig := <-signals:
		return Result{Outcome: OutcomeSignal, Signal: sig, HalfClosed: halfClosed}
	}
}

func closeOut(opts Options) {
	if opts.CloseOut != nil {
		_ = opts.CloseOut()
	}
}

// stdoutOrSocket keeps the two failure classes apart: io.Copy surfaces a
// write-side failure as ErrShortWrite or the writer's own error, and a
// read-side failure as the reader's. The distinction reaches the user as a
// different sentence and a different exit code, so it is not collapsed.
func stdoutOrSocket(err error) Outcome {
	if errors.Is(err, io.ErrShortWrite) || errors.Is(err, os.ErrClosed) {
		return OutcomeStdoutFailed
	}
	var stdoutErr *StdoutError
	if errors.As(err, &stdoutErr) {
		return OutcomeStdoutFailed
	}
	return OutcomeSocketFailed
}

// StdoutError wraps a failure to write to the MCP client. A caller that wants
// the distinction guaranteed rather than inferred wraps its stdout writer so
// its errors arrive typed.
type StdoutError struct{ Err error }

func (e *StdoutError) Error() string { return "writing to stdout: " + e.Err.Error() }
func (e *StdoutError) Unwrap() error { return e.Err }

// TypedStdout wraps w so its write failures arrive as *StdoutError and can be
// told apart from a socket failure with no guessing.
func TypedStdout(w io.Writer) io.Writer { return typedStdout{w} }

type typedStdout struct{ w io.Writer }

func (t typedStdout) Write(p []byte) (int, error) {
	n, err := t.w.Write(p)
	if err != nil {
		return n, &StdoutError{Err: err}
	}
	return n, nil
}
