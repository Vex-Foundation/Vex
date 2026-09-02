package control

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/front/credit"
	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
	"github.com/Vex-Foundation/vex/bridge/internal/front/listener"
	"github.com/Vex-Foundation/vex/bridge/internal/front/relay"
)

// THE SIX FROZEN NUMBERS ARE EQUALITY CHECKS, NOT NEGOTIATION. A front that
// quietly adapted would turn a packaging fault into a bounds mismatch
// discovered under load.
func TestHelloFrozenNumbersAreEqualityChecks(t *testing.T) {
	base := frames.Hello{
		ProtocolVersion:       frames.ProtocolVersion,
		SDDLKind:              frames.SDDLKind,
		MaxRaw:                uint16(listener.MaxRawHandles),
		CreditBytes:           expectedCreditBytes,
		ChunkBytes:            expectedChunkBytes,
		HandshakeDeadlineMs:   expectedHandshakeDeadlineMs,
		InitialAdmissionEpoch: 0,
		PipeName:              testPipeName,
		TimeoutRefusalBytes:   testRefusalLine,
	}
	if err := ValidateHello(base); err != nil {
		t.Fatalf("the frozen values must be accepted: %v", err)
	}
	tests := []struct {
		field  string
		mutate func(h *frames.Hello)
	}{
		{"protocolVersion", func(h *frames.Hello) { h.ProtocolVersion = 2 }},
		{"sddlKind", func(h *frames.Hello) { h.SDDLKind = 2 }},
		{"maxRaw", func(h *frames.Hello) { h.MaxRaw = 20 }},
		{"creditBytes", func(h *frames.Hello) { h.CreditBytes = 131072 }},
		{"chunkBytes", func(h *frames.Hello) { h.ChunkBytes = 65536 }},
		{"handshakeDeadlineMs", func(h *frames.Hello) { h.HandshakeDeadlineMs = 10000 }},
	}
	for _, tc := range tests {
		t.Run(tc.field, func(t *testing.T) {
			hello := base
			tc.mutate(&hello)
			err := ValidateHello(hello)
			var mismatch *HelloMismatch
			if !errors.As(err, &mismatch) {
				t.Fatalf("expected a HelloMismatch, got %v", err)
			}
			if mismatch.Field != tc.field {
				t.Fatalf("mismatch names %q, want %q", mismatch.Field, tc.field)
			}
		})
	}
	// initialAdmissionEpoch is the ONE number the front TAKES rather than
	// checks: it holds no compiled-in expectation to compare it against.
	dynamic := base
	dynamic.InitialAdmissionEpoch = 4242
	if err := ValidateHello(dynamic); err != nil {
		t.Fatalf("initialAdmissionEpoch is dynamic and must not be checked: %v", err)
	}
}

func TestHelloMismatchRefusesToServeAndBindsNothing(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.sendControl(0, frames.Hello{
		ProtocolVersion:     frames.ProtocolVersion,
		SDDLKind:            frames.SDDLKind,
		MaxRaw:              20, // the packaging fault
		CreditBytes:         expectedCreditBytes,
		ChunkBytes:          expectedChunkBytes,
		HandshakeDeadlineMs: expectedHandshakeDeadlineMs,
		PipeName:            testPipeName,
		TimeoutRefusalBytes: testRefusalLine,
	})
	h.expectExit(lifecycle.ExitHelloRejected)
	logs := h.logs.String()
	if !strings.Contains(logs, "hello_mismatch maxRaw=20 want=21") {
		t.Fatalf("the structural line must name the field, the value received and the value held:\n%s", logs)
	}
	select {
	case f := <-h.up:
		t.Fatalf("a refused HELLO must produce no frame at all, got %s", f.Type().Name())
	default:
	}
}

