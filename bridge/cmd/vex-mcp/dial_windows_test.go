//go:build windows

package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
	"github.com/Vex-Foundation/vex/bridge/internal/relay"
)

// ROWS 5 AND 6 OF CONTRACT 1.6, MEASURED ON THE HANDLE THAT SHIPS.
//
// `bridge-endpoint-contract.md` section 1.6 held two rows open on the strength
// of source reading alone:
//
//   - row 5, OVERLAPPED DUPLEX: a read and a write outstanding TOGETHER on the
//     same handle, both completing. That is the property
//     `FILE_FLAG_OVERLAPPED` exists for in `dialPipe`, and a synchronous handle
//     deadlocks on exactly this pattern because the Windows I/O manager
//     serializes operations on the file object.
//   - row 6, DEADLINE AND CLOSE CANCELLATION: `SetDeadline` taking effect on
//     the handle (the `internal/poll.setDeadlineImpl` claim written up in
//     `dial_windows.go`), the handshake's ack bound firing against a host that
//     accepts and never answers, the relay's drain bound firing against the
//     same host, and `Close` returning a read that is parked in the kernel.
//
// The `studio-overlapped-spike` job measured the equivalent properties for
// INHERITED STDIO handles under Electron, which is a different handle from a
// different creator; it is deleted with this change and these tests are what
// replace it for the transport that ships. Its surviving numbers live in
// `pipe-front-protocol.md` section 1 and its limits table.
//
// WHAT THESE TESTS ARE NOT. They are single-account, in-process measurements of
// HANDLE BEHAVIOUR. The cross-user rows (1, 2, 7, 8) are the two-account step of
// the `bridge-windows` job, and row 4 is the real host and the real built
// bridge on the `vex-app-windows` lane. Neither is claimed here.
//
// NO SLEEP STANDS IN FOR A PROOF. Every wait below is a channel join under a
// bounded timer, and the timer's only job is to turn a hang into a failing test
// instead of a wedged suite; the proof is always the value that arrives. The
// pattern - a real endpoint driven inside the test process, with the platform
// work quarantined by build tag and by name rather than by a silent skip - is
// VS Code's (`src/vs/base/parts/ipc/test/node/ipc.net.test.ts`, `flakySuite
// 'IPC, create handle'`) and go-winio's (`pipe_test.go`).
//
// The pipe servers are the package's own stdlib `newTestPipeServer`
// (CreateNamedPipeW on `modkernel32`, hostauth_windows_test.go). `cmd/vex-mcp`
// links the standard library and this module and nothing else, in tests too;
// `cmd/vex-pipe-front/imports_test.go` is the gate that holds it there.

// pipeJoinBudget is the watchdog on every channel join in this file. It is NOT
// a measured bound: each test asserts on the value it receives, and this only
// decides how long a hang takes to become a red test.
const pipeJoinBudget = 30 * time.Second

// handshakeProjectID is a syntactically ordinary project id. Nothing in these
// tests depends on its value; the host never answers.
const handshakeProjectID = "6b2f7d18-0f6a-4a6f-9d1e-2f4c8a1b3e57"

// joinWithin waits for one value under the watchdog, so a lost completion fails
// this test instead of parking the suite.
func joinWithin[T any](t *testing.T, what string, done <-chan T) T {
	t.Helper()
	timer := time.NewTimer(pipeJoinBudget)
	defer timer.Stop()
	select {
	case value := <-done:
		return value
	case <-timer.C:
		t.Fatalf("%s did not complete within %s", what, pipeJoinBudget)
		var zero T
		return zero
	}
}

// pipeReadResult is one completed read on the client side of the pipe.
type pipeReadResult struct {
	data []byte
	err  error
}

// serverWrite writes on the server side of a test pipe. The server's outbound
// buffer is empty in every call site here, so this never blocks.
func serverWrite(t *testing.T, server syscall.Handle, payload []byte) {
	t.Helper()
	var written uint32
	if err := syscall.WriteFile(server, payload, &written, nil); err != nil {
		t.Fatalf("the test pipe server could not write %d bytes: %v", len(payload), err)
	}
	if int(written) != len(payload) {
		t.Fatalf("the test pipe server wrote %d of %d bytes", written, len(payload))
	}
}

