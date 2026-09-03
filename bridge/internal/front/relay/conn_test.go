package relay

import (
	"bytes"
	"errors"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/front/credit"
	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
)

// nullWire is a handle the state machine never touches: this package issues no
// I/O, which is the property the type exists to keep.
type nullWire struct{}

func (nullWire) Read([]byte) (int, error)    { return 0, nil }
func (nullWire) Write(p []byte) (int, error) { return len(p), nil }
func (nullWire) CloseWrite() error           { return nil }
func (nullWire) Close() error                { return nil }

func newConn(t *testing.T) *Conn {
	t.Helper()
	return New(7, nullWire{})
}

func faultName(t *testing.T, err error) string {
	t.Helper()
	var fault *Fault
	if errors.As(err, &fault) {
		return fault.Name
	}
	var violation *credit.Violation
	if errors.As(err, &violation) {
		return violation.Name
	}
	t.Fatalf("expected a named structural failure, got %v", err)
	return ""
}

// A CONNECTION STARTS LOCKED. It gets an OPEN and reads nothing until main
// admits it, and admission alone is not enough: without credit the read gate
// stays shut.
func TestConnectionReadsNothingUntilAdmittedAndFunded(t *testing.T) {
	c := newConn(t)
	if c.State() != StateAccepted || c.ReadBudget() != 0 {
		t.Fatalf("a freshly accepted handle must read nothing, state=%s budget=%d", c.LogName(), c.ReadBudget())
	}
	c.OpenSent()
	if c.LogName() != "open-sent" || c.ReadBudget() != 0 {
		t.Fatalf("open-sent reads nothing, state=%s budget=%d", c.LogName(), c.ReadBudget())
	}
	c.Admit()
	if c.ReadBudget() != 0 {
		t.Fatal("an admitted connection with no credit still reads nothing")
	}
	if err := c.GrantCredit(1024); err != nil {
		t.Fatalf("granting credit: %v", err)
	}
	if got := c.ReadBudget(); got != 1024 {
		t.Fatalf("the read budget is the outstanding credit, got %d", got)
	}
}

// A REFUSED CONNECTION NEVER READS, and that is the locked negative the whole
// refusal path exists for: main's bytes go out, nothing comes in.
func TestRefusedConnectionNeverReads(t *testing.T) {
	c := newConn(t)
	c.OpenSent()
	c.Admit()
	if err := c.GrantCredit(4096); err != nil {
		t.Fatalf("granting credit: %v", err)
	}
	c.Refuse()
	if c.ReadBudget() != 0 {
		t.Fatal("a refused connection must never read, even with credit outstanding")
	}
	if c.LogName() != "refused" {
		t.Fatalf("state is %s", c.LogName())
	}
}

// PAUSE STOPS READING IMMEDIATELY. RESUME restores it.
func TestPauseClosesTheReadGateAndResumeOpensIt(t *testing.T) {
	c := admittedConn(t, 4096)
	if c.ReadBudget() == 0 {
		t.Fatal("an admitted, funded connection reads")
	}
	c.Pause()
	if c.ReadBudget() != 0 {
		t.Fatal("PAUSE must close the read gate at once")
	}
	c.Resume()
	if c.ReadBudget() == 0 {
		t.Fatal("RESUME must reopen the read gate")
	}
}

func admittedConn(t *testing.T, creditBytes uint32) *Conn {
	t.Helper()
	c := newConn(t)
	c.OpenSent()
	c.Admit()
	if err := c.GrantCredit(creditBytes); err != nil {
		t.Fatalf("granting credit: %v", err)
	}
	return c
}

// ONE OUTSTANDING READ PER CONNECTION is what keeps the front's own buffering
// inside the credit bound.
func TestOnlyOneReadIsOutstandingAtATime(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)
	c.ReadIssued()
	if c.ReadBudget() != 0 {
		t.Fatal("a second read must not be issued while one is outstanding")
	}
	if _, err := c.AcceptRead([]byte("payload")); err != nil {
		t.Fatalf("accepting a read: %v", err)
	}
	if c.ReadBudget() == 0 {
		t.Fatal("the gate reopens once the read has returned, against what credit is left")
	}
	if want := credit.WindowBytes - uint32(len("payload")); c.OutstandingCredit() != want {
		t.Fatalf("the accepted bytes are already charged, outstanding=%d want=%d",
			c.OutstandingCredit(), want)
	}
}

