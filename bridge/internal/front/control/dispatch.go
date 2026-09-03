package control

import (
	"io"
	"math"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
	"github.com/Vex-Foundation/vex/bridge/internal/front/relay"
)

// refusalSequence marks a write that is not a plane 5 chunk: main's refusal
// bytes, which cost no window and are never acknowledged. Plane sequences start
// at 1, so 0 can never collide with a real one.
const refusalSequence uint64 = 0

// handle is the single dispatch point. Every state change in the front happens
// here, on one goroutine.
func (s *Supervisor) handle(e event) {
	switch ev := e.(type) {
	case mainFrame:
		s.handleFrame(ev.frame)
	case mainMalformed:
		s.handleMalformed(ev)
	case planeEOF:
		// Plane 3 closed is TERMINAL (section 8). Plane 5 closed is the same
		// fact seen from the other pipe: main has stopped speaking, and a front
		// that kept serving handles for a main that is gone is exactly what the
		// lifecycle rules forbid.
		s.finish(lifecycle.ExitClean, "plane_eof", lifecycle.Num("plane", uint64(ev.plane)))
	case planeReadFailed:
		s.fail(frames.ErrorPlaneReadFailed, lifecycle.ExitPlaneIO, "plane_read_failed",
			lifecycle.Num("plane", uint64(ev.plane)))
	case planeWritten:
		s.handlePlaneWritten(ev)
	case accepted:
		s.handleAccepted(ev)
	case acceptOverflow:
		// The 22nd is already closed and released. It is logged and forgotten:
		// it was never registered and it carries no refusal line, because main
		// authors every line the peer sees and main was never told about it.
		s.log.Event("raw_bound_refusal", lifecycle.Num("count", uint64(ev.count)))
	case acceptFailed:
		s.log.Event("accept_failed", lifecycle.Num("live", uint64(s.raw.Live())))
	case connRead:
		s.handleConnRead(ev)
	case connWrote:
		s.handleConnWrote(ev)
	case handshakeExpired:
		s.handleHandshakeExpired(ev)
	case parentGone:
		s.finish(lifecycle.ExitParentGone, "parent_gone", lifecycle.Num("signal", uint64(ev.signal)))
	case quitExpired:
		s.log.Event("quit_deadline_elapsed")
		s.completeQuit()
	}
}

// handleMalformed ends the front. There is no resynchronisation and no
// skipping: once the framing is wrong the position in the stream is unknown.
// The log carries the PLANE, the TYPE, the LENGTH and the SEQUENCE, and never
// the payload, which is peer content (section 10).
func (s *Supervisor) handleMalformed(ev mainMalformed) {
	fields := []lifecycle.Field{}
	code := "malformed_main_frame"
	if ev.err != nil {
		code = "malformed_main_frame:" + string(ev.err.Reason)
		fields = append(fields,
			lifecycle.Num("plane", uint64(ev.err.Plane)),
			lifecycle.Num("type", uint64(ev.err.Type)),
			lifecycle.Num("connection", uint64(ev.err.Connection)),
			lifecycle.Num("sequence", ev.err.Sequence),
			lifecycle.Num("length", uint64(ev.err.Length)))
	}
	s.fail(frames.ErrorMalformedMainFrame, lifecycle.ExitMalformedFrame, code, fields...)
}

func (s *Supervisor) handlePlaneWritten(ev planeWritten) {
	switch ev.plane {
	case frames.PlaneControlUp:
		s.controlUp.busy = false
	case frames.PlaneDataUp:
		s.dataUp.busy = false
	}
	if ev.err != nil {
		s.fail(frames.ErrorPlaneWriteFailed, lifecycle.ExitPlaneIO, "plane_write_failed",
			lifecycle.Num("plane", uint64(ev.plane)))
	}
}

