// Package relay owns the FRONT's per-connection state machine: protocol
// section 12.1, the half-close rules of section 7.1, the handshake newline scan
// of section 9, and the flow control of section 11 applied to one accepted
// handle.
//
// It is PURE STATE. It issues no reads, no writes and no closes, and it starts
// no goroutines: the supervisor in the control package owns every handle and
// every goroutine, and asks this type what to do next. That split is what makes
// the whole machine testable on a platform with no named pipes - which is where
// most of the proof has to live, because the Windows job is one runner and one
// account.
//
// The codec is stateless about connections by design (section 11.3). Everything
// here is the state it deliberately does not keep.
package relay

import (
	"bytes"
	"fmt"

	"github.com/Vex-Foundation/vex/bridge/internal/front/credit"
	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
)

// Wire is the accepted handle. On Windows it is a go-winio MESSAGE-MODE pipe
// connection, which is the only shape whose CloseWrite is a real half-close;
// in tests it is a unix socketpair, which has the same three properties this
// interface needs and nothing else.
type Wire interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	// CloseWrite half-closes: the peer sees EOF, the readable side stays open.
	// Protocol section 7.1 is the contract, and endpoint contract 3.2 is why:
	// "A peer that half-closes is saying 'no more requests', not 'no more
	// answers'".
	CloseWrite() error
	Close() error
}

// State is the connection's position in protocol section 12.1.
//
// THERE IS NO `ended` STATE, and that is deliberate. Half-close is TWO
// INDEPENDENT LATCHES, ReadEnded and WriteEnded, because the two directions end
// independently and a single `ended` state would let one of them close the
// other. `ended` remains the NAME the structural log uses, and LogName derives
// it from the latches.
type State uint8

const (
	// StateAccepted is a handle Accept just returned. The raw handle count has
	// already risen (section 8.1). It may do nothing but have OPEN queued, or
	// be closed immediately as the 22nd.
	StateAccepted State = iota + 1
	// StateOpenSent is OPEN written on plane 4. The front READS NOTHING.
	StateOpenSent
	// StateAdmitted is an ADMIT whose epoch was current.
	StateAdmitted
	// StateReading is the steady state: read to the credit bound, stop at it,
	// resume on RESUME.
	StateReading
	// StateRefused is REFUSE, or the handshake deadline expiring. Main's exact
	// bytes are written once and the handle closes. It NEVER reads.
	StateRefused
	// StateClosed is a PHYSICALLY closed handle. The raw count has fallen.
	StateClosed
)

var stateNames = map[State]string{
	StateAccepted: "accepted", StateOpenSent: "open-sent", StateAdmitted: "admitted",
	StateReading: "reading", StateRefused: "refused", StateClosed: "closed",
}

// LogName is the name this state carries in the structural log. It reports
// `ended` for a live connection with either half-close latch set, which is the
// section 12.1 name, without that name ever being a state of its own.
func (c *Conn) LogName() string {
	if c.state != StateClosed && c.state != StateRefused && (c.readEnded || c.writeEnded) {
		return "ended"
	}
	return stateNames[c.state]
}

// Fault is a broken per-connection invariant of section 12.3 that this package
// detects itself. Flow-control faults come back as *credit.Violation, with the
// same frozen names.
type Fault struct {
	Name   string
	Detail string
}

func (f *Fault) Error() string { return fmt.Sprintf("relay: %s: %s", f.Name, f.Detail) }

const (
	// NameDataAfterEnd is a DATA or END arriving for a connection already ended
	// in that direction (section 12.3).
	NameDataAfterEnd = "data_after_end"
	// NameInternalInvariant is an invariant the front broke itself, reported as
	// ERROR code 9.
	NameInternalInvariant = "internal_invariant"
)

// maxPendingDown bounds the per-connection plane 5 write queue by ITEM COUNT as
// well as by bytes.
//
// The byte bound is the real one - main may never have more than
// credit.WindowBytes unacknowledged - but a main that sent 65536 one-byte DATA
// frames would satisfy it with 65536 queue entries. The count bound makes the
// queue's memory a stated number instead of a consequence, and exceeding it is
// an internal invariant rather than a peer fault, because the byte window
// already refused everything a correct main could do.
const maxPendingDown = int(credit.WindowBytes) + 1

// maxPendingUp bounds the per-connection plane 6 queue. The read gate allows
// ONE outstanding read per connection, so the queue holds at most that chunk
// plus the END that follows the peer's FIN.
const maxPendingUp = 2