// THE FRONT DETECTS THE FIRST NEWLINE AND NOTHING ELSE.
func TestHandshakeDetectionIsANewlineScanAndNothingElse(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)
	c.ReadIssued()
	// A partial line, and a project id the front must never look at.
	completed, err := c.AcceptRead([]byte(`{"v":1,"projectId":"11111111-2222-3333-4444-5555`))
	if err != nil {
		t.Fatalf("accepting a partial line: %v", err)
	}
	if completed || c.HandshakeSeen() {
		t.Fatal("a line without a newline has not completed")
	}
	c.ReadIssued()
	completed, err = c.AcceptRead([]byte("55555555\"}\n"))
	if err != nil {
		t.Fatalf("accepting the rest: %v", err)
	}
	if !completed || !c.HandshakeSeen() {
		t.Fatal("the first newline completes the peer's first line")
	}
	// Drain the two queued chunks the way the supervisor's round-robin does,
	// so the next read has a turn to take.
	for sequence := uint64(1); sequence <= 2; sequence++ {
		if _, _, err := c.TakeUpward(sequence); err != nil {
			t.Fatalf("taking chunk %d: %v", sequence, err)
		}
	}
	// A LATER newline changes nothing: the latch is one-shot.
	c.ReadIssued()
	completed, err = c.AcceptRead([]byte("second line\n"))
	if err != nil {
		t.Fatalf("accepting a later line: %v", err)
	}
	if completed {
		t.Fatal("only the FIRST newline completes the handshake")
	}
}

// THE TWO HALF-CLOSE LATCHES ARE INDEPENDENT. A peer FIN preserves the writable
// side, and main's END preserves the readable side.
func TestHalfCloseLatchesAreIndependent(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)
	c.ReadIssued()
	if err := c.PeerEnded(); err != nil {
		t.Fatalf("peer FIN: %v", err)
	}
	if !c.ReadEnded() || c.WriteEnded() {
		t.Fatalf("peer FIN ends only the readable side: read=%v write=%v", c.ReadEnded(), c.WriteEnded())
	}
	if c.LogName() != "ended" {
		t.Fatalf("the log name for a half-closed connection is `ended`, got %s", c.LogName())
	}
	if c.ReadBudget() != 0 {
		t.Fatal("a peer that has sent FIN is not read again")
	}
	// The writable side still accepts main's answers, which is the whole point
	// of half-open: the last response of a one-shot session must still go out.
	if err := c.QueueDown(1, []byte("the answer")); err != nil {
		t.Fatalf("writing after peer FIN must still be possible: %v", err)
	}
	if err := c.QueueDownEnd(2); err != nil {
		t.Fatalf("main's END: %v", err)
	}
	if !c.WriteEnded() {
		t.Fatal("main's END latches the writable side")
	}
}

func TestDataAfterEndIsNamedAndFatalInEitherDirection(t *testing.T) {
	t.Run("plane 5 DATA after main's END", func(t *testing.T) {
		c := admittedConn(t, credit.WindowBytes)
		if err := c.QueueDownEnd(1); err != nil {
			t.Fatalf("END: %v", err)
		}
		err := c.QueueDown(2, []byte("late"))
		if got := faultName(t, err); got != NameDataAfterEnd {
			t.Fatalf("got %s, want %s", got, NameDataAfterEnd)
		}
	})
	t.Run("a second END on plane 5", func(t *testing.T) {
		c := admittedConn(t, credit.WindowBytes)
		if err := c.QueueDownEnd(1); err != nil {
			t.Fatalf("END: %v", err)
		}
		err := c.QueueDownEnd(2)
		if got := faultName(t, err); got != NameDataAfterEnd {
			t.Fatalf("got %s, want %s", got, NameDataAfterEnd)
		}
	})
	t.Run("bytes read after the peer's FIN", func(t *testing.T) {
		c := admittedConn(t, credit.WindowBytes)
		c.ReadIssued()
		if err := c.PeerEnded(); err != nil {
			t.Fatalf("peer FIN: %v", err)
		}
		err := c.PeerEnded()
		if got := faultName(t, err); got != NameDataAfterEnd {
			t.Fatalf("got %s, want %s", got, NameDataAfterEnd)
		}
	})
}

