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
)

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

// Decoder decodes ONE plane incrementally.
//
// Bytes may arrive in any chunking, including one byte at a time, and the
// decoder retains at most Plane.RetentionBound() bytes because the header - the
// plane's payload bound included - is validated in full before a payload byte
// is kept.
//
// A malformed frame is TERMINAL, matching protocol section 10: the position in
// the stream is unknown after a framing fault, so the decoder latches the
// failure, drops its buffer, and returns no frames and that same error from
// every later Push. The caller kills the front (main's side) or exits (the
// front's side); there is no resynchronisation to offer.
type Decoder struct {
	plane      Plane
	bound      int
	generation uint32
	expected   uint64
	pending    []byte
	latched    *MalformedError
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
		expected:   sequence,
	}
}

// Failure is the malformed frame that ended this decoder, or nil while it lives.
func (d *Decoder) Failure() *MalformedError { return d.latched }

// RetainedBytes is the incomplete frame currently held, never above the bound.
func (d *Decoder) RetainedBytes() int { return len(d.pending) }

// ExpectedSequence is the sequence the next frame must carry.
func (d *Decoder) ExpectedSequence() uint64 { return d.expected }

// AdoptGeneration takes the generation HELLO_ACK announced. A plane 4 reader
// does not need it - Push adopts from HELLO_ACK itself - but the readers of
// planes 3, 5 and 6 are told by their owner.
func (d *Decoder) AdoptGeneration(generation uint32) { d.generation = generation }

// Push feeds bytes and returns every frame that completed. On a malformed frame
// it returns the frames decoded BEFORE the fault plus a *MalformedError, and
// the decoder is finished.
func (d *Decoder) Push(chunk []byte) ([]Frame, error) {
	if d.latched != nil || len(chunk) == 0 {
		return nil, d.latched
	}
	d.pending = append(d.pending, chunk...)

	var out []Frame
	for {
		if len(d.pending) < HeaderBytes {
			return out, nil
		}
		head := parseHeader(d.pending[:HeaderBytes])
		if reason, bad := d.validateHeader(head); bad {
			return out, d.fail(reason, head)
		}
		total := HeaderBytes + int(head.length)
		if len(d.pending) < total {
			return out, nil
		}
		payload, reason := decodeBody(Type(head.frameType), d.pending[HeaderBytes:total])
		if payload == nil {
			return out, d.fail(reason, head)
		}
		if len(d.pending) == total {
			// Release the backing array rather than carrying an empty slice
			// with a 32 KiB capacity into the next frame.
			d.pending = nil
		} else {
			d.pending = d.pending[total:]
		}
		d.expected = head.sequence + 1
		if ack, ok := payload.(HelloAck); ok {
			// A plane 4 reader LEARNS the generation here (protocol section 4).
			d.generation = ack.AnnouncedGeneration
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
	d.pending = nil
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
	TypeHello: 17, TypeAdmit: 4, TypeRefuse: 2, TypeCredit: 4,
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
		out := make([]byte, len(payload))
		copy(out, payload)
		return Data{Payload: out}, ""
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
		decoded = WriteDone{ThroughSequence: r.u64()}
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
		decoded = ErrorReport{Code: r.u16(), Count: r.u32()}
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
