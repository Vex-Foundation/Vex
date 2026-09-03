package frames

import (
	"encoding/binary"
	"fmt"
	"unicode/utf8"
)

// Reason names why a frame is malformed. The vocabulary is identical in the
// TypeScript codec and in the golden fixture, because it travels into a
// structural log an operator reads.
type Reason string

const (
	ReasonBadMagic              Reason = "bad_magic"
	ReasonFlagsSet              Reason = "flags_set"
	ReasonReservedSet           Reason = "reserved_set"
	ReasonUnknownType           Reason = "unknown_type"
	ReasonTypeNotOnPlane        Reason = "type_not_on_plane"
	ReasonBadGeneration         Reason = "bad_generation"
	ReasonSequenceExhausted     Reason = "sequence_exhausted"
	ReasonSequenceGap           Reason = "sequence_gap"
	ReasonLengthOverBound       Reason = "length_over_bound"
	ReasonConnectionZero        Reason = "connection_zero"
	ReasonConnectionNotZero     Reason = "connection_not_zero"
	ReasonEmptyData             Reason = "empty_data"
	ReasonPayloadLengthMismatch Reason = "payload_length_mismatch"
	ReasonStringOverPayload     Reason = "string_over_payload"
	ReasonInvalidUTF8           Reason = "invalid_utf8"
	ReasonGenerationZero        Reason = "generation_zero"
	ReasonSDDLKind              Reason = "sddl_kind"
	ReasonPeerClosedReason      Reason = "peer_closed_reason"
	ReasonBoundFlagsReserved    Reason = "bound_flags_reserved"
	ReasonErrorCode             Reason = "error_code"
)

// StateError is a decoder used outside its contract - adopting a generation
// twice, or adopting the bootstrap 0. It is always a bug in this process, never
// a wire condition, which is why it is separate from MalformedError.
type StateError struct {
	Reason string
	Detail string
}

func (e *StateError) Error() string {
	return fmt.Sprintf("frames: decoder refused (%s): %s", e.Reason, e.Detail)
}

// MalformedError is what the structural log records. The PAYLOAD is
// deliberately absent: it is peer content, and protocol section 10 permits the
// plane, the type, the length, the sequence and the reason.
type MalformedError struct {
	Reason     Reason
	Plane      Plane
	Type       uint8
	Connection uint32
	Sequence   uint64
	Length     uint32
}

func (e *MalformedError) Error() string {
	return fmt.Sprintf(
		"frames: malformed (%s) on plane %d: type=0x%02x connection=%d sequence=%d length=%d",
		e.Reason, e.Plane, e.Type, e.Connection, e.Sequence, e.Length)
}

type header struct {
	magic      uint32
	generation uint32
	connection uint32
	sequence   uint64
	frameType  uint8
	flags      uint8
	reserved   uint16
	length     uint32
}

func parseHeader(b []byte) header {
	return header{
		magic:      binary.LittleEndian.Uint32(b[0:]),
		generation: binary.LittleEndian.Uint32(b[4:]),
		connection: binary.LittleEndian.Uint32(b[8:]),
		sequence:   binary.LittleEndian.Uint64(b[12:]),
		frameType:  b[20],
		flags:      b[21],
		reserved:   binary.LittleEndian.Uint16(b[22:]),
		length:     binary.LittleEndian.Uint32(b[24:]),
	}
}

// Decoder decodes ONE plane incrementally, in STAGES.
//
// Bytes may arrive in any chunking, including one byte at a time. The caller's
// chunk is consumed BY OFFSET and never appended to a buffer of the decoder's
// own: at most the 28 header bytes are staged, the header is validated in full
// - the plane's payload bound included - and only then is a payload buffer of
// exactly the DECLARED length allocated. So Plane.RetentionBound() bounds this
// decoder's own buffers at every moment DURING a Push, not merely after one
// returns, which PeakRetainedBytes reports.
//
// A malformed frame is TERMINAL, matching protocol section 10: the position in
// the stream is unknown after a framing fault, so the decoder latches the
// failure, drops its buffers, and returns no frames and that same error from
// every later Push. The caller kills the front (main's side) or exits (the
// front's side); there is no resynchronisation to offer.
type Decoder struct {
	plane      Plane
	bound      int
	generation uint32
	adopted    bool
	expected   uint64
	// headerStage is the staging area for one header, allocated once, never grown.
	headerStage  [HeaderBytes]byte
	headerFilled int
	// staged is the validated header whose payload is still arriving.
	staged        *header
	payload       []byte
	payloadFilled int
	peak          int
	latched       *MalformedError
}