// BOUND IS EMITTED ONLY AFTER RUNTIME READBACK, and a readback mismatch is
// ERROR code 5 plus an exit.
func TestReadbackMismatchReportsSddlReadbackMismatchAndExits(t *testing.T) {
	h := newHarness(t)
	h.bindErr = &listener.ReadbackError{Reason: listener.ReasonDaclNotProtected, Got: 4, Want: 4096}
	h.start()
	h.sendControl(0, frames.Hello{
		ProtocolVersion:     frames.ProtocolVersion,
		SDDLKind:            frames.SDDLKind,
		MaxRaw:              uint16(listener.MaxRawHandles),
		CreditBytes:         expectedCreditBytes,
		ChunkBytes:          expectedChunkBytes,
		HandshakeDeadlineMs: expectedHandshakeDeadlineMs,
		PipeName:            testPipeName,
		TimeoutRefusalBytes: testRefusalLine,
	})
	_, _ = expectUpType[frames.HelloAck](h)
	_, report := expectUpType[frames.ErrorReport](h)
	if report.Code != frames.ErrorSDDLReadbackMismatch {
		t.Fatalf("ERROR code %d, want %d", report.Code, frames.ErrorSDDLReadbackMismatch)
	}
	h.expectExit(lifecycle.ExitListener)
	if !strings.Contains(h.logs.String(), "sddl_readback_mismatch:"+listener.ReasonDaclNotProtected) {
		t.Fatalf("the structural line must name the readback reason:\n%s", h.logs.String())
	}
}

func TestBoundEchoesThePipeNameAndTheVerifiedFlags(t *testing.T) {
	h := newHarness(t)
	// The front reports what it CONFIRMED. Here reject-remote came back
	// unconfirmed, and main is told 0 rather than the request.
	h.flags = frames.BoundFlagFirstInstance | frames.BoundFlagMessageMode
	h.start()
	h.sendControl(0, frames.Hello{
		ProtocolVersion:     frames.ProtocolVersion,
		SDDLKind:            frames.SDDLKind,
		MaxRaw:              uint16(listener.MaxRawHandles),
		CreditBytes:         expectedCreditBytes,
		ChunkBytes:          expectedChunkBytes,
		HandshakeDeadlineMs: expectedHandshakeDeadlineMs,
		PipeName:            testPipeName,
		TimeoutRefusalBytes: testRefusalLine,
	})
	_, _ = expectUpType[frames.HelloAck](h)
	_, bound := expectUpType[frames.Bound](h)
	if bound.PipeName != testPipeName {
		t.Fatalf("BOUND must echo the name HELLO carried, got %q", bound.PipeName)
	}
	if bound.FlagsApplied&frames.BoundFlagRejectRemote != 0 {
		t.Fatal("an unconfirmed flag must be reported 0, never echoed from the request")
	}
	if bound.FlagsApplied != frames.BoundFlagFirstInstance|frames.BoundFlagMessageMode {
		t.Fatalf("flagsApplied = %d", bound.FlagsApplied)
	}
}

// THE FIVE LOCKED NEGATIVES, over the real front.
//
// 1. ZERO READ BEFORE REFUSAL. 2. NO PROJECT ID IN THE REFUSAL. 3. NO
// RESERVATION. The peer writes a handshake line the moment it connects, and the
// front never reads one byte of it: nothing reaches plane 6, main's refusal
// bytes go out verbatim, and the connection is closed.
func TestRefusedConnectionIsNeverReadAndCarriesOnlyMainsBytes(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()

	projectLine := "{\"v\":1,\"projectId\":\"11111111-2222-3333-4444-555555555555\"}\n"
	if _, err := peer.Write([]byte(projectLine)); err != nil {
		t.Fatalf("the peer's handshake: %v", err)
	}

	refusal := "{\"ok\":false,\"code\":\"unknown_project\",\"message\":\"No such project.\"}\n"
	h.sendControl(id, frames.Refuse{Bytes: refusal})

	received := h.expectPeerClosed(peer)
	if string(received) != refusal {
		t.Fatalf("the peer must receive main's exact bytes and nothing else, got %q", received)
	}
	// NO PROJECT ID travels back: the front composed nothing, so nothing it
	// read could appear in what the peer got.
	if bytes.Contains(received, []byte("projectId")) {
		t.Fatal("the front must never echo a project id")
	}

	_, peerClosed := expectUpType[frames.PeerClosed](h)
	if peerClosed.Reason != frames.PeerClosedCommandedClose {
		t.Fatalf("PEER_CLOSED reason %d, want commanded_close", peerClosed.Reason)
	}
	// NO RESERVATION: the connection delivered nothing upward, so the sequence
	// it names is 0 and plane 6 has not moved at all.
	if peerClosed.ThroughDataSequence != 0 {
		t.Fatalf("a refused connection delivers nothing, got throughDataSequence %d", peerClosed.ThroughDataSequence)
	}
	select {
	case f := <-h.upData:
		t.Fatalf("a refused connection must put nothing on plane 6, got %s", f.Type().Name())
	case <-time.After(100 * time.Millisecond):
	}
	if strings.Contains(h.logs.String(), "projectId") {
		t.Fatal("the structural log must never carry peer content")
	}
}