// END COSTS NO CREDIT. A half-close that could be blocked by an exhausted
// window would deadlock: main only grants credit after it sees the EOF.
func TestEndCostsNoCredit(t *testing.T) {
	c := admittedConn(t, 4)
	c.ReadIssued()
	if _, err := c.AcceptRead([]byte("abcd")); err != nil {
		t.Fatalf("accepting a read: %v", err)
	}
	if c.OutstandingCredit() != 0 {
		t.Fatalf("the credit is spent at ACCEPT, got %d", c.OutstandingCredit())
	}
	if _, _, err := c.TakeUpward(1); err != nil {
		t.Fatalf("taking the chunk: %v", err)
	}
	if err := c.PeerEnded(); err != nil {
		t.Fatalf("peer FIN with no credit left: %v", err)
	}
	payload, end, err := c.TakeUpward(2)
	if err != nil {
		t.Fatalf("END must be sendable with no credit: %v", err)
	}
	if !end || payload != nil {
		t.Fatalf("expected an END frame, got end=%v payload=%d bytes", end, len(payload))
	}
}

// ACCEPTREAD SPENDS credit at the moment the bytes leave the operating system,
// which is what makes section 11.1's "never buffers more than the outstanding
// credit" a property of the front rather than of plane 6's drain rate.
func TestUpwardSpendingIsRefusedPastTheCreditBound(t *testing.T) {
	c := admittedConn(t, 4)
	c.ReadIssued()
	// A read larger than the budget cannot happen through ReadBudget, so this
	// is the defence against the front itself getting the arithmetic wrong.
	_, err := c.AcceptRead([]byte("too many bytes"))
	if got := faultName(t, err); got != credit.NameCreditOverrun {
		t.Fatalf("got %s, want %s", got, credit.NameCreditOverrun)
	}
}

// THE CUMULATIVE ACKNOWLEDGEMENT COVERS A MULTI-CHUNK LOGICAL WRITE, and it is
// emitted only after the pipe write RETURNED.
func TestWriteDoneIsCumulativeAcrossAMultiChunkWrite(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)
	chunk := make([]byte, 16384)
	for sequence := uint64(1); sequence <= 4; sequence++ {
		if err := c.QueueDown(sequence, chunk); err != nil {
			t.Fatalf("queueing chunk %d: %v", sequence, err)
		}
	}
	if c.UnacknowledgedBytes() != credit.WindowBytes {
		t.Fatalf("four 16 KiB chunks fill the window, got %d", c.UnacknowledgedBytes())
	}
	if c.AckThrough() != 0 {
		t.Fatal("nothing is acknowledged before a write returns")
	}
	var acks []uint64
	for range 4 {
		sequence, _, end, ok := c.NextDown()
		if !ok || end {
			t.Fatalf("expected a chunk, got ok=%v end=%v", ok, end)
		}
		ack, err := c.WriteCompleted(sequence)
		if err != nil {
			t.Fatalf("completing %d: %v", sequence, err)
		}
		acks = append(acks, ack)
	}
	// The final acknowledgement names the write's LAST sequence, which is the
	// one main settles the write callback on.
	if acks[len(acks)-1] != 4 {
		t.Fatalf("the last acknowledgement must cover sequence 4, got %v", acks)
	}
	if c.UnacknowledgedBytes() != 0 {
		t.Fatalf("the window is released, got %d", c.UnacknowledgedBytes())
	}
}