// ROW 5. A READ AND A WRITE OUTSTANDING TOGETHER ON THE HANDLE dialPipe OPENS.
//
// The concurrency is not asserted from timing, and it is not left to goroutine
// scheduling. It is CONSTRUCTED and then OBSERVED:
//
//  1. the client writes a payload far larger than the pipe's kernel buffers, so
//     the write cannot complete until the server has consumed all of it;
//  2. the server takes a 64-byte PREFIX and stops. At that instant the write is
//     provably still outstanding - a 1 MiB write cannot have returned when
//     4096-byte buffers plus 64 consumed bytes account for its bytes - and the
//     test checks that its completion channel is still empty;
//  3. with the write pending, the server answers on the other direction and the
//     client READS that answer. On a synchronous handle this read would be
//     queued behind the pending write and could never complete, which is the
//     deadlock `FILE_FLAG_OVERLAPPED` exists to prevent;
//  4. the write is checked to be STILL pending at the moment the read returned,
//     so the two were outstanding at the same time rather than in sequence;
//  5. the server drains the rest and both operations are joined, byte-verified.
//
// Step 4 is what makes this a duplex measurement rather than two round trips.
func TestPipeDialSupportsConcurrentDuplex(t *testing.T) {
	name := testPipeName(t)
	server := newTestPipeServer(t, name)

	client, err := dialPipe(name)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	defer client.Close()

	// 1 MiB against 4096-byte in and out buffers: two orders of magnitude of
	// margin, so "the write is still outstanding" is arithmetic, not a hope.
	payload := bytes.Repeat([]byte("vex-studio-duplex"), 1<<20/17)
	writeDone := make(chan error, 1)
	go func() {
		_, writeErr := client.Write(payload)
		writeDone <- writeErr
	}()

	prefix := make([]byte, 64)
	var prefixRead uint32
	if err := syscall.ReadFile(server, prefix, &prefixRead, nil); err != nil {
		t.Fatalf("the test pipe server could not read the head of the client's write: %v", err)
	}
	if prefixRead == 0 {
		t.Fatal("the test pipe server read zero bytes, so the client's write never started and " +
			"nothing below would be concurrent with anything")
	}
	select {
	case writeErr := <-writeDone:
		t.Fatalf("the %d-byte write completed while the server had taken only %d bytes (err %v); "+
			"the rest cannot have been delivered, so this pipe is not behaving as measured",
			len(payload), prefixRead, writeErr)
	default:
	}

	// THE WRITE IS PENDING FROM HERE UNTIL THE DRAIN BELOW.
	reply := []byte("pong")
	serverWrite(t, server, reply)

	readDone := make(chan pipeReadResult, 1)
	go func() {
		buffer := make([]byte, len(reply))
		n, readErr := io.ReadFull(client, buffer)
		readDone <- pipeReadResult{data: buffer[:n], err: readErr}
	}()
	got := joinWithin(t, "the client's read while its own write is outstanding", readDone)
	if got.err != nil {
		t.Fatalf("the concurrent read failed: %v", got.err)
	}
	if !bytes.Equal(got.data, reply) {
		t.Fatalf("the concurrent read returned %q, want %q", got.data, reply)
	}

	// THE ASSERTION THE TEST EXISTS FOR: the read came back while the write on
	// the SAME handle had not.
	select {
	case writeErr := <-writeDone:
		t.Fatalf("the write completed before the concurrent read was joined (err %v); the two "+
			"operations were sequential and this run proves nothing about duplex", writeErr)
	default:
	}

	drainDone := make(chan pipeReadResult, 1)
	go func() {
		drained := make([]byte, 0, len(payload))
		drained = append(drained, prefix[:prefixRead]...)
		buffer := make([]byte, 32*1024)
		for len(drained) < len(payload) {
			var n uint32
			if drainErr := syscall.ReadFile(server, buffer, &n, nil); drainErr != nil {
				drainDone <- pipeReadResult{data: drained, err: drainErr}
				return
			}
			if n == 0 {
				drainDone <- pipeReadResult{data: drained, err: io.ErrUnexpectedEOF}
				return
			}
			drained = append(drained, buffer[:n]...)
		}
		drainDone <- pipeReadResult{data: drained}
	}()

	drained := joinWithin(t, "the server's drain of the client's write", drainDone)
	if drained.err != nil {
		t.Fatalf("the server drained %d of %d bytes and then failed: %v",
			len(drained.data), len(payload), drained.err)
	}
	if !bytes.Equal(drained.data, payload) {
		t.Fatalf("the server received %d bytes that do not match the %d written; a duplex handle "+
			"must not corrupt or reorder either direction", len(drained.data), len(payload))
	}
	if writeErr := joinWithin(t, "the client's write", writeDone); writeErr != nil {
		t.Fatalf("the concurrent write failed: %v", writeErr)
	}
}

