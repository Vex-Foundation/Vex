package control

import (
	"io"
	"net"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
)

// EVENTS. Every goroutine the front owns reports through one of these, and the
// supervisor is the only thing that ever touches state. The interface exists so
// the compiler, and not a comment, keeps that true.
type event interface{ frontEvent() }

// mainFrame is one decoded frame from plane 3 or plane 5.
type mainFrame struct{ frame frames.Frame }

// mainMalformed is a framing fault on a plane main writes. It is FATAL: once
// the framing is wrong the position in the stream is unknown, and every byte
// after it is a guess (protocol section 10).
type mainMalformed struct{ err *frames.MalformedError }

// planeEOF is a plane main writes reaching end of file. On plane 3 it is
// TERMINAL.
type planeEOF struct{ plane frames.Plane }

// planeReadFailed is a read failure on one of the four planes: ERROR code 2.
type planeReadFailed struct{ plane frames.Plane }

// planeWritten is one completed write on plane 4 or plane 6. err non-nil is
// ERROR code 3.
type planeWritten struct {
	plane frames.Plane
	err   error
}

// accepted is a handle the accept loop produced, whose raw slot is held.
type accepted struct{ conn net.Conn }

// acceptOverflow is the 22nd connection: already closed, already released,
// never registered.
type acceptOverflow struct{ count int }

// acceptFailed is an Accept that returned an error the loop survived.
type acceptFailed struct{}

// connRead is one completed read on an accepted handle.
type connRead struct {
	id    uint32
	bytes []byte
	err   error
}

// connWrote is one completed write, or CloseWrite, on an accepted handle.
type connWrote struct {
	id       uint32
	sequence uint64
	end      bool
	err      error
}

// handshakeExpired is the section 9 deadline elapsing for a connection whose
// first line never completed.
type handshakeExpired struct{ id uint32 }

// parentGone is the stdin watch firing (section 8).
type parentGone struct{ signal lifecycle.ParentSignal }

// quitExpired is main's remaining absolute budget elapsing during a QUIT drain.
type quitExpired struct{}

func (mainFrame) frontEvent()        {}
func (mainMalformed) frontEvent()    {}
func (planeEOF) frontEvent()         {}
func (planeReadFailed) frontEvent()  {}
func (planeWritten) frontEvent()     {}
func (accepted) frontEvent()         {}
func (acceptOverflow) frontEvent()   {}
func (acceptFailed) frontEvent()     {}
func (connRead) frontEvent()         {}
func (connWrote) frontEvent()        {}
func (handshakeExpired) frontEvent() {}
func (parentGone) frontEvent()       {}
func (quitExpired) frontEvent()      {}

// planeReadChunk is the read size for a plane main writes. It is deliberately
// larger than one frame: one OS read of a shared plane carries many frames, and
// the decoder consumes the chunk BY OFFSET without ever concatenating it, so a
// bigger read costs no retention (protocol section 2.2).
const planeReadChunk = 64 * 1024

// readMainPlane owns ONE goroutine per plane main writes. It decodes and hands
// frames to the supervisor, and it stops at the first framing fault because
// there is no resynchronisation to offer.
//
// LOCK IS ROUTED TO THE PRIORITY CHANNEL. Protocol section 8 requires the front
// to process LOCK "ahead of any queued traffic", and endpoint contract 4.1.1
// calls it "a PRIORITY LOCK FRAME to the front, ahead of any queued traffic".
// One ordered channel cannot do that, so LOCK travels on its own and everything
// else keeps its order on the shared one. Jumping the queue is the POINT: an
// ADMIT that was already decoded behind a LOCK names the old epoch and must be
// purged rather than executed.
func (s *Supervisor) readMainPlane(plane frames.Plane, r io.Reader, dec *frames.Decoder, sink chan<- event) {
	buf := make([]byte, planeReadChunk)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			decoded, decodeErr := dec.Push(buf[:n])
			for _, f := range decoded {
				target := sink
				if _, isLock := f.Payload.(frames.Lock); isLock {
					target = s.priority
				}
				if !s.emit(target, mainFrame{frame: f}) {
					return
				}
			}
			if decodeErr != nil {
				var malformed *frames.MalformedError
				if failure := dec.Failure(); failure != nil {
					malformed = failure
				}
				s.emit(s.priority, mainMalformed{err: malformed})
				return
			}
		}
		if err != nil {
			if err == io.EOF {
				s.emit(s.priority, planeEOF{plane: plane})
			} else {
				s.emit(s.priority, planeReadFailed{plane: plane})
			}
			return
		}
	}
}

