package control

import (
	"errors"
	"io"
	"math"
	"net"
	"sync"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/front/credit"
	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
	"github.com/Vex-Foundation/vex/bridge/internal/front/listener"
	"github.com/Vex-Foundation/vex/bridge/internal/front/relay"
)

// StopTimer is the half of a timer the supervisor keeps: the ability to cancel
// it. It is an interface so tests can drive the section 9 handshake deadline -
// a FROZEN 5000 ms - without waiting five seconds, the way VS Code's protocol
// suite drives its acknowledgement timers with faked time rather than sleeps.
type StopTimer interface{ Stop() bool }

// Options is everything the supervisor does not own itself.
type Options struct {
	// Planes are the four framed streams of protocol section 1.
	Planes *lifecycle.Planes
	// Log receives structural codes and counts, never content.
	Log *lifecycle.Logger
	// Bind creates the named pipe HELLO names and reads its properties back.
	Bind func(pipeName string) (*listener.Binding, error)
	// Parent fires when main is gone (section 8).
	Parent <-chan lifecycle.ParentSignal
	// FrontVersion and BuildHash are recorded in main's structural log so a
	// support bundle can say which front produced a session.
	FrontVersion string
	BuildHash    string
	// Pid is a CONSISTENCY check main runs against the child it spawned, never
	// authentication.
	Pid uint32
	// Generation supplies the fresh NON-ZERO generation HELLO_ACK announces.
	Generation func() uint32
	// AfterFunc schedules a timer. It defaults to time.AfterFunc.
	AfterFunc func(d time.Duration, f func()) StopTimer
}

// controlQueueBound is the plane 4 pending-frame bound.
//
// The queue is bounded by construction as well as by number: WRITE_DONE
// coalesces per connection, ERROR coalesces per code, and OPEN and PEER_CLOSED
// are one each per connection id. The number is the guard for the case none of
// that covers - a main that stopped reading plane 4 altogether - and crossing it
// is an internal invariant, not a peer fault, because a correct main cannot
// produce it.
const controlQueueBound = 512

// flushBudget bounds the wait for plane 4 to drain on a fatal exit. The front
// is dying; the ERROR frame is worth a bounded moment and not more.
const flushBudget = 250 * time.Millisecond

// eventQueueDepth is the depth of the two ordinary event channels. A full
// channel is BACK PRESSURE, not a fault: the plane reader blocks, main's writes
// block in the operating system, and the pressure reaches main. The supervisor
// itself never blocks, so a full queue always drains.
const eventQueueDepth = 128

// wire adapts an accepted net.Conn to relay.Wire. Half-close is not part of
// net.Conn, and it is not optional here: END is a half-close and a connection
// that cannot perform one is a connection whose contract the front cannot keep.
type wire struct {
	net.Conn
	closeWrite func() error
}

func (w wire) CloseWrite() error { return w.closeWrite() }

// connWire is the handle interface the I/O goroutines use.
type connWire = relay.Wire

// Supervisor is the ONE owner of the front's state: the admission epoch, the
// connection table, the four planes' sequence counters, the raw handle count
// and every timer. Nothing else mutates any of it; every goroutine reports
// through a channel and the loop below is single-threaded by construction.
type Supervisor struct {
	opts Options
	log  *lifecycle.Logger

	priority  chan event
	ctrl      chan event
	data      chan event
	done      chan struct{}
	closeOnce sync.Once
	writers   sync.WaitGroup

	hello      frames.Hello
	generation uint32
	// epoch is the admission fence. The front NEVER resets, chooses or advances
	// it: it is initialised from HELLO and its only other write is the value a
	// LOCK carries (section 5.2).
	epoch                 uint32
	epochExhaustionLogged bool
	binding               *listener.Binding
	raw                   listener.RawHandles

	conns      map[uint32]*relay.Conn
	order      []uint32
	roundRobin int
	nextConnID uint32
	timers     map[uint32]StopTimer

	controlUp *planeWriter
	dataUp    *planeWriter
	upPending []upFrame

	errorCounts map[frames.ErrorCode]uint32

	quitting     bool
	quitDeadline StopTimer
	terminal     bool
	exit         int
}