// handleFrame executes one control or data frame from main.
func (s *Supervisor) handleFrame(f frames.Frame) {
	switch p := f.Payload.(type) {
	case frames.Hello:
		// A second HELLO cannot reach here: the decoder has adopted a
		// generation, so a further bootstrap frame is bad_generation.
		s.fail(frames.ErrorMalformedMainFrame, lifecycle.ExitMalformedFrame, "duplicate_hello")
	case frames.Admit:
		s.handleAdmit(f.Connection, p)
	case frames.Refuse:
		s.handleRefuse(f.Connection, p)
	case frames.Credit:
		s.handleCredit(f.Connection, p)
	case frames.Pause:
		if conn := s.live(f.Connection); conn != nil {
			conn.Pause()
			s.log.Event("paused", lifecycle.Num("connection", uint64(f.Connection)))
		}
	case frames.Resume:
		if conn := s.live(f.Connection); conn != nil {
			conn.Resume()
			s.log.Event("resumed", lifecycle.Num("connection", uint64(f.Connection)))
		}
	case frames.Close:
		if conn := s.live(f.Connection); conn != nil {
			s.closeConn(conn, frames.PeerClosedCommandedClose)
		}
	case frames.Lock:
		s.handleLock(p)
	case frames.Quit:
		s.handleQuit(p)
	case frames.Ping:
		s.queueUp(0, frames.Pong{Nonce: p.Nonce})
	case frames.Data:
		s.handleDownData(f, p)
	case frames.End:
		s.handleDownEnd(f)
	}
}

// live returns a connection that still has a handle, or nil.
//
// A frame naming a connection the front has already closed is NOT a fault: main
// and the front are two processes on two pipes, and main may well have written
// a CREDIT a microsecond before the peer left. It is logged and dropped.
func (s *Supervisor) live(id uint32) *relay.Conn {
	conn, ok := s.conns[id]
	if !ok || conn.State() == relay.StateClosed {
		s.log.Event("frame_for_closed_connection", lifecycle.Num("connection", uint64(id)))
		return nil
	}
	return conn
}

// handleAdmit executes the ADMISSION FENCE.
//
// A LOCK raises the epoch, and every ADMIT still queued behind it names the OLD
// one and is PURGED, not executed. Without that rule a lock could be undone by
// an ADMIT main sent a microsecond before deciding to lock, and reading would
// resume on a connection main has already latched a `lock` cause for.
//
// stale_admit_purged is the ONE named failure of section 12.3 that is NOT
// fatal: it is the fence working rather than a peer breaking an invariant, and
// a front that killed itself here would die every time a lock raced an admit.
// It moves NOTHING - the connection stays exactly where it was.
// THE EPOCH IS CHECKED FIRST, before the connection is even looked up. A LOCK
// closes every handle, so an ADMIT that was queued behind one always names a
// connection the front has already closed; checking liveness first would report
// every purged order under the wrong name and leave `stale_admit_purged` - the
// one entry in section 12.3 that is not a peer fault - unreachable in exactly
// the case it was written for.
func (s *Supervisor) handleAdmit(id uint32, admit frames.Admit) {
	if admit.AdmissionEpoch != s.epoch {
		s.log.Event("stale_admit_purged",
			lifecycle.Num("connection", uint64(id)),
			lifecycle.Num("epoch", uint64(admit.AdmissionEpoch)),
			lifecycle.Num("current", uint64(s.epoch)))
		return
	}
	conn := s.live(id)
	if conn == nil {
		return
	}
	conn.Admit()
	s.log.Event("admitted", lifecycle.Num("connection", uint64(id)))
}

// handleRefuse writes main's exact bytes to the peer and closes, WITHOUT EVER
// READING.
//
// THE REFUSAL BYTES ARE MAIN'S, ALWAYS. The front is cause-transparent: it
// relays bytes it did not compose, so the frozen v1 acks and refusal codes stay
// exactly what the bridge already parses and a second author of refusal text
// never appears.
func (s *Supervisor) handleRefuse(id uint32, refuse frames.Refuse) {
	conn := s.live(id)
	if conn == nil {
		return
	}
	conn.Refuse()
	if stop, ok := s.timers[id]; ok {
		stop.Stop()
		delete(s.timers, id)
	}
	if refuse.Bytes == "" {
		s.closeConn(conn, frames.PeerClosedCommandedClose)
		return
	}
	s.startConnWrite(id, conn.Wire(), refusalSequence, []byte(refuse.Bytes), false)
}