// downItem is one thing to do to the peer, in order. Exactly one of Payload and
// End is set: END is on the DATA plane precisely so it cannot overtake the last
// chunk it terminates (section 7.1).
type downItem struct {
	// Sequence is the plane 5 sequence this item arrived on. END costs no
	// window and is never acknowledged, so its sequence is recorded only for
	// the log.
	Sequence uint64
	Payload  []byte
	End      bool
}

// upItem is one frame waiting for a turn on plane 6.
type upItem struct {
	Payload []byte
	End     bool
}

// Conn is one accepted handle and everything the front knows about it.
//
// It is owned by the supervisor goroutine and carries no lock: every method is
// called from that one goroutine, and the I/O it implies happens on goroutines
// that report back through the supervisor's channels.
type Conn struct {
	ID   uint32
	wire Wire

	state      State
	readEnded  bool
	writeEnded bool
	paused     bool

	grant  credit.Grant
	window credit.Window

	// readInFlight is the ONE outstanding read this connection may have. It is
	// what keeps the front's own buffering at one chunk per connection, well
	// inside the outstanding credit the section 11.1 bound talks about.
	readInFlight bool
	// writeInFlight is the ONE outstanding peer write, which is what keeps a
	// connection's chunks ordered without a lock.
	writeInFlight bool

	pendingDown []downItem
	pendingUp   []upItem

	// handshakeSeen latches the FIRST NEWLINE of the peer's first line. The
	// front finds a byte and interprets nothing: no JSON, no project id, not
	// one project byte (section 9).
	handshakeSeen bool

	// throughDataSeq is the plane 6 sequence of the LAST DATA or END delivered
	// for this connection, or 0. PEER_CLOSED carries it so main can delay the
	// close edge until its plane 6 decoder has caught up (section 6.3).
	throughDataSeq uint64
}

// New registers an accepted handle in the state Accept leaves it in.
func New(id uint32, wire Wire) *Conn {
	return &Conn{ID: id, wire: wire, state: StateAccepted}
}

// Wire is the handle, for the supervisor's I/O goroutines and for close.
func (c *Conn) Wire() Wire { return c.wire }

// State is the connection's section 12.1 state.
func (c *Conn) State() State { return c.state }

// ReadEnded reports the peer's FIN latch. It is INDEPENDENT of WriteEnded.
func (c *Conn) ReadEnded() bool { return c.readEnded }

// WriteEnded reports the main-side half-close latch.
func (c *Conn) WriteEnded() bool { return c.writeEnded }

// Paused reports whether main has stopped this connection's reads.
func (c *Conn) Paused() bool { return c.paused }

// HandshakeSeen reports whether the peer's first line has completed.
func (c *Conn) HandshakeSeen() bool { return c.handshakeSeen }

// ThroughDataSequence is what PEER_CLOSED must carry.
func (c *Conn) ThroughDataSequence() uint64 { return c.throughDataSeq }

// OutstandingCredit is the plane 6 credit this connection may still spend.
func (c *Conn) OutstandingCredit() uint32 { return c.grant.Outstanding() }

// UnacknowledgedBytes is main's plane 5 window usage for this connection.
func (c *Conn) UnacknowledgedBytes() uint32 { return c.window.Outstanding() }

// AckThrough is the cumulative acknowledgement WRITE_DONE would carry now.
func (c *Conn) AckThrough() uint64 { return c.window.AckThrough() }

// OpenSent records the OPEN frame reaching plane 4.
func (c *Conn) OpenSent() {
	if c.state == StateAccepted {
		c.state = StateOpenSent
	}
}

// Admit begins reading this connection. The EPOCH CHECK IS NOT HERE: it belongs
// to the supervisor, which owns the one admission epoch for the whole front,
// and a stale ADMIT must move NOTHING - not even a state this type could set.
func (c *Conn) Admit() {
	if c.state == StateOpenSent || c.state == StateAccepted {
		c.state = StateAdmitted
	}
}

// Admitted reports whether main has admitted this connection.
func (c *Conn) Admitted() bool {
	return c.state == StateAdmitted || c.state == StateReading
}

// Refuse moves the connection to the write-once-then-close path. It NEVER
// reads, so any read gate is closed from here on.
func (c *Conn) Refuse() { c.state = StateRefused }

// Pause stops this connection's reads IMMEDIATELY: no further read is issued
// once the outstanding one returns. Main stops replenishing credit at the same
// moment, which is the other half of section 11.1's rule - withholding credit
// alone would leave an already-granted 64 KiB still arriving.
func (c *Conn) Pause() { c.paused = true }

// Resume restores reading. Replenishment resumes on main's side.
func (c *Conn) Resume() { c.paused = false }

// GrantCredit applies a CREDIT frame. A grant past the window is
// duplicate_credit and FATAL.
func (c *Conn) GrantCredit(bytes uint32) error { return c.grant.Add(bytes) }

