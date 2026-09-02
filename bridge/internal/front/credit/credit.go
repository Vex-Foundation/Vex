// Package credit owns the two per-connection flow-control accounts of protocol
// section 11, and nothing else.
//
// It is PURE and platform-independent on purpose: the arithmetic that decides
// whether main broke a window is the part a Windows-only test could never
// exercise often enough, and it is the part whose failure is fatal.
//
//	Grant  - front -> main, plane 6. Main GRANTS with CREDIT, the front SPENDS
//	         it with DATA payload bytes, and at the bound the front STOPS
//	         READING the pipe handle so the back pressure reaches the external
//	         peer through the operating system (section 11.1).
//	Window - main -> front, plane 5. Main owns the window and there is no
//	         CREDIT frame in this direction; the front's job is to detect a main
//	         that exceeded it, and to release it with the CUMULATIVE
//	         acknowledgement of section 6.4.
//
// The names below are the FROZEN structural failure names of section 12.3.
// Neither side invents one.
package credit

import "fmt"

// WindowBytes is the per-connection bound in BOTH directions: the largest
// outstanding credit the front may hold on plane 6, and the largest
// unacknowledged payload main may have written on plane 5.
//
// 65536 is deliberately half the measured 131072-byte OS pipe buffer, so one
// connection's outstanding bytes can never fill a shared data plane and block a
// second connection's chunk behind it.
const WindowBytes uint32 = 65536

// ChunkBytes is the largest DATA payload on either data plane.
const ChunkBytes uint32 = 32768

// Violation is a broken flow-control invariant. Name is the section 12.3 name,
// which is what both sides log and what a reviewer greps for.
type Violation struct {
	Name   string
	Detail string
}

func (v *Violation) Error() string { return fmt.Sprintf("credit: %s: %s", v.Name, v.Detail) }

// The frozen names of section 12.3 that this package can produce.
const (
	// NameCreditOverrun is a DATA frame that takes a connection past the credit
	// main granted it.
	NameCreditOverrun = "credit_overrun"
	// NameDuplicateCredit is a CREDIT that would take a connection's window
	// past WindowBytes outstanding bytes.
	NameDuplicateCredit = "duplicate_credit"
	// NameWriteWindowExceeded is main writing a chunk that takes a connection
	// past WindowBytes unacknowledged bytes.
	NameWriteWindowExceeded = "write_window_exceeded"
	// NameAckRegression is an acknowledgement naming a sequence at or below one
	// already acknowledged for that connection. The front is the SENDER of
	// WRITE_DONE, so it detects this against itself: a regression here would be
	// the front telling main to release a window twice.
	NameAckRegression = "ack_regression"
)

// Grant is the front -> main credit account for one connection.
//
// The zero value is a connection with no credit, which is exactly the state a
// freshly accepted connection is in: the front reads nothing until main both
// ADMITs it and grants it something to spend.
type Grant struct{ outstanding uint32 }

// Outstanding is how many payload bytes the front may still send for this
// connection. It is also the read gate: at zero the front stops reading the
// pipe handle.
func (g *Grant) Outstanding() uint32 { return g.outstanding }

// Add applies a CREDIT frame.
//
// A grant that would take the window past WindowBytes is duplicate_credit and
// is FATAL. Zero bytes is refused for the same reason DATA of length 0 is
// malformed: it conveys nothing and gives a broken sender an infinite supply of
// legal frames.
func (g *Grant) Add(bytes uint32) error {
	if bytes == 0 {
		return &Violation{Name: NameDuplicateCredit, Detail: "CREDIT granted 0 bytes"}
	}
	if bytes > WindowBytes || g.outstanding > WindowBytes-bytes {
		return &Violation{
			Name: NameDuplicateCredit,
			Detail: fmt.Sprintf("CREDIT of %d on top of %d outstanding exceeds the %d-byte window",
				bytes, g.outstanding, WindowBytes),
		}
	}
	g.outstanding += bytes
	return nil
}