// upFrame is one plane 4 frame waiting for a sequence number. Sequences are
// assigned at HAND-OFF, so a frame still in this queue may still be COALESCED;
// one the writer has taken is immutable, which is the same rule the host's
// outbound queue keeps for progress notifications.
type upFrame struct {
	connection uint32
	payload    frames.Payload
}

// New builds a supervisor. It starts nothing; Run does.
func New(opts Options) *Supervisor {
	if opts.AfterFunc == nil {
		opts.AfterFunc = func(d time.Duration, f func()) StopTimer { return time.AfterFunc(d, f) }
	}
	return &Supervisor{
		opts:        opts,
		log:         opts.Log,
		priority:    make(chan event, eventQueueDepth),
		ctrl:        make(chan event, eventQueueDepth),
		data:        make(chan event, eventQueueDepth),
		done:        make(chan struct{}),
		conns:       make(map[uint32]*relay.Conn),
		timers:      make(map[uint32]StopTimer),
		nextConnID:  1,
		errorCounts: make(map[frames.ErrorCode]uint32),
	}
}

// Run serves until the front is done, and returns the process exit code.
func (s *Supervisor) Run() int {
	defer s.stopEverything()

	s.controlUp = s.startPlaneWriter(frames.PlaneControlUp, s.opts.Planes.ControlUp)
	s.dataUp = s.startPlaneWriter(frames.PlaneDataUp, s.opts.Planes.DataUp)

	controlDown := frames.NewDecoder(frames.PlaneControlDown, 0, 0)
	pending, code := s.bootstrap(controlDown)
	if code != lifecycle.ExitClean {
		s.flushControlUp(flushBudget)
		return code
	}

	dataDown := frames.NewDecoder(frames.PlaneDataDown, s.generation, 0)
	go s.readMainPlane(frames.PlaneControlDown, s.opts.Planes.ControlDown, controlDown, s.ctrl)
	go s.readMainPlane(frames.PlaneDataDown, s.opts.Planes.DataDown, dataDown, s.data)
	go listener.Serve(s.binding.Listener, &s.raw, s)

	// Frames that arrived in the SAME read as HELLO are replayed first, in
	// order, before anything the readers produce.
	for _, f := range pending {
		s.handle(mainFrame{frame: f})
	}

	for !s.terminal {
		s.pump()
		if s.terminal {
			break
		}
		s.step()
	}

	s.flushControlUp(flushBudget)
	return s.exit
}

// step waits for the next event, giving LOCK and the terminal conditions strict
// priority over ordinary control frames, and ordinary control frames priority
// over data. Control is never queued behind data because control has its own
// pipe, and this select is the front's half of that property.
func (s *Supervisor) step() {
	select {
	case e := <-s.priority:
		s.handle(e)
		return
	default:
	}
	select {
	case e := <-s.priority:
		s.handle(e)
	case e := <-s.ctrl:
		s.handle(e)
	case sig := <-s.opts.Parent:
		s.handle(parentGone{signal: sig})
	default:
		select {
		case e := <-s.priority:
			s.handle(e)
		case e := <-s.ctrl:
			s.handle(e)
		case e := <-s.data:
			s.handle(e)
		case sig := <-s.opts.Parent:
			s.handle(parentGone{signal: sig})
		}
	}
}