// 4. A FLOOD WITHIN THE 21 BOUND, WITH THE 22ND CLOSED SILENTLY. Every one of
// the 21 gets an OPEN; the 22nd gets no OPEN, no read, no write and no byte.
func TestFloodFillsTheRawBoundAndTheTwentySecondIsClosedSilently(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()

	opened := map[uint32]bool{}
	for i := range listener.MaxRawHandles {
		h.dialPeer()
		frame, _ := expectUpType[frames.Open](h)
		if opened[frame.Connection] {
			t.Fatalf("connection id %d was reused; ids are NEVER reused within a generation", frame.Connection)
		}
		if frame.Connection == 0 {
			t.Fatalf("connection %d got id 0", i+1)
		}
		opened[frame.Connection] = true
	}

	overflow := h.dialPeer()
	received := h.expectPeerClosed(overflow)
	if len(received) != 0 {
		t.Fatalf("the 22nd must receive not one byte, got %q", received)
	}
	select {
	case f := <-h.up:
		t.Fatalf("the 22nd must never be announced to main, got %s for connection %d",
			f.Type().Name(), f.Connection)
	case <-time.After(100 * time.Millisecond):
	}
	if !strings.Contains(h.logs.String(), "raw_bound_refusal count=22") {
		t.Fatalf("the raw-bound refusal must be logged:\n%s", h.logs.String())
	}
}

// 5. CONTROL-CHANNEL LOSS DEFAULTS TO CLOSE. Plane 3 at EOF is terminal, and
// every live handle is closed rather than left serving a main that is gone.
func TestControlChannelLossClosesEveryHandle(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)

	if err := h.controlDown.Close(); err != nil {
		t.Fatalf("closing plane 3: %v", err)
	}
	if received := h.expectPeerClosed(peer); len(received) != 0 {
		t.Fatalf("a lost control channel writes nothing to the peer, got %q", received)
	}
	h.expectExit(lifecycle.ExitClean)
	if !strings.Contains(h.logs.String(), "plane_eof plane=3") {
		t.Fatalf("plane 3 EOF must be logged as terminal:\n%s", h.logs.String())
	}
}

// THE HANDSHAKE DEADLINE IS MEASURED FROM ACCEPT and writes HELLO's
// timeoutRefusalBytes VERBATIM. The front interprets nothing.
func TestHandshakeDeadlineWritesMainsTimeoutBytesVerbatim(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, _ := h.openConnection()

	deadline := time.Duration(expectedHandshakeDeadlineMs) * time.Millisecond
	if h.clock.live(deadline) != 1 {
		t.Fatal("the deadline is armed at ACCEPT, before main has been told anything")
	}
	if fired := h.clock.fireAll(deadline); fired != 1 {
		t.Fatalf("expected one deadline to fire, got %d", fired)
	}

	received := h.expectPeerClosed(peer)
	if string(received) != testRefusalLine {
		t.Fatalf("the peer must receive HELLO's timeoutRefusalBytes verbatim, got %q", received)
	}
	_, peerClosed := expectUpType[frames.PeerClosed](h)
	if peerClosed.Reason != frames.PeerClosedCommandedClose {
		t.Fatalf("PEER_CLOSED reason %d, want commanded_close", peerClosed.Reason)
	}
}