// ReadBudget is how many bytes the supervisor may ask the operating system for
// right now. Zero means DO NOT READ, and it is the only gate: refused, paused,
// ended, unadmitted, out of credit, or already reading.
func (c *Conn) ReadBudget() int {
	if c.readInFlight || c.paused || c.readEnded {
		return 0
	}
	if c.state != StateAdmitted && c.state != StateReading {
		return 0
	}
	return int(c.grant.ReadBudget())
}

// ReadIssued records the read the supervisor just started.
func (c *Conn) ReadIssued() {
	c.readInFlight = true
	if c.state == StateAdmitted {
		c.state = StateReading
	}
}

// AcceptRead takes the bytes one read returned and queues them for plane 6.
//
// The buffer is handed over WHOLE and the caller must not keep it: the decoder
// on main's side has the same rule, and a shared buffer is how a relay
// eventually delivers one connection's bytes to another.
//
// It reports whether this chunk completed the peer's FIRST LINE, which is the
// only interpretation the front ever performs on peer bytes: it finds a newline
// byte and understands nothing about what precedes it.
func (c *Conn) AcceptRead(chunk []byte) (handshakeCompleted bool, err error) {
	c.readInFlight = false
	if len(chunk) == 0 {
		return false, &Fault{Name: NameInternalInvariant, Detail: "a read of no bytes was queued"}
	}
	if c.readEnded {
		return false, &Fault{Name: NameDataAfterEnd, Detail: "bytes read after the peer's FIN"}
	}
	if len(c.pendingUp) >= maxPendingUp {
		return false, &Fault{
			Name:   NameInternalInvariant,
			Detail: fmt.Sprintf("plane 6 queue for connection %d already holds %d items", c.ID, len(c.pendingUp)),
		}
	}
	c.pendingUp = append(c.pendingUp, upItem{Payload: chunk})
	if !c.handshakeSeen && bytes.IndexByte(chunk, '\n') >= 0 {
		c.handshakeSeen = true
		return true, nil
	}
	return false, nil
}

// PeerEnded latches the peer's FIN and queues the END that carries it upward.
//
// The WRITABLE SIDE IS PRESERVED. That is section 7.1's half-open contract and
// endpoint contract 3.2's: ending the writable side on peer FIN "breaks every
// `claude -p` style session, silently".
func (c *Conn) PeerEnded() error {
	c.readInFlight = false
	if c.readEnded {
		return &Fault{Name: NameDataAfterEnd, Detail: "a second peer FIN on the same connection"}
	}
	if len(c.pendingUp) >= maxPendingUp {
		return &Fault{
			Name:   NameInternalInvariant,
			Detail: fmt.Sprintf("plane 6 queue for connection %d already holds %d items", c.ID, len(c.pendingUp)),
		}
	}
	c.readEnded = true
	c.pendingUp = append(c.pendingUp, upItem{End: true})
	return nil
}

// ReadFailed clears the outstanding read after an I/O failure. The connection's
// end is the supervisor's decision, because only it owns the handle.
func (c *Conn) ReadFailed() { c.readInFlight = false }

// HasUpward reports whether this connection wants a turn on plane 6.
func (c *Conn) HasUpward() bool { return len(c.pendingUp) > 0 }

// TakeUpward removes this connection's next plane 6 frame and charges its
// credit. It is called once per round-robin turn, which is what section 11.1's
// fairness rule means: at most ONE chunk per connection per turn, so one busy
// connection cannot starve twenty others on a shared plane.
//
// sequence is the plane 6 sequence the supervisor assigned; recording it here
// keeps ThroughDataSequence and the wire from ever disagreeing.
func (c *Conn) TakeUpward(sequence uint64) (payload []byte, end bool, err error) {
	if len(c.pendingUp) == 0 {
		return nil, false, &Fault{Name: NameInternalInvariant, Detail: "no plane 6 frame to take"}
	}
	item := c.pendingUp[0]
	c.pendingUp = c.pendingUp[1:]
	if len(c.pendingUp) == 0 {
		c.pendingUp = nil
	}
	if !item.End {
		// END costs no credit: it carries no payload, and a half-close that
		// could be blocked by an exhausted window would deadlock main, which
		// only grants credit after it sees the EOF (section 11.1).
		if err := c.grant.Spend(uint32(len(item.Payload))); err != nil {
			return nil, false, err
		}
	}
	c.throughDataSeq = sequence
	return item.Payload, item.End, nil
}