// bootstrap performs protocol section 4's exchange and section 8's bind, and
// returns any frames that arrived in the same read as HELLO.
func (s *Supervisor) bootstrap(dec *frames.Decoder) ([]frames.Frame, int) {
	decoded, err := s.readHello(dec)
	if err != nil {
		s.log.Event("hello_not_received")
		return nil, lifecycle.ExitStartup
	}
	hello, ok := decoded[0].Payload.(frames.Hello)
	if !ok {
		s.log.Event("hello_expected", lifecycle.Num("type", uint64(decoded[0].Type())))
		return nil, lifecycle.ExitStartup
	}
	if mismatch := ValidateHello(hello); mismatch != nil {
		var m *HelloMismatch
		if errors.As(mismatch, &m) {
			s.log.Event("hello_mismatch", lifecycle.Num(m.Field, m.Got), lifecycle.Num("want", m.Want))
		}
		return nil, lifecycle.ExitHelloRejected
	}
	s.hello = hello
	// The epoch is TAKEN, never chosen: main's epoch is monotonic for the life
	// of the app, so a RESTARTED front receives the SAME current epoch the dead
	// one was last serving. A front that assumed 0 would reject every valid
	// ADMIT and hang silently (section 5.2).
	s.epoch = hello.InitialAdmissionEpoch
	s.noteEpoch()

	s.generation = s.opts.Generation()
	if s.generation == 0 {
		s.log.Event("generation_zero")
		return nil, lifecycle.ExitInternalInvariant
	}
	s.queueUp(0, frames.HelloAck{
		ProtocolVersion:     frames.ProtocolVersion,
		AnnouncedGeneration: s.generation,
		Pid:                 s.opts.Pid,
		FrontVersion:        s.opts.FrontVersion,
		BuildHash:           s.opts.BuildHash,
	})

	binding, bindErr := s.opts.Bind(hello.PipeName)
	if bindErr != nil {
		var readback *listener.ReadbackError
		if errors.As(bindErr, &readback) {
			s.reportError(frames.ErrorSDDLReadbackMismatch)
			s.log.Event("sddl_readback_mismatch:"+readback.Reason,
				lifecycle.Num("got", readback.Got), lifecycle.Num("want", readback.Want))
		} else {
			s.reportError(frames.ErrorListenerBindFailed)
			s.log.Event("listener_bind_failed")
		}
		return nil, lifecycle.ExitListener
	}
	s.binding = binding
	// BOUND IS EMITTED ONLY AFTER RUNTIME READBACK. A flag the front asked for
	// and did not confirm is reported 0, and main decides what to do about it.
	s.queueUp(0, frames.Bound{FlagsApplied: binding.FlagsApplied, PipeName: hello.PipeName})
	s.log.Event("bound", lifecycle.Num("flags", uint64(binding.FlagsApplied)))

	if err := dec.AdoptGeneration(s.generation); err != nil {
		s.log.Event("generation_adopt_failed")
		return nil, lifecycle.ExitInternalInvariant
	}
	return decoded[1:], lifecycle.ExitClean
}

// readHello reads plane 3 until the first frame completes. It runs BEFORE the
// plane 3 reader goroutine exists, because the decoder's one generation
// adoption has to happen between HELLO and everything after it, and a decoder
// with two owners is a decoder with none.
func (s *Supervisor) readHello(dec *frames.Decoder) ([]frames.Frame, error) {
	buf := make([]byte, planeReadChunk)
	for {
		n, err := s.opts.Planes.ControlDown.Read(buf)
		if n > 0 {
			decoded, decodeErr := dec.Push(buf[:n])
			if decodeErr != nil {
				return nil, decodeErr
			}
			if len(decoded) > 0 {
				return decoded, nil
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil, io.EOF
			}
			return nil, err
		}
	}
}

// noteEpoch reports a spent admission epoch exactly once.
//
// The front cannot fix it and must not try: the remedy is a full APPLICATION
// restart, never a front restart, which would come up at the same exhausted
// value (section 5.2).
func (s *Supervisor) noteEpoch() {
	if s.epoch == math.MaxUint32 && !s.epochExhaustionLogged {
		s.epochExhaustionLogged = true
		s.reportError(frames.ErrorAdmissionEpochExhausted)
		s.log.Event("admission_epoch_exhausted")
	}
}

// queueUp appends one plane 4 frame, coalescing where the protocol allows it.
func (s *Supervisor) queueUp(connection uint32, payload frames.Payload) {
	switch p := payload.(type) {
	case frames.WriteDone:
		// CUMULATIVE: one acknowledgement names everything through itself, so a
		// newer one REPLACES a queued older one for the same connection at no
		// cost in correctness and one fewer frame on the wire.
		for i := range s.upPending {
			if s.upPending[i].connection == connection {
				if _, ok := s.upPending[i].payload.(frames.WriteDone); ok {
					s.upPending[i].payload = p
					return
				}
			}
		}
	case frames.ErrorReport:
		// `count` is how many times the code occurred SINCE THE LAST ERROR for
		// it, so a queued one absorbs the repeat rather than adding a frame.
		for i := range s.upPending {
			if existing, ok := s.upPending[i].payload.(frames.ErrorReport); ok && existing.Code == p.Code {
				existing.Count += p.Count
				s.upPending[i].payload = existing
				return
			}
		}
	}
	if len(s.upPending) >= controlQueueBound {
		s.fail(frames.ErrorInternalInvariant, lifecycle.ExitInternalInvariant, "control_queue_overflow",
			lifecycle.Num("queued", uint64(len(s.upPending))))
		return
	}
	s.upPending = append(s.upPending, upFrame{connection: connection, payload: payload})
}