// A FIRST LINE THAT ARRIVES IN TIME DISARMS THE DEADLINE. The front finds a
// newline byte and interprets nothing about what precedes it.
func TestFirstNewlineDisarmsTheHandshakeDeadline(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)

	if _, err := peer.Write([]byte("{\"v\":1,\"projectId\":\"not-parsed-by-the-front\"}\n")); err != nil {
		t.Fatalf("the peer's handshake: %v", err)
	}
	data := h.expectUpData()
	if _, ok := data.Payload.(frames.Data); !ok {
		t.Fatalf("expected DATA on plane 6, got %s", data.Type().Name())
	}

	deadline := time.Duration(expectedHandshakeDeadlineMs) * time.Millisecond
	waitFor(t, func() bool { return h.clock.live(deadline) == 0 })
	if fired := h.clock.fireAll(deadline); fired != 0 {
		t.Fatalf("a completed first line must disarm the deadline, %d timers still live", fired)
	}
}

// THE ADMISSION FENCE. LOCK is processed AHEAD OF QUEUED TRAFFIC, closes every
// handle, answers LOCK_ACK with the count it actually closed, and every ADMIT
// still naming the old epoch is PURGED - which is NOT fatal.
func TestLockClosesEveryHandleAndPurgesStaleAdmits(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peerA, idA := h.openConnection()
	peerB, idB := h.openConnection()
	h.admit(idA, 7)

	// An ADMIT main sent a microsecond before deciding to lock, followed by the
	// LOCK. The LOCK jumps it, and the ADMIT then names a spent epoch.
	h.sendControl(idB, frames.Admit{AdmissionEpoch: 7})
	h.sendControl(0, frames.Lock{AdmissionEpoch: 8})

	closed := map[uint32]bool{}
	var lockAck frames.LockAck
	for range 3 {
		frame := h.expectUp()
		switch payload := frame.Payload.(type) {
		case frames.PeerClosed:
			closed[frame.Connection] = true
			if payload.Reason != frames.PeerClosedCommandedClose {
				t.Fatalf("a locked connection ends with commanded_close, got %d", payload.Reason)
			}
		case frames.LockAck:
			lockAck = payload
		default:
			t.Fatalf("unexpected %s after LOCK", frame.Type().Name())
		}
	}
	if !closed[idA] || !closed[idB] {
		t.Fatalf("LOCK must close EVERY handle, closed=%v", closed)
	}
	if lockAck.AdmissionEpoch != 8 || lockAck.ClosedCount != 2 {
		t.Fatalf("LOCK_ACK epoch=%d closed=%d, want 8 and 2", lockAck.AdmissionEpoch, lockAck.ClosedCount)
	}
	if received := h.expectPeerClosed(peerA); len(received) != 0 {
		t.Fatalf("a locked connection is closed, not written to, got %q", received)
	}
	if received := h.expectPeerClosed(peerB); len(received) != 0 {
		t.Fatalf("a locked connection is closed, not written to, got %q", received)
	}

	// A stale ADMIT moves NOTHING and is not fatal: it is the fence working, and
	// a front that killed itself here would die every time a lock raced an
	// admit. The connection is a LIVE one accepted after the lock, so the purge
	// is proven on a door the stale order could otherwise have opened.
	peerC, idC := h.openConnection()
	h.sendControl(idC, frames.Admit{AdmissionEpoch: 7})
	h.sendControl(idC, frames.Credit{Bytes: expectedCreditBytes})
	waitFor(t, func() bool { return strings.Contains(h.logs.String(), "stale_admit_purged") })
	if _, err := peerC.Write([]byte("this must never be read\n")); err != nil {
		t.Fatalf("the peer's write: %v", err)
	}
	select {
	case f := <-h.upData:
		t.Fatalf("a purged ADMIT must never start a read, got %s", f.Type().Name())
	case <-time.After(200 * time.Millisecond):
	}
	select {
	case got := <-h.exit:
		t.Fatalf("stale_admit_purged must NOT be fatal; the front exited %d", got)
	case <-time.After(100 * time.Millisecond):
	}

	// The front is still commandable, which is what "not fatal" has to mean.
	h.sendControl(0, frames.Ping{Nonce: 99})
	_, pong := expectUpType[frames.Pong](h)
	if pong.Nonce != 99 {
		t.Fatalf("PONG nonce %d, want 99", pong.Nonce)
	}
}