// QueueDown records a plane 5 DATA chunk for this connection.
//
// The window is charged HERE, when the frame is decoded, not when the pipe
// write completes: section 11.2's bound is on what main has put on the wire,
// and it must hold at every instant including inside one logical write.
func (c *Conn) QueueDown(sequence uint64, payload []byte) error {
	if c.writeEnded {
		return &Fault{
			Name:   NameDataAfterEnd,
			Detail: fmt.Sprintf("DATA on plane 5 sequence %d after END for connection %d", sequence, c.ID),
		}
	}
	if len(c.pendingDown) >= maxPendingDown {
		return &Fault{
			Name:   NameInternalInvariant,
			Detail: fmt.Sprintf("plane 5 queue for connection %d already holds %d items", c.ID, len(c.pendingDown)),
		}
	}
	if err := c.window.Reserve(sequence, uint32(len(payload))); err != nil {
		return err
	}
	c.pendingDown = append(c.pendingDown, downItem{Sequence: sequence, Payload: payload})
	return nil
}

// QueueDownEnd records main's END: close the WRITABLE side of the handle, leave
// the readable side open. It joins the SAME queue as the chunks so it cannot
// overtake them.
func (c *Conn) QueueDownEnd(sequence uint64) error {
	if c.writeEnded {
		return &Fault{
			Name:   NameDataAfterEnd,
			Detail: fmt.Sprintf("a second END on plane 5 sequence %d for connection %d", sequence, c.ID),
		}
	}
	if len(c.pendingDown) >= maxPendingDown {
		return &Fault{
			Name:   NameInternalInvariant,
			Detail: fmt.Sprintf("plane 5 queue for connection %d already holds %d items", c.ID, len(c.pendingDown)),
		}
	}
	// The latch closes at QUEUE time, not at write time: a second END or a DATA
	// arriving behind this one is data_after_end whether or not the handle has
	// caught up yet.
	c.writeEnded = true
	c.pendingDown = append(c.pendingDown, downItem{Sequence: sequence, End: true})
	return nil
}

// PendingDown is how many plane 5 items are queued for the peer.
func (c *Conn) PendingDown() int { return len(c.pendingDown) }

// PendingUp is how many plane 6 frames are waiting for a turn.
func (c *Conn) PendingUp() int { return len(c.pendingUp) }

// WriteInFlight reports whether a peer write or half-close is outstanding.
func (c *Conn) WriteInFlight() bool { return c.writeInFlight }

// ReadInFlight reports whether a peer read is outstanding.
func (c *Conn) ReadInFlight() bool { return c.readInFlight }

// NextDown hands the supervisor the next thing to do to the peer, or reports
// that there is nothing to do or a write is already in flight.
func (c *Conn) NextDown() (sequence uint64, payload []byte, end bool, ok bool) {
	if c.writeInFlight || len(c.pendingDown) == 0 || c.state == StateClosed {
		return 0, nil, false, false
	}
	item := c.pendingDown[0]
	c.pendingDown = c.pendingDown[1:]
	if len(c.pendingDown) == 0 {
		c.pendingDown = nil
	}
	c.writeInFlight = true
	return item.Sequence, item.Payload, item.End, true
}

// WriteCompleted records that the pipe write for sequence RETURNED, and reports
// the cumulative acknowledgement WRITE_DONE may now carry.
//
// The acknowledgement is emitted only after the Go pipe write returns, never
// when the front accepts a chunk from plane 5: "running it on hand-off to the
// relay would make the outbound queue believe a frame is delivered while it
// sits in somebody else's buffer, and the queue's bound would stop bounding
// anything real" (section 6.4).
func (c *Conn) WriteCompleted(sequence uint64) (ackThrough uint64, err error) {
	c.writeInFlight = false
	if err := c.window.Complete(sequence); err != nil {
		return 0, err
	}
	return c.window.AckThrough(), nil
}

// EndCompleted records that CloseWrite returned. END costs no window and is
// never acknowledged (section 6.4).
func (c *Conn) EndCompleted() { c.writeInFlight = false }

// WriteFailed clears the in-flight write after an I/O failure.
func (c *Conn) WriteFailed() { c.writeInFlight = false }

// MarkClosed records the PHYSICAL close. The supervisor calls it after
// Wire().Close() has RETURNED, because section 8.1 decrements the raw handle
// count only then: decrementing when the front DECIDES to close would let it
// admit a replacement against a slot that still exists in the operating system.
func (c *Conn) MarkClosed() {
	c.state = StateClosed
	c.pendingDown = nil
	c.pendingUp = nil
	c.readInFlight = false
	c.writeInFlight = false
}

// PeerClosedFrame is the frame that ends this connection on plane 4.
func (c *Conn) PeerClosedFrame(reason frames.PeerClosedReason) frames.PeerClosed {
	return frames.PeerClosed{Reason: reason, ThroughDataSequence: c.throughDataSeq}
}