// reportError queues an ERROR frame for main's structural log. The codes are a
// LOG vocabulary and never a teardown cause: a connection's end is always a
// PEER_CLOSED, and no ERROR code changes that.
func (s *Supervisor) reportError(code frames.ErrorCode) {
	s.errorCounts[code]++
	s.queueUp(0, frames.ErrorReport{Code: code, Count: 1})
}

// fail ends the front. It records the structural code, reports it to main, and
// closes every connection's handle - which protocol section 10 requires of a
// front that has seen a malformed frame, and which is the right move for every
// other fatal condition too: a front that cannot be trusted must not be left
// holding live handles.
func (s *Supervisor) fail(code frames.ErrorCode, exit int, logCode string, fields ...lifecycle.Field) {
	if s.terminal {
		return
	}
	s.reportError(code)
	s.log.Event(logCode, fields...)
	s.closeAll(frames.PeerClosedCommandedClose)
	s.terminal = true
	s.exit = exit
}

// finish ends the front WITHOUT a failure: a commanded quit, plane 3 at EOF, or
// the parent's death.
func (s *Supervisor) finish(exit int, logCode string, fields ...lifecycle.Field) {
	if s.terminal {
		return
	}
	s.log.Event(logCode, fields...)
	s.closeAll(frames.PeerClosedCommandedClose)
	s.terminal = true
	s.exit = exit
}

// closeAll closes every live handle and reports how many it closed.
//
// Undelivered plane 6 frames are DROPPED, and PEER_CLOSED therefore carries the
// sequence of the last frame the front actually DELIVERED, which is what
// section 6.3 defines it as. Main has already latched its own cause by the time
// it commands a close, and holding a lock open to deliver bytes the peer will
// never get an answer to is the opposite of what a lock is for.
func (s *Supervisor) closeAll(reason frames.PeerClosedReason) uint32 {
	var closed uint32
	// closeConn REMOVES the connection from the table, so the rotation is walked
	// from a snapshot rather than mutated under the loop.
	for _, id := range append([]uint32(nil), s.order...) {
		conn, ok := s.conns[id]
		if !ok || conn.State() == relay.StateClosed {
			continue
		}
		s.closeConn(conn, reason)
		closed++
	}
	return closed
}