// LOCK DURING A PAUSED READ AND A BLOCKED WRITE still closes everything. The
// handles are closed by the supervisor itself, so no queued work can delay it.
func TestLockDuringPausedReadAndPendingWrite(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)
	h.sendControl(id, frames.Pause{})
	waitFor(t, func() bool { return strings.Contains(h.logs.String(), "paused") })

	// Queue a chunk for a peer that is not reading, then lock.
	h.sendData(id, frames.Data{Payload: bytes.Repeat([]byte("x"), 4096)})
	h.sendControl(0, frames.Lock{AdmissionEpoch: 9})

	var sawLockAck, sawPeerClosed bool
	for !sawLockAck || !sawPeerClosed {
		frame := h.expectUp()
		switch payload := frame.Payload.(type) {
		case frames.LockAck:
			if payload.AdmissionEpoch != 9 {
				t.Fatalf("LOCK_ACK epoch %d, want 9", payload.AdmissionEpoch)
			}
			sawLockAck = true
		case frames.PeerClosed:
			sawPeerClosed = true
		case frames.WriteDone:
			// A chunk that completed before the lock is legal here.
		default:
			t.Fatalf("unexpected %s during a lock", frame.Type().Name())
		}
	}
	_ = h.expectPeerClosed(peer)
}

// A CREDIT past the 64 KiB window is duplicate_credit: a FATAL structural
// failure reported as ERROR code 6.
func TestDuplicateCreditIsFatal(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	_, id := h.openConnection()
	h.sendControl(id, frames.Admit{AdmissionEpoch: 7})
	h.sendControl(id, frames.Credit{Bytes: credit.WindowBytes})
	h.sendControl(id, frames.Credit{Bytes: 1})

	assertFatalCreditViolation(t, h, credit.NameDuplicateCredit)
}

// A plane 5 chunk that takes a connection past 65536 unacknowledged bytes is
// write_window_exceeded, and it is fatal in the same class.
func TestWriteWindowExceededIsFatal(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)
	// The peer NEVER READS. Its socket buffer fills, the front's writes stop
	// returning, no acknowledgement can be produced, and main's unacknowledged
	// bytes cross the window. The burst is written on its own goroutine because
	// a front that has gone terminal stops draining plane 5, and main's write
	// would otherwise block against a reader that is gone.
	_ = peer
	chunk := bytes.Repeat([]byte("y"), int(credit.ChunkBytes))
	go func() {
		for range 64 {
			if err := h.trySendData(id, frames.Data{Payload: chunk}); err != nil {
				// The front has gone terminal and stopped draining plane 5,
				// which is the outcome under test.
				return
			}
		}
	}()
	assertFatalCreditViolation(t, h, credit.NameWriteWindowExceeded)
}

// A DATA or END for a connection already ended in that direction is
// data_after_end, and it is fatal.
func TestDataAfterEndOnPlaneFiveIsFatal(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	_, id := h.openConnection()
	h.admit(id, 7)
	h.sendData(id, frames.End{})
	h.sendData(id, frames.Data{Payload: []byte("after the end")})
	assertFatalCreditViolation(t, h, relay.NameDataAfterEnd)
}

func assertFatalCreditViolation(t *testing.T, h *harness, name string) {
	t.Helper()
	for {
		frame := h.expectUp()
		if report, ok := frame.Payload.(frames.ErrorReport); ok {
			if report.Code != frames.ErrorCreditViolation {
				t.Fatalf("ERROR code %d, want credit_violation", report.Code)
			}
			break
		}
	}
	h.expectExit(lifecycle.ExitCreditViolation)
	if !strings.Contains(h.logs.String(), name) {
		t.Fatalf("the structural log must name %s:\n%s", name, h.logs.String())
	}
}

