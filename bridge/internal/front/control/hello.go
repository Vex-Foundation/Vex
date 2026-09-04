// Package control is the front's SUPERVISOR: the one owner of the admission
// epoch, the connection table, the four planes' sequence counters and every
// handle the accept loop produces.
//
// It implements protocol sections 4 (generation and bootstrap), 5 (control
// frames from main), 6 (control frames to main), 8 (lifecycle), 9 (handshake
// timing), 10 (malformed handling) and the front's half of 11 and 12. The frame
// codec is stateless about connections by design (section 11.3); everything it
// deliberately does not keep is kept here or in the relay package.
package control

import (
	"fmt"

	"github.com/Vex-Foundation/vex/bridge/internal/front/credit"
	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/listener"
)

// THE FROZEN EQUALITY VALUES of protocol section 5.1. The front compares each
// of these against the number HELLO carries and, on ANY difference, refuses to
// serve: it writes one structural stderr line naming the field, the value it
// received and the value it holds, and exits. It does not adapt, and it does
// not serve with the main-supplied value.
//
// That is the opposite of a version handshake and it is deliberate. Main and
// the front ship in the SAME package, built together, signed together and
// updated together - unlike the bridge, which ships on its own cadence and is
// exactly why the external contract negotiates a version at all. Two internal
// peers that disagree about chunkBytes are a packaging fault, and a front that
// quietly adapted would turn a build error into a bounds mismatch discovered
// under load.
//
// `initialAdmissionEpoch` is NOT here. It is the one dynamic field, and the
// front holds no compiled-in expectation to compare it against.
const (
	expectedProtocolVersion     = frames.ProtocolVersion
	expectedSDDLKind            = frames.SDDLKind
	expectedMaxRaw              = uint16(listener.MaxRawHandles)
	expectedCreditBytes         = credit.WindowBytes
	expectedChunkBytes          = credit.ChunkBytes
	expectedHandshakeDeadlineMs = uint32(5000)
)

// HelloMismatch is a HELLO whose frozen numbers differ from the front's.
//
// Field is a constant name from section 5.1's table, and the two values are
// numbers, so the whole thing is loggable without carrying one byte of content.
type HelloMismatch struct {
	Field string
	Got   uint64
	Want  uint64
}

func (e *HelloMismatch) Error() string {
	return fmt.Sprintf("hello: %s is %d; this front is built for %d", e.Field, e.Got, e.Want)
}

// ValidateHello runs the six frozen equality checks, in the order section 5.1's
// table lists them so a main with several wrong numbers is always told about
// the same one first.
//
// sddlKind is checked by the codec as well (a value other than 1 is the
// malformed reason `sddl_kind`), and it is checked again here because the two
// answer different questions: the codec asks whether the bytes are a legal v1
// HELLO, and this asks whether this build of the front implements the policy
// that HELLO names.
func ValidateHello(h frames.Hello) error {
	switch {
	case h.ProtocolVersion != expectedProtocolVersion:
		return &HelloMismatch{Field: "protocolVersion", Got: uint64(h.ProtocolVersion), Want: uint64(expectedProtocolVersion)}
	case h.SDDLKind != expectedSDDLKind:
		return &HelloMismatch{Field: "sddlKind", Got: uint64(h.SDDLKind), Want: uint64(expectedSDDLKind)}
	case h.MaxRaw != expectedMaxRaw:
		return &HelloMismatch{Field: "maxRaw", Got: uint64(h.MaxRaw), Want: uint64(expectedMaxRaw)}
	case h.CreditBytes != expectedCreditBytes:
		return &HelloMismatch{Field: "creditBytes", Got: uint64(h.CreditBytes), Want: uint64(expectedCreditBytes)}
	case h.ChunkBytes != expectedChunkBytes:
		return &HelloMismatch{Field: "chunkBytes", Got: uint64(h.ChunkBytes), Want: uint64(expectedChunkBytes)}
	case h.HandshakeDeadlineMs != expectedHandshakeDeadlineMs:
		return &HelloMismatch{Field: "handshakeDeadlineMs", Got: uint64(h.HandshakeDeadlineMs), Want: uint64(expectedHandshakeDeadlineMs)}
	}
	if h.PipeName == "" {
		return &HelloMismatch{Field: "pipeName", Got: 0, Want: 1}
	}
	return nil
}