// NewDecoder starts a decoder on one plane. Pass generation 0 while the
// bootstrap pair is still expected, and sequence 0 for the default of 1.
func NewDecoder(plane Plane, generation uint32, sequence uint64) *Decoder {
	if sequence == 0 {
		sequence = 1
	}
	return &Decoder{
		plane:      plane,
		bound:      plane.PayloadBound(),
		generation: generation,
		// A decoder handed a non-zero generation is already past the bootstrap,
		// so it has spent its one adoption.
		adopted:  generation != 0,
		expected: sequence,
		peak:     HeaderBytes,
	}
}

// Failure is the malformed frame that ended this decoder, or nil while it lives.
func (d *Decoder) Failure() *MalformedError { return d.latched }

// RetainedBytes is the incomplete frame currently held, never above the bound.
func (d *Decoder) RetainedBytes() int {
	if d.staged == nil {
		return d.headerFilled
	}
	return HeaderBytes + d.payloadFilled
}

// PeakRetainedBytes is the greatest total capacity this decoder's own buffers
// have ever had: the 28-byte header stage plus the largest payload buffer it
// allocated. It is the number the retention guarantee is measured against,
// because it records the PEAK during a Push rather than what happens to be left
// after one.
func (d *Decoder) PeakRetainedBytes() int { return d.peak }

// ExpectedSequence is the sequence the next frame must carry.
func (d *Decoder) ExpectedSequence() uint64 { return d.expected }

// AdoptGeneration takes the generation HELLO_ACK announced. A plane 4 reader
// does not need it - Push adopts from HELLO_ACK itself - but the readers of
// planes 3, 5 and 6 are told by their owner.
//
// ONE-SHOT and NON-ZERO. A second adoption would be the very re-pointing that
// protocol section 4 forbids, and adopting 0 would put a live reader back into
// the bootstrap where a stale front's frames parse again. Both are programming
// errors in the relay, not wire conditions, so both return a *StateError and
// leave the decoder untouched.
func (d *Decoder) AdoptGeneration(generation uint32) error {
	if generation == 0 {
		return &StateError{
			Reason: "adopt_generation_zero",
			Detail: "0 is the bootstrap generation and can never be adopted",
		}
	}
	if d.adopted {
		return &StateError{
			Reason: "adopt_generation_twice",
			Detail: fmt.Sprintf("this decoder already reads generation %d", d.generation),
		}
	}
	d.adopted = true
	d.generation = generation
	return nil
}

// Push feeds bytes and returns every frame that completed. On a malformed frame
// it returns the frames decoded BEFORE the fault plus a *MalformedError, and
// the decoder is finished.
func (d *Decoder) Push(chunk []byte) ([]Frame, error) {
	if d.latched != nil || len(chunk) == 0 {
		return nil, d.latched
	}

	var out []Frame
	offset := 0
	for {
		if d.staged == nil {
			if offset >= len(chunk) {
				return out, nil
			}
			take := HeaderBytes - d.headerFilled
			if available := len(chunk) - offset; take > available {
				take = available
			}
			copy(d.headerStage[d.headerFilled:], chunk[offset:offset+take])
			d.headerFilled += take
			offset += take
			if d.headerFilled < HeaderBytes {
				return out, nil
			}
			head := parseHeader(d.headerStage[:])
			if reason, bad := d.validateHeader(head); bad {
				return out, d.fail(reason, head)
			}
			// The bound is enforced above, so this allocation is bounded by the
			// plane, never by what the sender claimed.
			d.headerFilled = 0
			d.staged = &head
			d.payload = make([]byte, head.length)
			d.payloadFilled = 0
			if grown := HeaderBytes + int(head.length); grown > d.peak {
				d.peak = grown
			}
			continue
		}

		head := *d.staged
		if d.payloadFilled < int(head.length) {
			if offset >= len(chunk) {
				return out, nil
			}
			take := int(head.length) - d.payloadFilled
			if available := len(chunk) - offset; take > available {
				take = available
			}
			copy(d.payload[d.payloadFilled:], chunk[offset:offset+take])
			d.payloadFilled += take
			offset += take
			if d.payloadFilled < int(head.length) {
				return out, nil
			}
		}

		payload, reason := decodeBody(Type(head.frameType), d.payload)
		if payload == nil {
			return out, d.fail(reason, head)
		}
		// The payload buffer is handed to the frame; the decoder keeps no
		// reference, so a DATA frame costs one allocation rather than two.
		d.staged = nil
		d.payload = nil
		d.payloadFilled = 0
		d.expected = head.sequence + 1
		if ack, ok := payload.(HelloAck); ok {
			// A plane 4 reader LEARNS the generation here (protocol section 4).
			// Either way the one adoption is spent.
			d.generation = ack.AnnouncedGeneration
			d.adopted = true
		}
		out = append(out, Frame{
			Plane:      d.plane,
			Generation: head.generation,
			Connection: head.connection,
			Sequence:   head.sequence,
			Payload:    payload,
		})
	}
}

