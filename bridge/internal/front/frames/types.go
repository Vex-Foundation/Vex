// Package frames is the Go half of the INTERNAL main<->front wire.
//
// Normative specification and rationale:
// `src/vex-agent/tools/tool-surface-spec/studio-mcp/pipe-front-protocol.md`.
// Golden vectors, run by this codec AND by the independent TypeScript codec in
// `src/vex-agent/mcp/pipe-front-frames.ts` from the same path with no copy:
// `src/vex-agent/tools/tool-surface-spec/studio-mcp/pipe-front-vectors.json`.
//
// The package is PURE. It encodes and decodes frames and validates the header,
// the per-plane sequence and the per-type payload layout. It does NOT track
// connections, credit, admission, END ordering or write windows: those are
// relay state with a different lifetime, a different owner and a different test
// surface (protocol section 11.3). A codec that owned them would be the relay.
package frames

import "math"

// ProtocolVersion is a MAJOR, and HELLO carries it as a frozen equality check.
// Main and the front ship in one package, so there is no compatible change.
const ProtocolVersion uint16 = 1

const (
	// Magic is 0x46584556. On the wire the bytes are 56 45 58 46, ASCII "VEXF".
	Magic uint32 = 0x46584556

	// HeaderBytes is the fixed header size, little-endian throughout.
	HeaderBytes = 28

	ControlPayloadMaxBytes = 4096
	DataPayloadMaxBytes    = 32768

	// SDDLKind is the only pipe security policy v1 defines: an owner+SYSTEM
	// protected allow-list.
	SDDLKind uint8 = 1
)

// SequenceExhausted is never emitted and never accepted. A wrap would silently
// reissue sequence 1 and hand a decoder a valid-looking replay.
const SequenceExhausted uint64 = math.MaxUint64

// Plane is one of the four framed streams on the front's inherited overlapped
// stdio. stdin, stdout and stderr carry no frames.
type Plane uint8

const (
	// PlaneControlDown is main -> front control.
	PlaneControlDown Plane = 3
	// PlaneControlUp is front -> main control.
	PlaneControlUp Plane = 4
	// PlaneDataDown is main -> front data.
	PlaneDataDown Plane = 5
	// PlaneDataUp is front -> main data.
	PlaneDataUp Plane = 6
)

// PayloadBound is the plane's maximum payload, enforced at header parse so the
// decoder's retention can never exceed HeaderBytes plus this value.
func (p Plane) PayloadBound() int {
	if p == PlaneControlDown || p == PlaneControlUp {
		return ControlPayloadMaxBytes
	}
	return DataPayloadMaxBytes
}

// RetentionBound is the most a decoder for this plane ever holds.
func (p Plane) RetentionBound() int { return HeaderBytes + p.PayloadBound() }

// Type is the frame type byte. The ranges are disjoint per direction so a frame
// in a log names its own direction without its plane.
type Type uint8

const (
	TypeHello  Type = 0x01
	TypeAdmit  Type = 0x02
	TypeRefuse Type = 0x03
	TypeCredit Type = 0x04
	TypePause  Type = 0x05
	TypeResume Type = 0x06
	TypeClose  Type = 0x07
	TypeLock   Type = 0x08
	TypeQuit   Type = 0x09
	TypePing   Type = 0x0a

	TypeHelloAck   Type = 0x41
	TypeBound      Type = 0x42
	TypeOpen       Type = 0x43
	TypeWriteDone  Type = 0x44
	TypePeerClosed Type = 0x45
	TypeLockAck    Type = 0x46
	TypeQuitAck    Type = 0x47
	TypePong       Type = 0x48
	TypeError      Type = 0x49

	TypeData Type = 0x81
	TypeEnd  Type = 0x82
)

// Name is the wire name of a type, or "" when the byte is not a defined type.
func (t Type) Name() string { return typeNames[t] }

var typeNames = map[Type]string{
	TypeHello: "HELLO", TypeAdmit: "ADMIT", TypeRefuse: "REFUSE",
	TypeCredit: "CREDIT", TypePause: "PAUSE", TypeResume: "RESUME",
	TypeClose: "CLOSE", TypeLock: "LOCK", TypeQuit: "QUIT", TypePing: "PING",
	TypeHelloAck: "HELLO_ACK", TypeBound: "BOUND", TypeOpen: "OPEN",
	TypeWriteDone: "WRITE_DONE", TypePeerClosed: "PEER_CLOSED",
	TypeLockAck: "LOCK_ACK", TypeQuitAck: "QUIT_ACK", TypePong: "PONG",
	TypeError: "ERROR",
	TypeData:  "DATA", TypeEnd: "END",
}

// carriedBy reports whether the plane carries this type at all.
func (t Type) carriedBy(plane Plane) bool {
	switch plane {
	case PlaneControlDown:
		return t >= TypeHello && t <= TypePing
	case PlaneControlUp:
		return t >= TypeHelloAck && t <= TypeError
	default:
		return t == TypeData || t == TypeEnd
	}
}