func (s *Supervisor) handleCredit(id uint32, grant frames.Credit) {
	conn := s.live(id)
	if conn == nil {
		return
	}
	if err := conn.GrantCredit(grant.Bytes); err != nil {
		s.failFlow(err)
	}
}

// handleLock is PRIORITY: it has already jumped every queued frame on its way
// here (io.go routes it to its own channel). It sets the epoch, stops all
// reads, closes all handles and answers LOCK_ACK.
//
// closedCount is how many handles the front ACTUALLY closed. Main logs it
// against the number of logical connections it believed were open; a divergence
// is a structural defect worth seeing, not a reason to hold the lock.
func (s *Supervisor) handleLock(lock frames.Lock) {
	s.epoch = lock.AdmissionEpoch
	s.noteEpoch()
	closed := s.closeAll(frames.PeerClosedCommandedClose)
	s.queueUp(0, frames.LockAck{AdmissionEpoch: s.epoch, ClosedCount: closed})
	s.log.Event("locked", lifecycle.Num("epoch", uint64(s.epoch)), lifecycle.Num("closed", uint64(closed)))
}

// handleQuit drains under MAIN's ONE ABSOLUTE BUDGET.
//
// deadlineMs is what REMAINS of that budget at the moment main sent the frame,
// so the front's drain and main's own shutdown share one clock. Two independent
// 5-second deadlines would be a 10-second quit, and the endpoint contract
// promises one.
func (s *Supervisor) handleQuit(quit frames.Quit) {
	if s.quitting {
		return
	}
	s.quitting = true
	s.log.Event("quit", lifecycle.Num("deadlineMs", uint64(quit.DeadlineMs)))
	s.quitDeadline = s.opts.AfterFunc(time.Duration(quit.DeadlineMs)*time.Millisecond, func() {
		s.emit(s.priority, quitExpired{})
	})
}

// handleDownData queues one of main's chunks for the peer.
func (s *Supervisor) handleDownData(f frames.Frame, data frames.Data) {
	conn := s.live(f.Connection)
	if conn == nil {
		return
	}
	if err := conn.QueueDown(f.Sequence, data.Payload); err != nil {
		s.failFlow(err)
	}
}

// handleDownEnd queues main's half-close: close the WRITABLE side of the pipe
// handle, leave the readable side open (section 7.1).
func (s *Supervisor) handleDownEnd(f frames.Frame) {
	conn := s.live(f.Connection)
	if conn == nil {
		return
	}
	if err := conn.QueueDownEnd(f.Sequence); err != nil {
		s.failFlow(err)
	}
}

// handleAccepted registers a handle the accept loop produced.
//
// The raw slot is ALREADY HELD; this is where the connection gets its id, its
// handshake deadline and its OPEN, and it reads nothing until main admits it.
func (s *Supervisor) handleAccepted(ev accepted) {
	half, ok := ev.conn.(interface{ CloseWrite() error })
	if !ok {
		// A handle with no half-close cannot keep the END contract, so it is
		// refused as a handle rather than served as a broken one.
		_ = ev.conn.Close()
		s.raw.Release()
		s.fail(frames.ErrorInternalInvariant, lifecycle.ExitInternalInvariant, "handle_without_half_close")
		return
	}
	if s.nextConnID == math.MaxUint32 {
		_ = ev.conn.Close()
		s.raw.Release()
		s.fail(frames.ErrorConnectionIDsExhausted, lifecycle.ExitInternalInvariant, "connection_ids_exhausted")
		return
	}
	id := s.nextConnID
	s.nextConnID++

	conn := relay.New(id, wire{Conn: ev.conn, closeWrite: half.CloseWrite})
	s.conns[id] = conn
	s.order = append(s.order, id)

	// THE HANDSHAKE DEADLINE IS MEASURED FROM ACCEPT, and the front is the
	// process that accepts, so the front owns the timer. Main's first sight of
	// the connection is already later than the clock's start (section 9).
	s.timers[id] = s.opts.AfterFunc(
		time.Duration(s.hello.HandshakeDeadlineMs)*time.Millisecond,
		func() { s.emit(s.ctrl, handshakeExpired{id: id}) })

	conn.OpenSent()
	s.queueUp(id, frames.Open{})
	s.log.Event("accepted",
		lifecycle.Num("connection", uint64(id)),
		lifecycle.Num("live", uint64(s.raw.Live())))
}