// ROW 6, FIRST PART. THE HANDLE TAKES A REAL DEADLINE, AND IT FIRES.
//
// `dial_windows.go` asserts, from the installed go1.27.0 sources, that
// `internal/poll.setDeadlineImpl` returns `ErrNoDeadline` only for a handle the
// runtime poller did not take, and therefore that an overlapped handle honours
// `SetDeadline`. That was a reading of source; this is the measurement. Both
// halves matter: a call that returns nil and never fires would satisfy
// `handshake.Perform` into skipping its close-the-handle watchdog and leave the
// ack bound unenforced.
func TestPipeHandleTakesARealDeadline(t *testing.T) {
	name := testPipeName(t)
	newTestPipeServer(t, name)

	client, err := dialPipe(name)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	defer client.Close()

	if err := client.SetDeadline(time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("SetDeadline on the overlapped pipe handle returned %v; the poller did not take "+
			"the handle, so handshake.Perform falls back to its close watchdog and dial_windows.go's "+
			"setDeadlineImpl note is wrong", err)
	}

	// dialPipe hands back the handshake.Conn the production path uses, whose
	// only bound is the both-directions SetDeadline that Perform calls. The
	// server writes nothing, so a read is what the bound has to end.
	if err := client.SetDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatalf("SetDeadline on the overlapped pipe handle returned %v", err)
	}
	deadlined := make(chan error, 1)
	go func() {
		_, readErr := client.Read(make([]byte, 1))
		deadlined <- readErr
	}()
	readErr := joinWithin(t, "a read on a handle whose deadline has passed", deadlined)
	if readErr == nil {
		t.Fatal("a read against a silent server returned with no error and no bytes owed to it")
	}
	if !errors.Is(readErr, os.ErrDeadlineExceeded) {
		t.Fatalf("the deadlined read failed with %v, not os.ErrDeadlineExceeded; the bound did not "+
			"fire, something else ended the read", readErr)
	}

	// CLEARING IT IS PART OF THE CONTRACT: Perform clears the deadline before
	// handing the connection to the relay, and a deadline left in place would
	// kill a healthy long-lived session.
	if err := client.SetDeadline(time.Time{}); err != nil {
		t.Fatalf("clearing the deadline on the pipe handle returned %v", err)
	}
}

// ROW 6, SECOND PART. THE ACK DEADLINE FIRES AGAINST A HOST THAT NEVER ANSWERS.
//
// The pipe server accepts the client and reads nothing and writes nothing,
// which is the failure the contract's 5000 ms ack bound exists for: without it
// the bridge parks forever on a host that connected and went quiet. The bound
// here is deliberately short - what is under test is that it FIRES, not its
// production value, which `handshake.AckDeadline` owns and the fixture pins.
func TestPipeAckDeadlineFiresOnASilentHost(t *testing.T) {
	name := testPipeName(t)
	server := newTestPipeServer(t, name)

	conn, err := dialPipe(name)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	type ackResult struct {
		ack handshake.Ack
		err error
	}
	done := make(chan ackResult, 1)
	go func() {
		ack, _, performErr := handshake.Perform(conn, handshakeProjectID, 250*time.Millisecond)
		done <- ackResult{ack: ack, err: performErr}
	}()

	got := joinWithin(t, "handshake.Perform against a silent pipe server", done)
	if got.err == nil {
		t.Fatalf("the handshake reported the ack %+v from a server that never wrote one", got.ack)
	}
	if !errors.Is(got.err, os.ErrDeadlineExceeded) {
		t.Fatalf("the handshake ended with %v, not the deadline; on this handle the bound must be "+
			"the poller's deadline rather than the close-the-handle watchdog", got.err)
	}

	// THE REQUEST DID LEAVE: the bound is on the ACK, not on the write, and a
	// test where nothing was ever sent would prove the wrong thing.
	outcome := serverRead(t, server)
	if outcome.err != nil {
		t.Fatalf("the pipe server could not read the handshake line the bridge sent: %v",
			outcome.err)
	}
	if outcome.n == 0 {
		t.Fatal("the pipe server received no handshake line, so the deadline that fired was not " +
			"the wait for an ack")
	}
}