// THE CUMULATIVE ACKNOWLEDGEMENT COVERS A MULTI-CHUNK LOGICAL WRITE, and it is
// emitted only after the pipe write RETURNED. The peer here reads everything,
// so every chunk completes and the final acknowledgement names the write's last
// sequence.
func TestCumulativeWriteDoneCoversAMultiChunkWrite(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)

	// A LOGICAL WRITE LARGER THAN THE WINDOW IS SENT IN PIECES, paced by the
	// front's cumulative acknowledgements. Main never has more than 65536
	// unacknowledged bytes outstanding for one connection, INCLUDING INSIDE ONE
	// LOGICAL WRITE, so this 128 KiB write goes out two chunks at a time and
	// completes on the acknowledgement covering its FINAL sequence.
	const chunks = 4
	chunk := bytes.Repeat([]byte("z"), int(credit.ChunkBytes))
	drained := make(chan int, 1)
	go func() {
		total := 0
		buf := make([]byte, 8192)
		for total < chunks*int(credit.ChunkBytes) {
			n, err := peer.Read(buf)
			total += n
			if err != nil {
				break
			}
		}
		drained <- total
	}()

	var lastSequence uint64
	for range chunks / 2 {
		h.sendData(id, frames.Data{Payload: chunk})
		lastSequence = h.sendData(id, frames.Data{Payload: chunk})
		// The window is full at two chunks; main waits rather than writing on.
		waitForAckThrough(t, h, id, lastSequence)
	}

	select {
	case total := <-drained:
		if total != chunks*int(credit.ChunkBytes) {
			t.Fatalf("the peer received %d bytes of %d", total, chunks*int(credit.ChunkBytes))
		}
	case <-time.After(waitBudget):
		t.Fatal("the peer never received the whole write")
	}
}

// waitForAckThrough consumes acknowledgements until one covers `want`, proving
// on the way that none of them regresses. The front MAY coalesce, so the test
// asserts the cumulative property rather than a frame count.
func waitForAckThrough(t *testing.T, h *harness, id uint32, want uint64) {
	t.Helper()
	var highest uint64
	for highest < want {
		frame := h.expectUp()
		ack, ok := frame.Payload.(frames.WriteDone)
		if !ok {
			t.Fatalf("expected WRITE_DONE, got %s", frame.Type().Name())
		}
		if frame.Connection != id {
			t.Fatalf("WRITE_DONE for connection %d, want %d", frame.Connection, id)
		}
		if ack.AckThroughSequence < highest {
			t.Fatalf("an acknowledgement regressed: %d after %d", ack.AckThroughSequence, highest)
		}
		highest = ack.AckThroughSequence
	}
	if highest != want {
		t.Fatalf("the acknowledgement names %d, want the write's last sequence %d", highest, want)
	}
}

// PEER BYTES FLOW UP UNDER CREDIT, and END on plane 6 is the peer's FIN with
// the writable side PRESERVED: the last answer of a one-shot session still goes
// out after the peer has half-closed.
func TestPeerHalfCloseRaisesEndAndTheWritableSideSurvives(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)

	if _, err := peer.Write([]byte("request\n")); err != nil {
		t.Fatalf("the peer's request: %v", err)
	}
	data := h.expectUpData()
	payload, ok := data.Payload.(frames.Data)
	if !ok {
		t.Fatalf("expected DATA, got %s", data.Type().Name())
	}
	if string(payload.Payload) != "request\n" {
		t.Fatalf("the front must relay the peer's bytes unchanged, got %q", payload.Payload)
	}

	if err := peer.CloseWrite(); err != nil {
		t.Fatalf("the peer's half-close: %v", err)
	}
	end := h.expectUpData()
	if _, ok := end.Payload.(frames.End); !ok {
		t.Fatalf("a peer FIN must raise END on plane 6, got %s", end.Type().Name())
	}

	// The writable side is still there.
	answer := "the last response\n"
	h.sendData(id, frames.Data{Payload: []byte(answer)})
	_ = peer.SetReadDeadline(time.Now().Add(waitBudget))
	buf := make([]byte, len(answer))
	if _, err := peer.Read(buf); err != nil {
		t.Fatalf("the writable side must survive the peer's FIN: %v", err)
	}
	if string(buf) != answer {
		t.Fatalf("got %q, want %q", buf, answer)
	}
}

