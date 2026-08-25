package relay_test

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
	"github.com/Vex-Foundation/vex/bridge/internal/relay"
	"github.com/Vex-Foundation/vex/bridge/internal/vectors"
)

const projectID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

// A REAL socket pair. net.Pipe has no CloseWrite, and half-close is the exact
// behaviour the asymmetric shutdown depends on, so faking it would fake the
// property under test.
func socketPair(t *testing.T) (client *net.UnixConn, server *net.UnixConn) {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Skipf("this sandbox cannot bind a unix socket: %v", err)
	}
	defer listener.Close()

	accepted := make(chan *net.UnixConn, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			accepted <- nil
			return
		}
		accepted <- conn.(*net.UnixConn)
	}()

	dialed, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		t.Fatalf("dialling the test socket: %v", err)
	}
	server = <-accepted
	if server == nil {
		t.Fatal("the test listener did not accept")
	}
	client = dialed.(*net.UnixConn)
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	return client, server
}

// A reader that never returns, standing in for an MCP client that has sent its
// request and is waiting. Released on close so the test leaks nothing.
type blockingReader struct{ release chan struct{} }

func newBlockingReader(t *testing.T) *blockingReader {
	t.Helper()
	r := &blockingReader{release: make(chan struct{})}
	t.Cleanup(func() { close(r.release) })
	return r
}

func (r *blockingReader) Read(_ []byte) (int, error) {
	<-r.release
	return 0, io.EOF
}

// A writer that never returns, standing in for a client that stopped reading.
type blockingWriter struct{ release chan struct{} }

func newBlockingWriter(t *testing.T) *blockingWriter {
	t.Helper()
	w := &blockingWriter{release: make(chan struct{})}
	t.Cleanup(func() { close(w.release) })
	return w
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	<-w.release
	return len(p), nil
}

// syncWriter makes concurrent reads of what the relay produced race-free.
type syncWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncWriter) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func runAsync(opts relay.Options) <-chan relay.Result {
	done := make(chan relay.Result, 1)
	go func() { done <- relay.Run(opts) }()
	return done
}

func await(t *testing.T, done <-chan relay.Result, within time.Duration) relay.Result {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(within):
		t.Fatalf("the relay did not return within %s", within)
		return relay.Result{}
	}
}

// ── Case 1: a peer that never acks ──────────────────────────────────────────
//
// The bound is the whole contract here: without a deadline the bridge would
// hang for ever against a host that accepted the socket and then stalled, and
// the MCP client would show nothing at all.

func TestPeerThatNeverAcks(t *testing.T) {
	client, server := socketPair(t)
	// The server accepts, reads the handshake, and answers nothing.
	go func() {
		buf := make([]byte, 512)
		_, _ = server.Read(buf)
	}()

	start := time.Now()
	_, _, err := handshake.Perform(client, projectID, 300*time.Millisecond)
	if err == nil {
		t.Fatal("a silent peer must not produce an accepted handshake")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the ack deadline did not fire; waited %s", elapsed)
	}
	if !strings.Contains(err.Error(), "ack") {
		t.Fatalf("the failure must name the ack: %v", err)
	}
}

// ── Case 5: a malformed ack carrying embedded newlines ──────────────────────
//
// The line framing is the parser's, not the peer's: a message with newlines in
// it must not become two lines, and it must not reach a log as two lines
// either.

func TestMalformedAckWithEmbeddedNewlines(t *testing.T) {
	client, server := socketPair(t)
	go func() {
		buf := make([]byte, 512)
		_, _ = server.Read(buf)
		// A first line that is not a valid ack. Everything after the newline
		// is a second frame the bridge must never treat as the ack.
		_, _ = server.Write([]byte("{\"ok\":\"yes\"}\n{\"ok\":true}\n"))
	}()

	_, _, err := handshake.Perform(client, projectID, 2*time.Second)
	if err == nil {
		t.Fatal(`an ack whose "ok" is a string must be refused, not repaired from the next line`)
	}

	// And the diagnostic that reaches stderr is ONE line.
	line := handshake.Diagnostic("host said:\nok\r\nreally")
	if strings.ContainsAny(line, "\r\n") {
		t.Fatalf("a peer message forged a line break in the log: %q", line)
	}
}

// ── Case 2: socket EOF with stdin still open ────────────────────────────────
//
// The asymmetric half of the state machine. The stdin reader is parked in a
// read nothing will ever complete, and Run must NOT wait for it.