// ROW 6, THIRD PART. THE DRAIN DEADLINE FIRES ON THE PIPE, AND SAYS SO.
//
// The client's stdin is at EOF immediately. A named pipe has no half-close, so
// `relay.halfCloseOrDeadline` reports false and the host is never TOLD to
// close; the drain bound is then the only thing that ends the session. Both
// halves of the result are the contract: the outcome is `OutcomeDrainDeadline`
// AND `HalfClosed` is false, which is what stops a bound that merely elapsed
// from being reported to the user as a clean close.
func TestPipeDrainDeadlineFiresOnASilentHost(t *testing.T) {
	name := testPipeName(t)
	newTestPipeServer(t, name)

	conn, err := dialPipe(name)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	// relay.Run owns this connection and closes it on every path.

	done := make(chan relay.Result, 1)
	go func() {
		done <- relay.Run(relay.Options{
			In:            bytes.NewReader(nil),
			Out:           io.Discard,
			Conn:          conn,
			DrainDeadline: 250 * time.Millisecond,
		})
	}()

	result := joinWithin(t, "relay.Run over the pipe with a silent host", done)
	if result.Outcome != relay.OutcomeDrainDeadline {
		t.Fatalf("the relay ended with outcome %d (err %v); a silent pipe host must end the "+
			"session on the drain bound", result.Outcome, result.Err)
	}
	if result.HalfClosed {
		t.Fatal("the relay reported a half-close on a named pipe; *os.File has no CloseWrite, so " +
			"the user would be told the host was asked to finish when it never was")
	}
}

// ROW 6, FOURTH PART. CLOSE RETURNS A READ THAT IS PARKED IN THE KERNEL.
//
// Shutdown must not leave a goroutine on a read forever, and `handshake.Perform`
// falls back to CLOSING the handle when a transport cannot carry a deadline, so
// close-cancels-a-read is load bearing on both paths.
//
// THE READ IS PROVABLY IN THE READ PATH BEFORE THE CLOSE. The reader goroutine
// first completes a PRIMING read of one byte the server sends, and that
// completion is joined here; only then does it issue the read that the close
// must cancel, and the test checks that this second read has not completed
// before calling Close. The residual - the instant between the priming read
// returning and the second read entering the kernel - cannot be closed from
// user space, and it is not the failure this test guards: a close that did not
// cancel would hang, and a hang fails at the join.
func TestClosingThePipeCancelsABlockedRead(t *testing.T) {
	name := testPipeName(t)
	server := newTestPipeServer(t, name)

	client, err := dialPipe(name)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	// Closed by the test itself: the close IS the measurement.

	reads := make(chan pipeReadResult, 2)
	go func() {
		for i := 0; i < 2; i++ {
			buffer := make([]byte, 1)
			n, readErr := io.ReadFull(client, buffer)
			reads <- pipeReadResult{data: buffer[:n], err: readErr}
			if readErr != nil {
				return
			}
		}
	}()

	serverWrite(t, server, []byte("a"))
	primed := joinWithin(t, "the priming read", reads)
	if primed.err != nil {
		t.Fatalf("the priming read failed: %v", primed.err)
	}
	if !bytes.Equal(primed.data, []byte("a")) {
		t.Fatalf("the priming read returned %q, want %q", primed.data, "a")
	}

	select {
	case second := <-reads:
		t.Fatalf("the second read completed (%q, %v) before anything closed the handle; there was "+
			"no blocked read for Close to cancel", second.data, second.err)
	default:
	}

	if err := client.Close(); err != nil {
		t.Fatalf("closing the pipe handle failed: %v", err)
	}

	cancelled := joinWithin(t, "the read that was blocked when the handle closed", reads)
	if cancelled.err == nil {
		t.Fatalf("closing the handle returned the blocked read with no error and %q; a read that "+
			"survives its own handle is the hang this test exists to catch", cancelled.data)
	}
	if len(cancelled.data) != 0 {
		t.Fatalf("the cancelled read produced %q; a cancelled read returns no bytes", cancelled.data)
	}
	// Go maps a close under a pending operation to ErrFileClosing, and the
	// kernel may surface the cancellation itself as ERROR_OPERATION_ABORTED.
	// Both are the close cancelling the read; anything else - a deadline, a
	// broken pipe - would mean something other than the close ended it.
	const errorOperationAborted syscall.Errno = 995
	if !errors.Is(cancelled.err, os.ErrClosed) && !errors.Is(cancelled.err, errorOperationAborted) {
		t.Fatalf("the blocked read ended with %v, which is neither os.ErrClosed nor "+
			"ERROR_OPERATION_ABORTED; the close is not what returned it", cancelled.err)
	}
}