// Spend charges a DATA frame's payload bytes.
//
// The front calls this at the moment it commits a chunk to plane 6, never when
// it reads one, so the account and the wire cannot disagree. Spending more than
// the outstanding credit is credit_overrun and is FATAL.
func (g *Grant) Spend(bytes uint32) error {
	if bytes == 0 {
		return &Violation{Name: NameCreditOverrun, Detail: "DATA of 0 bytes spends nothing and is malformed"}
	}
	if bytes > g.outstanding {
		return &Violation{
			Name: NameCreditOverrun,
			Detail: fmt.Sprintf("DATA of %d bytes against %d outstanding credit",
				bytes, g.outstanding),
		}
	}
	g.outstanding -= bytes
	return nil
}

// ReadBudget is the largest read the front may issue for this connection right
// now: the outstanding credit, capped at one chunk.
//
// Zero means STOP READING. It is the only gate; there is no buffer in the front
// with a comforting name standing between the credit bound and the operating
// system.
func (g *Grant) ReadBudget() uint32 {
	if g.outstanding > ChunkBytes {
		return ChunkBytes
	}
	return g.outstanding
}

// Window is the main -> front unacknowledged-bytes account for one connection.
//
// The front does not grant this window and cannot widen it. It tracks it for
// two reasons: to detect a main that exceeded it (write_window_exceeded), and
// to compute the CUMULATIVE acknowledgement that releases it (section 6.4).
type Window struct {
	outstanding uint32
	ackThrough  uint64
	reserved    []reservation
}

type reservation struct {
	sequence uint64
	bytes    uint32
}

// Outstanding is how many plane 5 payload bytes main has written for this
// connection that the front has not yet acknowledged.
func (w *Window) Outstanding() uint32 { return w.outstanding }

// AckThrough is the greatest plane 5 sequence for this connection whose pipe
// write has RETURNED. It is what WRITE_DONE carries, and it never decreases.
func (w *Window) AckThrough() uint64 { return w.ackThrough }

// Pending reports how many reserved chunks have not completed yet.
func (w *Window) Pending() int { return len(w.reserved) }

// Reserve records a DATA chunk main wrote on plane 5.
//
// It is called when the frame is DECODED, not when the pipe write finishes:
// the window bounds what main has put on the wire, and the whole point of
// section 11.2 is that the bound holds at every instant, including inside one
// logical write.
func (w *Window) Reserve(sequence uint64, bytes uint32) error {
	if bytes == 0 || bytes > ChunkBytes {
		return &Violation{
			Name:   NameWriteWindowExceeded,
			Detail: fmt.Sprintf("plane 5 DATA of %d bytes is outside 1..%d", bytes, ChunkBytes),
		}
	}
	if bytes > WindowBytes || w.outstanding > WindowBytes-bytes {
		return &Violation{
			Name: NameWriteWindowExceeded,
			Detail: fmt.Sprintf("chunk of %d bytes on top of %d unacknowledged exceeds the %d-byte window",
				bytes, w.outstanding, WindowBytes),
		}
	}
	w.outstanding += bytes
	w.reserved = append(w.reserved, reservation{sequence: sequence, bytes: bytes})
	return nil
}

// Complete records that the pipe write for the OLDEST outstanding chunk has
// RETURNED, and reports the sequence the acknowledgement may now name.
//
// Completion is in FIFO order because the front writes one chunk of a
// connection at a time; a completion out of order would mean the front lost
// track of its own writes, which is why the mismatch is reported rather than
// tolerated.
func (w *Window) Complete(sequence uint64) error {
	if len(w.reserved) == 0 {
		return &Violation{
			Name:   NameAckRegression,
			Detail: fmt.Sprintf("completion of sequence %d with nothing outstanding", sequence),
		}
	}
	head := w.reserved[0]
	if head.sequence != sequence {
		return &Violation{
			Name: NameAckRegression,
			Detail: fmt.Sprintf("completion of sequence %d while %d is the oldest outstanding chunk",
				sequence, head.sequence),
		}
	}
	if sequence <= w.ackThrough {
		return &Violation{
			Name: NameAckRegression,
			Detail: fmt.Sprintf("sequence %d is not above the acknowledged %d",
				sequence, w.ackThrough),
		}
	}
	w.reserved = w.reserved[1:]
	if len(w.reserved) == 0 {
		// Drop the backing array rather than keeping a grown one alive for the
		// life of the connection.
		w.reserved = nil
	}
	w.outstanding -= head.bytes
	w.ackThrough = sequence
	return nil
}