// A MALFORMED FRAME FROM MAIN IS FATAL, and both sides report the PLANE, the
// TYPE, the LENGTH and the SEQUENCE - never the payload, which is peer content.
func TestMalformedMainFrameIsFatalAndReportsPlaneTypeLength(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()

	// A plane 5 header whose declared length is past the plane's 32768 bound.
	// It is detected AT HEADER PARSE, before one payload byte is retained.
	header := make([]byte, frames.HeaderBytes)
	binary.LittleEndian.PutUint32(header[0:], frames.Magic)
	binary.LittleEndian.PutUint32(header[4:], h.generation)
	binary.LittleEndian.PutUint32(header[8:], 1)
	binary.LittleEndian.PutUint64(header[12:], 1)
	header[20] = byte(frames.TypeData)
	binary.LittleEndian.PutUint32(header[24:], 40000)
	h.sendRaw(frames.PlaneDataDown, header)

	for {
		frame := h.expectUp()
		if report, ok := frame.Payload.(frames.ErrorReport); ok {
			if report.Code != frames.ErrorMalformedMainFrame {
				t.Fatalf("ERROR code %d, want malformed_main_frame", report.Code)
			}
			break
		}
	}
	h.expectExit(lifecycle.ExitMalformedFrame)
	logs := h.logs.String()
	if !strings.Contains(logs, "malformed_main_frame:length_over_bound") {
		t.Fatalf("the reason must be named:\n%s", logs)
	}
	for _, want := range []string{"plane=5", "type=129", "sequence=1", "length=40000"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("the structural line must carry %s:\n%s", want, logs)
		}
	}
}

// THE PARENT'S DEATH ENDS THE FRONT, with every handle closed.
func TestParentDeathClosesEverythingAndExits(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)

	h.parent <- lifecycle.ParentEOF
	if received := h.expectPeerClosed(peer); len(received) != 0 {
		t.Fatalf("the parent's death writes nothing to the peer, got %q", received)
	}
	h.expectExit(lifecycle.ExitParentGone)
	if !strings.Contains(h.logs.String(), "parent_gone") {
		t.Fatalf("the parent's death must be logged:\n%s", h.logs.String())
	}
}

// QUIT RUNS UNDER MAIN'S ONE ABSOLUTE BUDGET, drains, and answers QUIT_ACK.
func TestQuitDrainsAndAcknowledges(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()
	peer, id := h.openConnection()
	h.admit(id, 7)

	answer := "the last answer\n"
	h.sendData(id, frames.Data{Payload: []byte(answer)})
	buf := make([]byte, len(answer))
	_ = peer.SetReadDeadline(time.Now().Add(waitBudget))
	if _, err := peer.Read(buf); err != nil {
		t.Fatalf("reading the queued answer: %v", err)
	}

	h.sendControl(0, frames.Quit{DeadlineMs: 1500})
	var sawQuitAck bool
	for !sawQuitAck {
		frame := h.expectUp()
		switch frame.Payload.(type) {
		case frames.QuitAck:
			sawQuitAck = true
		case frames.WriteDone, frames.PeerClosed:
		default:
			t.Fatalf("unexpected %s during a quit", frame.Type().Name())
		}
	}
	h.expectExit(lifecycle.ExitClean)
}

// THE CONNECTION TABLE IS BOUNDED. Connection ids are NEVER REUSED within a
// generation, so a front that remembered every connection it ever served would
// grow its table and its plane 6 rotation for the life of the process, and walk
// both on every pump. A closed handle is forgotten once PEER_CLOSED is queued.
func TestClosedConnectionsAreForgottenSoTheTableStaysBounded(t *testing.T) {
	h := newHarness(t)
	h.bootstrap()

	var lastID uint32
	for range 30 {
		peer, id := h.openConnection()
		if id <= lastID {
			t.Fatalf("connection ids must never be reused, got %d after %d", id, lastID)
		}
		lastID = id
		h.sendControl(id, frames.Close{})
		_, closed := expectUpType[frames.PeerClosed](h)
		if closed.Reason != frames.PeerClosedCommandedClose {
			t.Fatalf("PEER_CLOSED reason %d, want commanded_close", closed.Reason)
		}
		_ = h.expectPeerClosed(peer)
	}
	if lastID != 30 {
		t.Fatalf("30 connections must produce ids 1..30, the last is %d", lastID)
	}
	// `tracked` is the front's own view of its table, reported on the structural
	// log by the goroutine that owns it - which is how this is asserted without
	// a second reader racing the supervisor for the map. `live` is the raw
	// handle count, released only after the PHYSICAL close.
	waitFor(t, func() bool {
		return strings.Contains(h.logs.String(), "connection=30 reason=3 live=0 tracked=0")
	})
}

// waitFor polls a condition under a bounded deadline. It is not proof of
// timing; it is how a test observes a state the supervisor reaches on its own
// goroutine without a sleep standing in for the event.
func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitBudget)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for the front to reach the expected state")
}