// handleConnRead takes what one read returned.
func (s *Supervisor) handleConnRead(ev connRead) {
	conn, ok := s.conns[ev.id]
	if !ok || conn.State() == relay.StateClosed {
		return
	}
	if len(ev.bytes) > 0 {
		completed, err := conn.AcceptRead(ev.bytes)
		if err != nil {
			s.failFlow(err)
			return
		}
		if completed {
			// THE FRONT DETECTS THE FIRST NEWLINE AND NOTHING ELSE. It does not
			// parse JSON, it does not look at a project id, it does not
			// interpret a single project byte (section 9).
			if stop, armed := s.timers[ev.id]; armed {
				stop.Stop()
				delete(s.timers, ev.id)
			}
		}
	} else {
		conn.ReadFailed()
	}
	if ev.err == nil {
		return
	}
	if ev.err == io.EOF {
		// A MESSAGE-mode pipe delivers the peer's CloseWrite as EOF, and that
		// is a HALF-close: the writable side stays open so the last response of
		// a one-shot session can still be written (section 7.1).
		if err := conn.PeerEnded(); err != nil {
			s.failFlow(err)
		}
		return
	}
	// Anything else is the handle itself failing or the peer disappearing
	// outright. Both end the connection; the reason separates them for main's
	// structural log and for nothing else, because the front never authors a
	// domain cause.
	s.closeConn(conn, s.readFailureReason(ev.err))
}

// readFailureReason maps a read failure to a STRUCTURAL cause. `peer_eof` is
// the peer leaving; `io_error` is the handle failing. Neither is a domain
// cause, and the front does not know the word `lock`.
func (s *Supervisor) readFailureReason(err error) frames.PeerClosedReason {
	if isPeerGone(err) {
		return frames.PeerClosedPeerEOF
	}
	return frames.PeerClosedIOError
}

// handleConnWrote takes one completed peer write.
func (s *Supervisor) handleConnWrote(ev connWrote) {
	conn, ok := s.conns[ev.id]
	if !ok || conn.State() == relay.StateClosed {
		return
	}
	if ev.sequence == refusalSequence && !ev.end {
		// A refusal is written ONCE and the handle then closes, whether or not
		// the write succeeded: the peer either got main's line or got nothing,
		// and either way it never gets a second one.
		s.closeConn(conn, frames.PeerClosedCommandedClose)
		return
	}
	if ev.err != nil {
		conn.WriteFailed()
		s.closeConn(conn, frames.PeerClosedIOError)
		return
	}
	if ev.end {
		conn.EndCompleted()
		return
	}
	// THE ACKNOWLEDGEMENT IS EMITTED ONLY AFTER THE PIPE WRITE RETURNED, never
	// when the front accepted the chunk from plane 5 (section 6.4).
	ackThrough, err := conn.WriteCompleted(ev.sequence)
	if err != nil {
		s.failFlow(err)
		return
	}
	s.queueUp(ev.id, frames.WriteDone{AckThroughSequence: ackThrough})
}

// handleHandshakeExpired writes HELLO's timeoutRefusalBytes verbatim and
// closes.
//
// The bytes are MAIN's, composed by main, and the front relays them without
// composing a word of its own. The connection is reported closed with
// `commanded_close`: the peer did not leave and nothing failed, and the close
// executes a policy main stated in HELLO.
func (s *Supervisor) handleHandshakeExpired(ev handshakeExpired) {
	delete(s.timers, ev.id)
	conn, ok := s.conns[ev.id]
	if !ok || conn.State() == relay.StateClosed || conn.HandshakeSeen() {
		return
	}
	s.log.Event("handshake_deadline", lifecycle.Num("connection", uint64(ev.id)))
	conn.Refuse()
	if s.hello.TimeoutRefusalBytes == "" {
		s.closeConn(conn, frames.PeerClosedCommandedClose)
		return
	}
	s.startConnWrite(ev.id, conn.Wire(), refusalSequence, []byte(s.hello.TimeoutRefusalBytes), false)
}