// validateHeader runs protocol section 10.1's header phase, in its frozen order.
func (d *Decoder) validateHeader(head header) (Reason, bool) {
	if head.magic != Magic {
		return ReasonBadMagic, true
	}
	if head.flags != 0 {
		return ReasonFlagsSet, true
	}
	if head.reserved != 0 {
		return ReasonReservedSet, true
	}
	frameType := Type(head.frameType)
	if frameType.Name() == "" {
		return ReasonUnknownType, true
	}
	if !frameType.carriedBy(d.plane) {
		return ReasonTypeNotOnPlane, true
	}
	// The bootstrap pair is legal ONLY while this decoder is still at
	// generation 0. Once a generation is adopted a further HELLO / HELLO_ACK is
	// bad_generation, so a second bootstrap frame can never re-point a live
	// reader at a new generation.
	if frameType.isBootstrap() {
		if d.generation != 0 || head.generation != 0 {
			return ReasonBadGeneration, true
		}
	} else if d.generation == 0 || head.generation != d.generation {
		return ReasonBadGeneration, true
	}
	if head.sequence >= SequenceExhausted {
		return ReasonSequenceExhausted, true
	}
	if head.sequence != d.expected {
		return ReasonSequenceGap, true
	}
	if int(head.length) > d.bound {
		return ReasonLengthOverBound, true
	}
	if frameType.namesConnection() {
		if head.connection == 0 {
			return ReasonConnectionZero, true
		}
	} else if head.connection != 0 {
		return ReasonConnectionNotZero, true
	}
	return "", false
}

func (d *Decoder) fail(reason Reason, head header) error {
	d.latched = &MalformedError{
		Reason:     reason,
		Plane:      d.plane,
		Type:       head.frameType,
		Connection: head.connection,
		Sequence:   head.sequence,
		Length:     head.length,
	}
	d.headerFilled = 0
	d.staged = nil
	d.payload = nil
	d.payloadFilled = 0
	return d.latched
}

// payloadReader walks a payload's fixed part and its length-prefixed tail.
type payloadReader struct {
	bytes  []byte
	offset int
	reason Reason
}

func (r *payloadReader) remaining() int { return len(r.bytes) - r.offset }

func (r *payloadReader) u8() uint8 {
	v := r.bytes[r.offset]
	r.offset++
	return v
}

func (r *payloadReader) u16() uint16 {
	v := binary.LittleEndian.Uint16(r.bytes[r.offset:])
	r.offset += 2
	return v
}

func (r *payloadReader) u32() uint32 {
	v := binary.LittleEndian.Uint32(r.bytes[r.offset:])
	r.offset += 4
	return v
}

func (r *payloadReader) u64() uint64 {
	v := binary.LittleEndian.Uint64(r.bytes[r.offset:])
	r.offset += 8
	return v
}

// str reads one u16-prefixed UTF-8 field, latching the first fault it meets.
func (r *payloadReader) str() string {
	if r.reason != "" {
		return ""
	}
	if r.remaining() < 2 {
		r.reason = ReasonStringOverPayload
		return ""
	}
	length := int(r.u16())
	if r.remaining() < length {
		r.reason = ReasonStringOverPayload
		return ""
	}
	value := r.bytes[r.offset : r.offset+length]
	r.offset += length
	if !utf8.Valid(value) {
		r.reason = ReasonInvalidUTF8
		return ""
	}
	return string(value)
}

// fixedBytes is the payload prefix every type needs before its variable tail.
var fixedBytes = map[Type]int{
	TypeHello: 21, TypeAdmit: 4, TypeRefuse: 2, TypeCredit: 4,
	TypePause: 0, TypeResume: 0, TypeClose: 0, TypeLock: 4, TypeQuit: 4,
	TypePing:     8,
	TypeHelloAck: 10, TypeBound: 3, TypeOpen: 0, TypeWriteDone: 8,
	TypePeerClosed: 9, TypeLockAck: 8, TypeQuitAck: 0, TypePong: 8,
	TypeError: 6,
	TypeEnd:   0,
}