func TestSocketEOFReturnsWithoutWaitingForABlockedStdin(t *testing.T) {
	client, server := socketPair(t)
	out := &syncWriter{}
	closedOut := false

	go func() {
		_, _ = server.Write([]byte("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"))
		_ = server.Close()
	}()

	done := runAsync(relay.Options{
		In:            newBlockingReader(t),
		Out:           relay.TypedStdout(out),
		Conn:          client,
		DrainDeadline: 5 * time.Second,
		CloseOut:      func() error { closedOut = true; return nil },
	})

	result := await(t, done, 3*time.Second)
	if result.Outcome != relay.OutcomePeerEOF {
		t.Fatalf("outcome %v, want OutcomePeerEOF (err %v)", result.Outcome, result.Err)
	}
	if !closedOut {
		t.Error("the client's stdout must be closed so its reader sees the end of the stream")
	}
	if !strings.Contains(out.String(), `"id":1`) {
		t.Errorf("the peer's last frame was dropped: %q", out.String())
	}
}

// ── Case 3: stdin EOF with a peer that answers slowly ───────────────────────
//
// CloseWrite, then a BOUNDED drain. Cutting the drain short here would look to
// the client like the host answered nothing.

func TestStdinEOFHalfClosesThenDrainsADelayingPeer(t *testing.T) {
	client, server := socketPair(t)
	out := &syncWriter{}

	peerSawFIN := make(chan struct{})
	go func() {
		// Read until the bridge half-closes: that FIN is what tells the host
		// the client is done, and it is the reason CloseWrite exists.
		_, _ = io.Copy(io.Discard, server)
		close(peerSawFIN)
		time.Sleep(150 * time.Millisecond)
		_, _ = server.Write([]byte("{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n"))
		_ = server.Close()
	}()

	done := runAsync(relay.Options{
		In:            strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"ping\"}\n"),
		Out:           relay.TypedStdout(out),
		Conn:          client,
		DrainDeadline: 5 * time.Second,
	})

	select {
	case <-peerSawFIN:
	case <-time.After(3 * time.Second):
		t.Fatal("the peer never saw the half-close; CloseWrite did not reach it")
	}

	result := await(t, done, 5*time.Second)
	if result.Outcome != relay.OutcomeClientEOF {
		t.Fatalf("outcome %v, want OutcomeClientEOF (err %v)", result.Outcome, result.Err)
	}
	if !strings.Contains(out.String(), `"id":7`) {
		t.Fatalf("the drain lost the late response: %q", out.String())
	}
}

// The other half of the same case: a peer that holds its side open past the
// bound. The relay stops, and the outcome SAYS the drain was cut short rather
// than presenting it as a clean close.
func TestDrainDeadlineIsReportedNotHidden(t *testing.T) {
	client, server := socketPair(t)
	go func() { _, _ = io.Copy(io.Discard, server) }()

	done := runAsync(relay.Options{
		In:            strings.NewReader("x\n"),
		Out:           relay.TypedStdout(&syncWriter{}),
		Conn:          client,
		DrainDeadline: 150 * time.Millisecond,
	})
	result := await(t, done, 3*time.Second)
	if result.Outcome != relay.OutcomeDrainDeadline {
		t.Fatalf("outcome %v, want OutcomeDrainDeadline", result.Outcome)
	}
}

// ── Case 4: a blocked stdout ────────────────────────────────────────────────
//
// A client that stopped reading must not be able to wedge teardown. The copier
// parked in that write is abandoned to process exit; waiting for it would be
// waiting for the very thing that is stuck.

func TestBlockedStdoutCannotWedgeTeardown(t *testing.T) {
	client, server := socketPair(t)
	go func() {
		for i := 0; i < 64; i++ {
			if _, err := server.Write([]byte(strings.Repeat("y", 1024) + "\n")); err != nil {
				return
			}
		}
	}()

	signals := make(chan os.Signal, 1)
	done := runAsync(relay.Options{
		In:            newBlockingReader(t),
		Out:           relay.TypedStdout(newBlockingWriter(t)),
		Conn:          client,
		DrainDeadline: 5 * time.Second,
		Signals:       signals,
	})

	time.Sleep(100 * time.Millisecond)
	signals <- syscall.SIGTERM

	result := await(t, done, 3*time.Second)
	if result.Outcome != relay.OutcomeSignal {
		t.Fatalf("outcome %v, want OutcomeSignal", result.Outcome)
	}
	// The one owner ran: the connection is destroyed, so the peer sees the end.
	if _, err := client.Write([]byte("x")); err == nil {
		t.Error("the teardown owner did not close the connection")
	}
}