func TestPeerClosedCarriesTheLastDeliveredSequenceAndNoDomainCause(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)
	if got := c.PeerClosedFrame(frames.PeerClosedCommandedClose).ThroughDataSequence; got != 0 {
		t.Fatalf("a connection that delivered nothing reports 0, got %d", got)
	}
	c.ReadIssued()
	if _, err := c.AcceptRead([]byte("bytes")); err != nil {
		t.Fatalf("accepting a read: %v", err)
	}
	if _, _, err := c.TakeUpward(9); err != nil {
		t.Fatalf("taking the chunk: %v", err)
	}
	frame := c.PeerClosedFrame(frames.PeerClosedPeerEOF)
	if frame.ThroughDataSequence != 9 {
		t.Fatalf("PEER_CLOSED must name the last delivered plane 6 sequence, got %d", frame.ThroughDataSequence)
	}
	// The reason vocabulary is CLOSED and structural. There is no room in it
	// for `lock`, and the front does not know the word.
	if frame.Reason < frames.PeerClosedPeerEOF || frame.Reason > frames.PeerClosedCommandedClose {
		t.Fatalf("reason %d is outside the structural set", frame.Reason)
	}
}

func TestMarkClosedDropsEveryQueueAndStopsAllIO(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)
	if err := c.QueueDown(1, []byte("pending")); err != nil {
		t.Fatalf("queueing: %v", err)
	}
	c.ReadIssued()
	if _, err := c.AcceptRead([]byte("upward")); err != nil {
		t.Fatalf("accepting a read: %v", err)
	}
	c.MarkClosed()
	if c.State() != StateClosed || c.LogName() != "closed" {
		t.Fatalf("state is %s", c.LogName())
	}
	if c.PendingDown() != 0 || c.PendingUp() != 0 || c.ReadBudget() != 0 {
		t.Fatal("a closed connection holds nothing and does nothing")
	}
	if _, _, _, ok := c.NextDown(); ok {
		t.Fatal("a closed connection has nothing to write")
	}
}