// namesConnection reports whether the type MUST carry a non-zero connection id.
// The complement MUST carry zero.
func (t Type) namesConnection() bool {
	switch t {
	case TypeAdmit, TypeRefuse, TypeCredit, TypePause, TypeResume, TypeClose,
		TypeOpen, TypeWriteDone, TypePeerClosed, TypeData, TypeEnd:
		return true
	default:
		return false
	}
}

// isBootstrap reports whether the type belongs to the generation bootstrap.
// Only HELLO and HELLO_ACK carry header generation 0, and only while the reader
// has not adopted a generation yet.
func (t Type) isBootstrap() bool { return t == TypeHello || t == TypeHelloAck }

// PeerClosedReason is a STRUCTURAL cause. The front never authors a domain
// cause; main maps this to its own latched lock/vex_quit, or to disconnect.
type PeerClosedReason uint8

const (
	PeerClosedPeerEOF        PeerClosedReason = 1
	PeerClosedIOError        PeerClosedReason = 2
	PeerClosedCommandedClose PeerClosedReason = 3
	peerClosedHighestDefined                  = PeerClosedCommandedClose
)

// ErrorCode is a front-authored STRUCTURAL failure code from a CLOSED set
// (protocol section 6.5). Main treats a code outside the set as a malformed
// frame rather than logging a number nobody can read: an open set would make
// ERROR the one frame whose meaning the front could invent.
type ErrorCode uint16

const (
	// ErrorMalformedMainFrame reports a frame from main that did not parse.
	ErrorMalformedMainFrame ErrorCode = 1
	// ErrorPlaneReadFailed reports a failed read on one of the four planes.
	ErrorPlaneReadFailed ErrorCode = 2
	// ErrorPlaneWriteFailed reports a failed write on one of the four planes.
	ErrorPlaneWriteFailed ErrorCode = 3
	// ErrorListenerBindFailed reports a named pipe that could not be created.
	ErrorListenerBindFailed ErrorCode = 4
	// ErrorSDDLReadbackMismatch reports a security descriptor read back from
	// the handle that is not the one that was asked for.
	ErrorSDDLReadbackMismatch ErrorCode = 5
	// ErrorCreditViolation reports a relay-level credit or window violation.
	ErrorCreditViolation ErrorCode = 6
	// ErrorAdmissionEpochExhausted reports the u32 admission epoch running out.
	// Main then closes admission PERMANENTLY for the life of the process; the
	// remedy is a full application restart, never a front restart, which would
	// come up at the same exhausted epoch.
	ErrorAdmissionEpochExhausted ErrorCode = 7
	// ErrorConnectionIDsExhausted reports the connection id space running out
	// for this generation.
	ErrorConnectionIDsExhausted ErrorCode = 8
	// ErrorInternalInvariant reports an invariant the front broke itself.
	ErrorInternalInvariant ErrorCode = 9
)

var errorCodeNames = map[ErrorCode]string{
	ErrorMalformedMainFrame:      "malformed_main_frame",
	ErrorPlaneReadFailed:         "plane_read_failed",
	ErrorPlaneWriteFailed:        "plane_write_failed",
	ErrorListenerBindFailed:      "listener_bind_failed",
	ErrorSDDLReadbackMismatch:    "sddl_readback_mismatch",
	ErrorCreditViolation:         "credit_violation",
	ErrorAdmissionEpochExhausted: "admission_epoch_exhausted",
	ErrorConnectionIDsExhausted:  "connection_ids_exhausted",
	ErrorInternalInvariant:       "internal_invariant",
}

// Name is the wire name of an error code, or "" when the value is undefined.
func (c ErrorCode) Name() string { return errorCodeNames[c] }

// defined reports whether the code belongs to the frozen closed set.
func (c ErrorCode) defined() bool { return errorCodeNames[c] != "" }

// BoundFlags is the bitfield of pipe properties the front VERIFIED by runtime
// readback. A flag the front requested and could not confirm is reported 0.
const (
	BoundFlagRejectRemote  uint8 = 0x01
	BoundFlagFirstInstance uint8 = 0x02
	BoundFlagMessageMode   uint8 = 0x04

	boundFlagsMask uint8 = BoundFlagRejectRemote | BoundFlagFirstInstance | BoundFlagMessageMode
)

// Payload is one frame's body. Every implementation is a value type in this
// package; there is no open extension point, because an unknown type is a
// malformed frame and not a forward-compatible one.
type Payload interface {
	frameType() Type
}

// Hello opens the wire. Every number in it is a frozen equality check the front
// refuses to adapt to (protocol section 5.1).
type Hello struct {
	ProtocolVersion     uint16
	SDDLKind            uint8
	MaxRaw              uint16
	CreditBytes         uint32
	ChunkBytes          uint32
	HandshakeDeadlineMs uint32
	// InitialAdmissionEpoch is the epoch the front must START at. It is the one
	// number in HELLO that is DYNAMIC rather than a frozen equality check:
	// after a lock/unlock cycle main's epoch is non-zero, and a front that
	// assumed 0 would reject every valid ADMIT of its first life.
	InitialAdmissionEpoch uint32
	PipeName              string
	// TimeoutRefusalBytes is main's exact refusal line, newline included, for a
	// handshake that misses the deadline. The front writes it verbatim.
	TimeoutRefusalBytes string
}