// THE DIAL HAS A BOUND, AND EXHAUSTION HAS A NAME.
//
// The defect this pins: CreateFile against a named pipe whose every instance
// is busy returns ERROR_PIPE_BUSY at once, and the client that wants to wait
// must loop. Before this change there was no loop and no deadline of any kind
// on this path, so a saturated front spent an MCP client's whole startup
// budget (Claude Code's MCP_TIMEOUT, 30 s by default) inside the open and the
// user was shown "connection timeout" with no cause at all.
//
// The endpoint is REAL: a single-instance pipe served by this process, with
// its one instance already taken by a client handle this test holds open, so
// the dial under test meets the genuine ERROR_PIPE_BUSY the loop exists for.
// The budget is milliseconds because the subject is the deadline being
// honoured, not its production value.
func TestDialPipeGivesUpOnABusyPipeWithANamedSentence(t *testing.T) {
	name := testPipeName(t)
	newTestPipeServer(t, name)

	// TAKE THE ONE INSTANCE. From here every further CreateFile on this name
	// answers ERROR_PIPE_BUSY.
	occupier, err := dialPipeWith(name, resolveServerUserSID, resolveCurrentUserSID)
	if err != nil {
		t.Fatalf("occupying the pipe's single instance: %v", err)
	}
	defer occupier.Close()

	const budget = 60 * time.Millisecond
	started := time.Now()
	conn, err := dialPipeWithin(name, budget, resolveServerUserSID, resolveCurrentUserSID)
	elapsed := time.Since(started)
	if conn != nil {
		_ = conn.Close()
		t.Fatal("a busy pipe must not yield a connection")
	}
	timeout, ok := asDialTimeout(err)
	if !ok {
		t.Fatalf("a busy pipe must give up as a bounded dial, got %T: %v", err, err)
	}
	if !strings.Contains(timeout.Error(), dialTimeoutRefusalCode) {
		t.Fatalf("the sentence does not carry its code: %q", timeout.Error())
	}
	// The whole diagnostic is what the user sees, so the exit sentence must be
	// this sentence rather than a generic dial line.
	if dialSentence(name, err) != timeout.Error() {
		t.Fatalf("dialSentence rewrote the bounded dial's own sentence: %q",
			dialSentence(name, err))
	}
	// THE BOUND IS HONOURED IN BOTH DIRECTIONS. It waited (so it is a wait,
	// not a single failed attempt) and it stopped (so it is bounded). The
	// upper edge is generous because a scheduling hiccup is not the subject.
	if elapsed < budget/2 {
		t.Fatalf("the dial gave up after %s, well inside its %s budget", elapsed, budget)
	}
	if elapsed > 10*budget {
		t.Fatalf("the dial overran its %s budget by far, taking %s", budget, elapsed)
	}
}

// A pipe that is not there at all still fails IMMEDIATELY and keeps its errno,
// so `dialSentence` can still say "no Vex Studio host is listening". The busy
// loop must not swallow every open failure into its own sentence.
func TestDialPipeDoesNotWaitOutAnAbsentPipe(t *testing.T) {
	name := testPipeName(t)

	started := time.Now()
	conn, err := dialPipeWithin(name, WindowsDialTimeout, resolveServerUserSID, resolveCurrentUserSID)
	elapsed := time.Since(started)
	if conn != nil {
		_ = conn.Close()
		t.Fatal("a pipe that does not exist must not yield a connection")
	}
	if _, busy := asDialTimeout(err); busy {
		t.Fatalf("an absent pipe is not a busy one: %v", err)
	}
	if !errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		t.Fatalf("the operating system's errno must survive, got %v", err)
	}
	if elapsed > WindowsDialTimeout/2 {
		t.Fatalf("an absent pipe took %s; it must fail without waiting", elapsed)
	}
}