// decodeBody runs protocol section 10.1's payload phase, in its frozen order.
// A nil payload means the Reason is the answer.
func decodeBody(frameType Type, payload []byte) (Payload, Reason) {
	if frameType == TypeData {
		if len(payload) == 0 {
			return nil, ReasonEmptyData
		}
		// The buffer is the decoder's exactly-sized staging area, handed over
		// whole: the decoder drops its reference at the same moment.
		return Data{Payload: payload}, ""
	}
	if len(payload) < fixedBytes[frameType] {
		return nil, ReasonPayloadLengthMismatch
	}

	r := &payloadReader{bytes: payload}
	var decoded Payload
	switch frameType {
	case TypeHello:
		value := Hello{
			ProtocolVersion:     r.u16(),
			SDDLKind:            r.u8(),
			MaxRaw:              r.u16(),
			CreditBytes:         r.u32(),
			ChunkBytes:          r.u32(),
			HandshakeDeadlineMs: r.u32(),
		}
		value.InitialAdmissionEpoch = r.u32()
		value.PipeName = r.str()
		value.TimeoutRefusalBytes = r.str()
		if r.reason != "" {
			return nil, r.reason
		}
		if r.remaining() != 0 {
			return nil, ReasonPayloadLengthMismatch
		}
		if value.SDDLKind != SDDLKind {
			return nil, ReasonSDDLKind
		}
		return value, ""
	case TypeAdmit:
		decoded = Admit{AdmissionEpoch: r.u32()}
	case TypeRefuse:
		value := Refuse{Bytes: r.str()}
		if r.reason != "" {
			return nil, r.reason
		}
		decoded = value
	case TypeCredit:
		decoded = Credit{Bytes: r.u32()}
	case TypePause:
		decoded = Pause{}
	case TypeResume:
		decoded = Resume{}
	case TypeClose:
		decoded = Close{}
	case TypeLock:
		decoded = Lock{AdmissionEpoch: r.u32()}
	case TypeQuit:
		decoded = Quit{DeadlineMs: r.u32()}
	case TypePing:
		decoded = Ping{Nonce: r.u64()}
	case TypeHelloAck:
		value := HelloAck{
			ProtocolVersion:     r.u16(),
			AnnouncedGeneration: r.u32(),
			Pid:                 r.u32(),
		}
		value.FrontVersion = r.str()
		value.BuildHash = r.str()
		if r.reason != "" {
			return nil, r.reason
		}
		if r.remaining() != 0 {
			return nil, ReasonPayloadLengthMismatch
		}
		if value.AnnouncedGeneration == 0 {
			return nil, ReasonGenerationZero
		}
		return value, ""
	case TypeBound:
		value := Bound{FlagsApplied: r.u8()}
		value.PipeName = r.str()
		if r.reason != "" {
			return nil, r.reason
		}
		if r.remaining() != 0 {
			return nil, ReasonPayloadLengthMismatch
		}
		if value.FlagsApplied&^boundFlagsMask != 0 {
			return nil, ReasonBoundFlagsReserved
		}
		return value, ""
	case TypeOpen:
		decoded = Open{}
	case TypeWriteDone:
		decoded = WriteDone{AckThroughSequence: r.u64()}
	case TypePeerClosed:
		value := PeerClosed{
			Reason:              PeerClosedReason(r.u8()),
			ThroughDataSequence: r.u64(),
		}
		if r.remaining() != 0 {
			return nil, ReasonPayloadLengthMismatch
		}
		if value.Reason < PeerClosedPeerEOF || value.Reason > peerClosedHighestDefined {
			return nil, ReasonPeerClosedReason
		}
		return value, ""
	case TypeLockAck:
		decoded = LockAck{AdmissionEpoch: r.u32(), ClosedCount: r.u32()}
	case TypeQuitAck:
		decoded = QuitAck{}
	case TypePong:
		decoded = Pong{Nonce: r.u64()}
	case TypeError:
		value := ErrorReport{Code: ErrorCode(r.u16()), Count: r.u32()}
		if r.remaining() != 0 {
			return nil, ReasonPayloadLengthMismatch
		}
		if !value.Code.defined() {
			return nil, ReasonErrorCode
		}
		return value, ""
	case TypeEnd:
		decoded = End{}
	default:
		return nil, ReasonUnknownType
	}
	if r.remaining() != 0 {
		return nil, ReasonPayloadLengthMismatch
	}
	return decoded, ""
}