// Admit begins reading a connection, but only when the epoch is current.
type Admit struct{ AdmissionEpoch uint32 }

// Refuse writes main's exact bytes to the peer and closes WITHOUT READING.
type Refuse struct{ Bytes string }

// Credit grants front -> main data allowance for one connection.
type Credit struct{ Bytes uint32 }

// Pause stops reading a connection. Credit replenishment stops with it.
type Pause struct{}

// Resume restores reading and replenishment together.
type Resume struct{}

// Close tears one connection down abruptly.
type Close struct{}

// Lock raises the admission epoch. The front processes it before any queued
// frame, and every ADMIT still queued names the old epoch and is purged.
type Lock struct{ AdmissionEpoch uint32 }

// Quit carries what REMAINS of main's one absolute 5000 ms budget.
type Quit struct{ DeadlineMs uint32 }

// Ping carries a nonce PONG echoes.
type Ping struct{ Nonce uint64 }

// HelloAck answers HELLO. Its header generation is still the bootstrap 0 while
// AnnouncedGeneration carries the fresh one, which is why the field is named
// apart from the frame's own Generation.
type HelloAck struct {
	ProtocolVersion     uint16
	AnnouncedGeneration uint32
	// Pid is a CONSISTENCY check against the spawned child's pid, never
	// authentication.
	Pid          uint32
	FrontVersion string
	BuildHash    string
}

// Bound reports the pipe the front serves and the flags it VERIFIED by runtime
// readback, never the ones it merely requested.
type Bound struct {
	FlagsApplied uint8
	PipeName     string
}

// Open announces an accepted connection the front has read nothing from.
type Open struct{}

// WriteDone is a CUMULATIVE completion acknowledgement for one connection:
// AckThroughSequence is the greatest plane 5 sequence whose pipe write has
// RETURNED. It releases every window byte up to and including that sequence,
// the front may coalesce several completed chunks into one, and the seam's
// write callback settles only when the acknowledgement covers a logical write's
// FINAL sequence. It is emitted after the Go pipe write returns, never on
// hand-off.
type WriteDone struct{ AckThroughSequence uint64 }

// PeerClosed ends a connection. ThroughDataSequence is the last upstream data
// sequence delivered for it, and main delays the close edge until it has
// decoded through that sequence.
type PeerClosed struct {
	Reason              PeerClosedReason
	ThroughDataSequence uint64
}

// LockAck answers LOCK with the number of handles actually closed.
type LockAck struct {
	AdmissionEpoch uint32
	ClosedCount    uint32
}

// QuitAck answers QUIT.
type QuitAck struct{}

// Pong echoes a PING nonce.
type Pong struct{ Nonce uint64 }

// ErrorReport is a structural counter for main's log. It carries no string:
// peer bytes, provider payloads and paths never travel in it.
type ErrorReport struct {
	Code  ErrorCode
	Count uint32
}

// Data carries 1 to ChunkBytes OPAQUE bytes. Zero is malformed.
type Data struct{ Payload []byte }

// End is the ordered graceful half-close marker. It travels on the DATA plane
// so it cannot overtake the last chunk.
type End struct{}

func (Hello) frameType() Type       { return TypeHello }
func (Admit) frameType() Type       { return TypeAdmit }
func (Refuse) frameType() Type      { return TypeRefuse }
func (Credit) frameType() Type      { return TypeCredit }
func (Pause) frameType() Type       { return TypePause }
func (Resume) frameType() Type      { return TypeResume }
func (Close) frameType() Type       { return TypeClose }
func (Lock) frameType() Type        { return TypeLock }
func (Quit) frameType() Type        { return TypeQuit }
func (Ping) frameType() Type        { return TypePing }
func (HelloAck) frameType() Type    { return TypeHelloAck }
func (Bound) frameType() Type       { return TypeBound }
func (Open) frameType() Type        { return TypeOpen }
func (WriteDone) frameType() Type   { return TypeWriteDone }
func (PeerClosed) frameType() Type  { return TypePeerClosed }
func (LockAck) frameType() Type     { return TypeLockAck }
func (QuitAck) frameType() Type     { return TypeQuitAck }
func (Pong) frameType() Type        { return TypePong }
func (ErrorReport) frameType() Type { return TypeError }
func (Data) frameType() Type        { return TypeData }
func (End) frameType() Type         { return TypeEnd }

// Frame is one decoded or encodable frame. Plane is context, not bytes: it
// decides the payload bound and which types are legal.
type Frame struct {
	Plane      Plane
	Generation uint32
	Connection uint32
	Sequence   uint64
	Payload    Payload
}

// Type is the frame's wire type byte.
func (f Frame) Type() Type { return f.Payload.frameType() }