// A stdout failure is its OWN class: it reaches the user as a different
// sentence and a different exit code from a socket failure, so it must not be
// collapsed into one.
func TestStdoutFailureIsTypedApartFromASocketFailure(t *testing.T) {
	client, server := socketPair(t)
	go func() {
		_, _ = server.Write([]byte("frame\n"))
		time.Sleep(2 * time.Second)
	}()

	done := runAsync(relay.Options{
		In:            newBlockingReader(t),
		Out:           relay.TypedStdout(failingWriter{}),
		Conn:          client,
		DrainDeadline: 5 * time.Second,
	})
	result := await(t, done, 3*time.Second)
	if result.Outcome != relay.OutcomeStdoutFailed {
		t.Fatalf("outcome %v, want OutcomeStdoutFailed (err %v)", result.Outcome, result.Err)
	}
	if !errors.Is(result.Err, errStdoutGone) {
		t.Errorf("the original cause was lost: %v", result.Err)
	}
}

var errStdoutGone = errors.New("stdout is gone")

type failingWriter struct{}

func (failingWriter) Write(_ []byte) (int, error) { return 0, errStdoutGone }

// ── Case 6: signal teardown ─────────────────────────────────────────────────

func TestSignalTearsDownThroughOneOwner(t *testing.T) {
	client, server := socketPair(t)
	go func() { _, _ = io.Copy(io.Discard, server) }()

	signals := make(chan os.Signal, 1)
	done := runAsync(relay.Options{
		In:            newBlockingReader(t),
		Out:           relay.TypedStdout(&syncWriter{}),
		Conn:          client,
		DrainDeadline: 5 * time.Second,
		Signals:       signals,
	})

	time.Sleep(50 * time.Millisecond)
	signals <- syscall.SIGINT

	result := await(t, done, 3*time.Second)
	if result.Outcome != relay.OutcomeSignal {
		t.Fatalf("outcome %v, want OutcomeSignal", result.Outcome)
	}
	if result.Signal != syscall.SIGINT {
		t.Errorf("the signal was not carried through: %v", result.Signal)
	}
}

// A coalesced opening loses nothing: bytes the handshake read pulled in past
// the ack newline are handed to the client before the copy starts.
func TestPrefixBytesReachStdoutBeforeTheCopy(t *testing.T) {
	client, server := socketPair(t)
	out := &syncWriter{}
	go func() { _ = server.Close() }()

	done := runAsync(relay.Options{
		In:            newBlockingReader(t),
		Out:           relay.TypedStdout(out),
		Conn:          client,
		Prefix:        []byte("{\"early\":true}\n"),
		DrainDeadline: 5 * time.Second,
	})
	await(t, done, 3*time.Second)
	if !strings.HasPrefix(out.String(), `{"early":true}`) {
		t.Fatalf("the handshake remainder was dropped: %q", out.String())
	}
}

// The bounds this package enforces are the bounds the contract names.
//
// Compared against the PRODUCTION CONSTANTS, not against literals. The
// previous version restated 5000 and 2000 in the test, which made the
// assertion tautological in the only direction that matters: an edit to
// `DrainDeadline` or `DialTimeout` would have left the fixture, the contract
// and the running code disagreeing while this test stayed green. Now a drift
// on either side fails here.
func TestDrainBoundMatchesTheFixture(t *testing.T) {
	file, err := vectors.Load()
	if err != nil {
		t.Fatalf("loading the golden vectors: %v", err)
	}
	if got := int(relay.DrainDeadline.Milliseconds()); file.Limits["bridgeDrainDeadlineMs"] != got {
		t.Errorf("bridgeDrainDeadlineMs: fixture %d, relay.DrainDeadline %d",
			file.Limits["bridgeDrainDeadlineMs"], got)
	}
	if got := int(endpoint.DialTimeout.Milliseconds()); file.Limits["bridgeDialTimeoutMs"] != got {
		t.Errorf("bridgeDialTimeoutMs: fixture %d, endpoint.DialTimeout %d",
			file.Limits["bridgeDialTimeoutMs"], got)
	}
	// The bridge's own diagnostic bound travels in the same table, and the
	// binary that prints it is the one this fixture describes.
	if file.Limits["bridgeDiagnosticMaxBytes"] != handshake.DiagnosticMaxBytes {
		t.Errorf("bridgeDiagnosticMaxBytes: fixture %d, handshake.DiagnosticMaxBytes %d",
			file.Limits["bridgeDiagnosticMaxBytes"], handshake.DiagnosticMaxBytes)
	}
	if file.Limits["bridgeAckDeadlineMs"] != int(handshake.AckDeadline.Milliseconds()) {
		t.Errorf("bridgeAckDeadlineMs: fixture %d, handshake.AckDeadline %d",
			file.Limits["bridgeAckDeadlineMs"], handshake.AckDeadline.Milliseconds())
	}
}