// forget removes a closed connection from the table and the plane 6 rotation.
//
// WITHOUT THIS THE TABLE GROWS FOR THE LIFE OF THE PROCESS. Connection ids are
// never reused, so a long session that churns connections would leave the
// rotation carrying every id it ever served, and the front would walk them on
// every pump. A late frame naming a forgotten id is not a fault - main and the
// front are two processes on two pipes - and it is dropped with a log line by
// live().
func (s *Supervisor) forget(id uint32) {
	delete(s.conns, id)
	for i, existing := range s.order {
		if existing == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	if len(s.order) == 0 {
		s.roundRobin = 0
		return
	}
	s.roundRobin %= len(s.order)
}

// closeConn performs the PHYSICAL close, releases the raw slot only after it has
// returned, and queues PEER_CLOSED.
func (s *Supervisor) closeConn(conn *relay.Conn, reason frames.PeerClosedReason) {
	if conn.State() == relay.StateClosed {
		return
	}
	if stop, ok := s.timers[conn.ID]; ok {
		stop.Stop()
		delete(s.timers, conn.ID)
	}
	_ = conn.Wire().Close()
	conn.MarkClosed()
	s.raw.Release()
	s.queueUp(conn.ID, conn.PeerClosedFrame(reason))
	s.forget(conn.ID)
	// `live` is the RAW HANDLE count and `tracked` is the size of the front's
	// own table. They are logged together because a divergence between them is
	// exactly the defect section 8.1 warns about, and because `tracked` is the
	// only outside view of a table that must not grow for the life of the
	// process.
	s.log.Event("connection_closed",
		lifecycle.Num("connection", uint64(conn.ID)),
		lifecycle.Num("reason", uint64(reason)),
		lifecycle.Num("live", uint64(s.raw.Live())),
		lifecycle.Num("tracked", uint64(len(s.conns))))
}

// pump does everything the supervisor can do without waiting: schedule reads,
// schedule writes, and give each outbound plane its next frame.
func (s *Supervisor) pump() {
	s.pumpConnIO()
	s.pumpControlUp()
	s.pumpDataUp()
	s.maybeFinishQuit()
}

// pumpConnIO issues at most one read and one write per connection.
func (s *Supervisor) pumpConnIO() {
	for _, id := range s.order {
		conn, ok := s.conns[id]
		if !ok || conn.State() == relay.StateClosed {
			continue
		}
		if !s.quitting {
			if budget := conn.ReadBudget(); budget > 0 {
				conn.ReadIssued()
				s.startConnRead(conn.ID, conn.Wire(), budget)
			}
		}
		if sequence, payload, end, ok := conn.NextDown(); ok {
			s.startConnWrite(conn.ID, conn.Wire(), sequence, payload, end)
		}
	}
}

// pumpControlUp hands plane 4 its next frame, assigning the sequence at
// hand-off, which is the moment the write order is settled.
func (s *Supervisor) pumpControlUp() {
	if s.controlUp.busy || len(s.upPending) == 0 {
		return
	}
	next := s.upPending[0]
	s.upPending = s.upPending[1:]
	if len(s.upPending) == 0 {
		s.upPending = nil
	}
	generation := s.generation
	if _, bootstrap := next.payload.(frames.HelloAck); bootstrap {
		// HELLO_ACK's HEADER generation is still the bootstrap 0 while its
		// PAYLOAD carries the new one (section 6.1).
		generation = 0
	}
	encoded, err := frames.Encode(frames.Frame{
		Plane:      frames.PlaneControlUp,
		Generation: generation,
		Connection: next.connection,
		Sequence:   s.controlUp.sequence,
		Payload:    next.payload,
	})
	if err != nil {
		s.fail(frames.ErrorInternalInvariant, lifecycle.ExitInternalInvariant, "control_encode_refused")
		return
	}
	s.controlUp.sequence++
	s.controlUp.hand(encoded)
}

// pumpDataUp gives ONE connection ONE turn on plane 6, round-robin.
//
// At most one 32 KiB chunk per connection per turn is section 11.1's fairness
// rule, and it is the reason one busy connection cannot starve twenty others on
// a shared plane. The rotation starts where the last turn ended, so no
// connection can be skipped twice in a row.
func (s *Supervisor) pumpDataUp() {
	if s.dataUp.busy || len(s.order) == 0 {
		return
	}
	for i := range s.order {
		index := (s.roundRobin + i) % len(s.order)
		conn, ok := s.conns[s.order[index]]
		if !ok || !conn.HasUpward() {
			continue
		}
		payload, end, err := conn.TakeUpward(s.dataUp.sequence)
		if err != nil {
			s.failFlow(err)
			return
		}
		var frame frames.Payload = frames.Data{Payload: payload}
		if end {
			frame = frames.End{}
		}
		encoded, encodeErr := frames.Encode(frames.Frame{
			Plane:      frames.PlaneDataUp,
			Generation: s.generation,
			Connection: conn.ID,
			Sequence:   s.dataUp.sequence,
			Payload:    frame,
		})
		if encodeErr != nil {
			s.fail(frames.ErrorInternalInvariant, lifecycle.ExitInternalInvariant, "data_encode_refused")
			return
		}
		s.dataUp.sequence++
		s.roundRobin = (index + 1) % len(s.order)
		s.dataUp.hand(encoded)
		return
	}
}

// failFlow maps a flow-control or relay invariant to its fatal exit. Every
// failure of section 12.3 is fatal EXCEPT stale_admit_purged, which never
// reaches here because it is the fence working rather than a peer breaking an
// invariant.
func (s *Supervisor) failFlow(err error) {
	var violation *credit.Violation
	var fault *relay.Fault
	switch {
	case errors.As(err, &violation):
		s.fail(frames.ErrorCreditViolation, lifecycle.ExitCreditViolation, violation.Name)
	case errors.As(err, &fault):
		if fault.Name == relay.NameInternalInvariant {
			s.fail(frames.ErrorInternalInvariant, lifecycle.ExitInternalInvariant, fault.Name)
			return
		}
		s.fail(frames.ErrorCreditViolation, lifecycle.ExitCreditViolation, fault.Name)
	default:
		s.fail(frames.ErrorInternalInvariant, lifecycle.ExitInternalInvariant, "unclassified_invariant")
	}
}

// maybeFinishQuit ends a commanded quit once every handle has drained.
func (s *Supervisor) maybeFinishQuit() {
	if !s.quitting || s.terminal {
		return
	}
	for _, conn := range s.conns {
		if conn.State() == relay.StateClosed {
			continue
		}
		if conn.PendingDown() > 0 || conn.WriteInFlight() || conn.PendingUp() > 0 {
			return
		}
	}
	if s.dataUp.busy || s.controlUp.busy || len(s.upPending) > 0 {
		return
	}
	s.completeQuit()
}

// completeQuit closes the handles, answers QUIT_ACK and ends the process.
func (s *Supervisor) completeQuit() {
	if s.quitDeadline != nil {
		s.quitDeadline.Stop()
		s.quitDeadline = nil
	}
	closed := s.closeAll(frames.PeerClosedCommandedClose)
	s.queueUp(0, frames.QuitAck{})
	s.log.Event("quit_ack", lifecycle.Num("closed", uint64(closed)))
	s.terminal = true
	s.exit = lifecycle.ExitClean
}

// flushControlUp gives plane 4 a bounded moment to write what is queued,
// including the ERROR frame of a fatal exit. It is the ONE place the supervisor
// waits on a write, and it waits under a stated budget.
func (s *Supervisor) flushControlUp(budget time.Duration) {
	deadline := make(chan struct{})
	stop := s.opts.AfterFunc(budget, func() { close(deadline) })
	defer stop.Stop()
	for {
		s.pumpControlUp()
		if !s.controlUp.busy && len(s.upPending) == 0 {
			return
		}
		select {
		case e := <-s.ctrl:
			if written, ok := e.(planeWritten); ok && written.plane == frames.PlaneControlUp {
				s.controlUp.busy = false
			}
		case <-deadline:
			s.log.Event("control_up_flush_incomplete", lifecycle.Num("queued", uint64(len(s.upPending))))
			return
		}
	}
}

// stopEverything releases what the supervisor owns, in reverse acquisition
// order, and collects rather than stops at the first failure.
func (s *Supervisor) stopEverything() {
	for id, stop := range s.timers {
		stop.Stop()
		delete(s.timers, id)
	}
	if s.quitDeadline != nil {
		s.quitDeadline.Stop()
	}
	for _, conn := range s.conns {
		if conn.State() != relay.StateClosed {
			_ = conn.Wire().Close()
			conn.MarkClosed()
			s.raw.Release()
		}
	}
	if s.binding != nil {
		_ = s.binding.Listener.Close()
	}
	s.closeOnce.Do(func() { close(s.done) })
	if s.controlUp != nil {
		close(s.controlUp.jobs)
	}
	if s.dataUp != nil {
		close(s.dataUp.jobs)
	}
	// The plane writers are joinable; the per-read and per-write goroutines are
	// not, because each is parked in an operation on a handle that is now
	// closed and their only remaining owner is process exit (endpoint contract
	// 3.5 states that abandonment as deliberate).
	//
	// Even the join is BOUNDED: a writer parked in a write to a plane main has
	// stopped reading would otherwise hold the process open forever, and a
	// front that cannot exit is the one outcome worse than a lost log line.
	joined := make(chan struct{})
	go func() {
		s.writers.Wait()
		close(joined)
	}()
	select {
	case <-joined:
	case <-time.After(flushBudget):
	}
}