// emit delivers one event unless the front has already stopped serving. It
// reports whether the caller should keep going.
func (s *Supervisor) emit(sink chan<- event, e event) bool {
	select {
	case sink <- e:
		return true
	case <-s.done:
		return false
	}
}

// planeWriter owns ONE goroutine and one outbound plane. The supervisor hands
// it at most one encoded frame at a time and learns of the completion through
// the event channel, so the supervisor itself never blocks on a write.
type planeWriter struct {
	plane frames.Plane
	w     io.Writer
	jobs  chan []byte
	// sequence is the plane's own counter. It starts at 1 and is EXACTLY
	// contiguous; it is assigned by the supervisor at hand-off, which is the
	// only moment the write order is settled.
	sequence uint64
	busy     bool
}

func (s *Supervisor) startPlaneWriter(plane frames.Plane, w io.Writer) *planeWriter {
	pw := &planeWriter{plane: plane, w: w, jobs: make(chan []byte, 1), sequence: 1}
	s.writers.Add(1)
	go func() {
		defer s.writers.Done()
		for b := range pw.jobs {
			_, err := pw.w.Write(b)
			if !s.emit(s.ctrl, planeWritten{plane: pw.plane, err: err}) {
				return
			}
		}
	}()
	return pw
}

// hand gives the writer one encoded frame. The caller has already established
// that the writer is idle.
func (p *planeWriter) hand(encoded []byte) {
	p.busy = true
	p.jobs <- encoded
}

// startConnRead issues ONE read on an accepted handle.
//
// One outstanding read per connection keeps a connection's chunks ordered
// without a lock, and it means the goroutine has a definite end: it delivers
// exactly one result and returns. It is NOT what bounds the front's buffering -
// a read may be issued the instant the previous one returns, so the queue would
// grow without a second gate. What bounds the buffering is the GRANT, charged
// by relay.AcceptRead when the bytes leave the operating system (section 11.1).
func (s *Supervisor) startConnRead(id uint32, wire connWire, budget int) {
	go func() {
		buf := make([]byte, budget)
		n, err := wire.Read(buf)
		s.emit(s.ctrl, connRead{id: id, bytes: buf[:n], err: err})
	}()
}

// startConnWrite performs ONE write, or ONE half-close, on an accepted handle.
//
// CloseWrite runs on this same path and in this same order because END travels
// on the DATA plane precisely so it cannot overtake the last chunk it
// terminates (section 7.1). Doing it anywhere else would put the half-close on
// a different schedule from the bytes it ends.
func (s *Supervisor) startConnWrite(id uint32, wire connWire, sequence uint64, payload []byte, end bool) {
	go func() {
		var err error
		if end {
			err = wire.CloseWrite()
		} else {
			_, err = wire.Write(payload)
		}
		s.emit(s.ctrl, connWrote{id: id, sequence: sequence, end: end, err: err})
	}()
}

// Accepted, Overflow and AcceptFailed are the listener.Sink implementation. All
// three run on the accept goroutine, and none of them touches supervisor state.
func (s *Supervisor) Accepted(conn net.Conn) bool {
	return s.emit(s.ctrl, accepted{conn: conn})
}

func (s *Supervisor) Overflow(count int) {
	s.emit(s.ctrl, acceptOverflow{count: count})
}

func (s *Supervisor) AcceptFailed(error) bool {
	return s.emit(s.ctrl, acceptFailed{})
}