// ── The Windows transport: an endpoint with NO half-close ───────────────────
//
// A named pipe has no FIN. `halfCloseOrDeadline` is the seam that keeps the
// unix arm on a true half-close while letting the pipe arm fall through to the
// drain bound, and these cases pin both halves of that contract from a Linux
// runner: the Windows-native behaviour itself is proven by the pipe round-trip
// and second-user denial tests on a Windows runner, which are the merge gate.

// noHalfClose wraps a connection so it deliberately does NOT satisfy
// relay.HalfCloser, the way an *os.File opened on a named pipe does not.
type noHalfClose struct{ inner io.ReadWriteCloser }

func (n noHalfClose) Read(p []byte) (int, error)  { return n.inner.Read(p) }
func (n noHalfClose) Write(p []byte) (int, error) { return n.inner.Write(p) }
func (n noHalfClose) Close() error                { return n.inner.Close() }

func TestStdinEOFOnATransportWithoutHalfCloseStillDrains(t *testing.T) {
	client, server := socketPair(t)
	out := &syncWriter{}

	go func() {
		// The peer answers and then closes ITS side. Without a half-close the
		// bridge cannot tell the peer the client is done, so the peer's own
		// close is what ends the drain early - and every answered byte must
		// still reach stdout.
		buf := make([]byte, 512)
		if _, err := server.Read(buf); err != nil {
			return
		}
		_, _ = server.Write([]byte("{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}\n"))
		_ = server.Close()
	}()

	done := runAsync(relay.Options{
		In:            strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\"}\n"),
		Out:           relay.TypedStdout(out),
		Conn:          noHalfClose{inner: client},
		DrainDeadline: 5 * time.Second,
	})

	result := await(t, done, 8*time.Second)
	if result.Err != nil {
		t.Fatalf("a transport with no half-close reported a failure: %v", result.Err)
	}
	if result.HalfClosed {
		t.Fatal("HalfClosed is true on a transport that cannot half-close")
	}
	if !strings.Contains(out.String(), `"id":9`) {
		t.Fatalf("the drain lost the answer: %q", out.String())
	}
}

// The bound is what ends the session when the peer never closes either. It
// must be REPORTED as such, and HalfClosed is what lets the caller say WHY:
// "the host would not close" and "this transport cannot ask it to" are
// different facts and get different sentences in cmd/vex-mcp.
func TestDrainBoundEndsASessionWithoutHalfClose(t *testing.T) {
	client, server := socketPair(t)
	out := &syncWriter{}
	defer func() { _ = server.Close() }()

	go func() { _, _ = io.Copy(io.Discard, server) }()

	done := runAsync(relay.Options{
		In:            strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n"),
		Out:           relay.TypedStdout(out),
		Conn:          noHalfClose{inner: client},
		DrainDeadline: 150 * time.Millisecond,
	})

	result := await(t, done, 5*time.Second)
	if result.Outcome != relay.OutcomeDrainDeadline {
		t.Fatalf("outcome %v, want OutcomeDrainDeadline", result.Outcome)
	}
	if result.HalfClosed {
		t.Fatal("HalfClosed is true on a transport that cannot half-close")
	}
}

// The unix arm KEEPS its true half-close. This is the regression the seam
// could plausibly cause: a refactor that routed both transports through the
// weaker path would leave the host waiting for an EOF that never came.
func TestUnixArmStillReportsARealHalfClose(t *testing.T) {
	client, server := socketPair(t)
	out := &syncWriter{}

	peerSawFIN := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, server)
		close(peerSawFIN)
		_ = server.Close()
	}()

	done := runAsync(relay.Options{
		In:            strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n"),
		Out:           relay.TypedStdout(out),
		Conn:          client,
		DrainDeadline: 5 * time.Second,
	})

	select {
	case <-peerSawFIN:
	case <-time.After(3 * time.Second):
		t.Fatal("the peer never saw the half-close")
	}
	result := await(t, done, 5*time.Second)
	if result.Outcome != relay.OutcomeClientEOF {
		t.Fatalf("outcome %v, want OutcomeClientEOF", result.Outcome)
	}
	if !result.HalfClosed {
		t.Fatal("a unix socket must report a REAL half-close")
	}
}