// THE 512 KiB MESSAGE, WITH PLANE 6 HELD BUSY - the Windows lane's failure,
// reproduced on a platform with no named pipes.
//
// The peer writes one 512 KiB message. A message-mode pipe does not hand it
// over in 32 KiB pieces because the front asked for 32 KiB: it hands over
// whatever the kernel buffer holds, which the CI machine measured at 4096
// bytes, so the front sees a hundred and twenty-eight SHORT reads inside one
// 64 KiB window. Plane 6's write goroutine is slower than those reads on
// Windows, so a chunk stays in the queue while the next read is already coming
// back.
//
// Before AcceptRead charged the grant, that shape broke the front against
// ITSELF: the read gate saw a full window of unspent credit, issued read after
// read, and the fifth one hit `internal_invariant` on a plane 6 queue of two.
// The front then exited, main saw plane_io_error, and the bridge - whose 512
// KiB tools/call was half delivered - saw the host close the connection and
// exited 0 with nothing on stderr.
//
// Reverting either half of the fix (the Spend in AcceptRead, or maxPendingUp)
// turns this red.
func TestALargeMessageArrivesWholeThroughShortReadsWithPlaneSixHeldBusy(t *testing.T) {
	const total = 512 * 1024
	const kernelBuffer = 4096

	message := make([]byte, total)
	for i := range message {
		message[i] = byte('a' + i%26)
	}
	// The peer's first line has to complete for the handshake latch, and the
	// front interprets nothing else, so a newline in the first read is enough.
	message[0] = '\n'

	c := admittedConn(t, credit.WindowBytes)

	// MAIN, as front-relay-transport.ts behaves: it decodes a DATA frame, hands
	// the payload to the consumer and replenishes exactly what it consumed, up
	// to the 64 KiB window.
	replenish := func(consumed uint32) {
		room := credit.WindowBytes - c.OutstandingCredit()
		if consumed > room {
			consumed = room
		}
		if consumed == 0 {
			return
		}
		if err := c.GrantCredit(consumed); err != nil {
			t.Fatalf("main's replenishment: %v", err)
		}
	}

	var (
		delivered []byte
		offset    int
		sequence  uint64
		// planeBusy is the plane 6 write the supervisor has handed to its
		// writer goroutine and that has not returned yet. While it is set, no
		// turn is taken, which is exactly pumpDataUp's `if s.dataUp.busy`.
		planeBusy []byte
		// planeLag is how many more loop turns that write takes to return. TWO
		// is the Windows shape and the reason the defect only appeared there: a
		// plane 6 write to an overlapped stdio handle is slower than the next
		// short read off a pipe whose buffer is already full, so reads overtake
		// the drain. On Linux the same write returns before the next read and
		// the queue never holds two, which is why every local run was green.
		planeLag int
	)
	const planeWriteLagTurns = 2

	// The supervisor's own loop: pumpConnIO issues a read BEFORE pumpDataUp
	// takes a turn, which is the ordering that makes the read gate the only
	// thing standing between a fast peer and an unbounded queue.
	for offset < total || len(delivered) < total {
		progressed := false

		if budget := c.ReadBudget(); budget > 0 && offset < total {
			if budget > kernelBuffer {
				budget = kernelBuffer
			}
			if offset+budget > total {
				budget = total - offset
			}
			c.ReadIssued()
			chunk := append([]byte(nil), message[offset:offset+budget]...)
			offset += budget
			if _, err := c.AcceptRead(chunk); err != nil {
				t.Fatalf("accepting a read at offset %d: %v", offset, err)
			}
			progressed = true
		}

		// The write in flight returns, several reads behind, and main consumes
		// it and replenishes exactly what it consumed.
		if planeBusy != nil {
			planeLag--
			if planeLag <= 0 {
				delivered = append(delivered, planeBusy...)
				replenish(uint32(len(planeBusy)))
				planeBusy = nil
			}
			progressed = true
		}

		if planeBusy == nil && c.HasUpward() {
			sequence++
			payload, end, err := c.TakeUpward(sequence)
			if err != nil {
				t.Fatalf("taking a plane 6 turn at sequence %d: %v", sequence, err)
			}
			if end {
				t.Fatal("the peer never half-closed in this test")
			}
			if uint32(len(payload)) > credit.ChunkBytes {
				t.Fatalf("a DATA frame of %d bytes is past the %d-byte chunk bound",
					len(payload), credit.ChunkBytes)
			}
			planeBusy = payload
			planeLag = planeWriteLagTurns
			progressed = true
		}

		if !progressed {
			t.Fatalf("the relay stalled: read %d of %d bytes, delivered %d, queue %d, credit %d",
				offset, total, len(delivered), c.PendingUp(), c.OutstandingCredit())
		}
	}

	if len(delivered) != total {
		t.Fatalf("delivered %d bytes, want %d", len(delivered), total)
	}
	if !bytes.Equal(delivered, message) {
		t.Fatal("the bytes that reached plane 6 are not the bytes the peer wrote, in order")
	}
}

// THE READ GATE IS THE BUFFER BOUND. The front never holds more unsent peer
// bytes than the credit main granted, whatever plane 6 is doing - which is the
// sentence protocol section 11.1 already contained and the implementation did
// not keep.
func TestTheFrontNeverBuffersPastTheOutstandingCredit(t *testing.T) {
	c := admittedConn(t, credit.WindowBytes)

	read := 0
	for {
		budget := c.ReadBudget()
		if budget == 0 {
			break
		}
		if budget > 4096 {
			budget = 4096
		}
		c.ReadIssued()
		if _, err := c.AcceptRead(make([]byte, budget)); err != nil {
			t.Fatalf("accepting a read after %d bytes: %v", read, err)
		}
		read += budget
		if read > int(credit.WindowBytes) {
			t.Fatalf("the front read %d bytes against a %d-byte grant with plane 6 idle-free",
				read, credit.WindowBytes)
		}
	}
	if read != int(credit.WindowBytes) {
		t.Fatalf("the front stopped at %d bytes; the whole grant is readable", read)
	}
	if c.PendingUp() != int(credit.WindowBytes)/4096 {
		t.Fatalf("the queue holds %d items", c.PendingUp())
	}
}
