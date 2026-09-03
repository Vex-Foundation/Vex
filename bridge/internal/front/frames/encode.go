package frames

import (
	"encoding/binary"
	"fmt"
	"math"
)

// EncodeError is an ENCODER refusal, and it is always a bug in this process:
// protocol section 9 says a refusal line that would not fit is a host bug
// reported loudly, never truncated. Reason is the machine-readable half.
type EncodeError struct {
	Reason string
	Detail string
}

func (e *EncodeError) Error() string {
	return fmt.Sprintf("frames: encode refused (%s): %s", e.Reason, e.Detail)
}

type payloadWriter struct {
	out []byte
	err *EncodeError
}

func (w *payloadWriter) u8(v uint8)   { w.out = append(w.out, v) }
func (w *payloadWriter) u16(v uint16) { w.out = binary.LittleEndian.AppendUint16(w.out, v) }
func (w *payloadWriter) u32(v uint32) { w.out = binary.LittleEndian.AppendUint32(w.out, v) }
func (w *payloadWriter) u64(v uint64) { w.out = binary.LittleEndian.AppendUint64(w.out, v) }

// str writes a u16 BYTE length followed by the UTF-8 bytes.
func (w *payloadWriter) str(value string, field string) {
	if len(value) > math.MaxUint16 {
		w.fail("string_too_long", fmt.Sprintf("%s is %d bytes; the u16 length prefix holds %d",
			field, len(value), math.MaxUint16))
		return
	}
	w.u16(uint16(len(value)))
	w.out = append(w.out, value...)
}

func (w *payloadWriter) fail(reason, detail string) {
	if w.err == nil {
		w.err = &EncodeError{Reason: reason, Detail: detail}
	}
}

// Encode renders one frame. It REFUSES anything the protocol forbids rather
// than emitting bytes a peer would have to call malformed.
func Encode(frame Frame) ([]byte, error) {
	if frame.Payload == nil {
		return nil, &EncodeError{Reason: "missing_payload", Detail: "the frame carries no payload"}
	}
	frameType := frame.Type()
	if !frameType.carriedBy(frame.Plane) {
		return nil, &EncodeError{
			Reason: "type_not_on_plane",
			Detail: fmt.Sprintf("%s on plane %d", frameType.Name(), frame.Plane),
		}
	}
	if frameType.isBootstrap() != (frame.Generation == 0) {
		return nil, &EncodeError{
			Reason: "bad_generation",
			Detail: fmt.Sprintf("%s carries generation %d", frameType.Name(), frame.Generation),
		}
	}
	if frameType.namesConnection() == (frame.Connection == 0) {
		reason := "connection_zero"
		if frame.Connection != 0 {
			reason = "connection_not_zero"
		}
		return nil, &EncodeError{
			Reason: reason,
			Detail: fmt.Sprintf("%s carries connection %d", frameType.Name(), frame.Connection),
		}
	}
	if frame.Sequence < 1 || frame.Sequence >= SequenceExhausted {
		return nil, &EncodeError{
			Reason: "sequence_range",
			Detail: fmt.Sprintf("sequence = %d", frame.Sequence),
		}
	}

	body, err := encodeBody(frame.Payload)
	if err != nil {
		return nil, err
	}
	bound := frame.Plane.PayloadBound()
	if len(body) > bound {
		return nil, &EncodeError{
			Reason: "length_over_bound",
			Detail: fmt.Sprintf("%s payload is %d bytes; plane %d bounds it at %d",
				frameType.Name(), len(body), frame.Plane, bound),
		}
	}

	out := make([]byte, HeaderBytes, HeaderBytes+len(body))
	binary.LittleEndian.PutUint32(out[0:], Magic)
	binary.LittleEndian.PutUint32(out[4:], frame.Generation)
	binary.LittleEndian.PutUint32(out[8:], frame.Connection)
	binary.LittleEndian.PutUint64(out[12:], frame.Sequence)
	out[20] = byte(frameType)
	out[21] = 0
	binary.LittleEndian.PutUint16(out[22:], 0)
	binary.LittleEndian.PutUint32(out[24:], uint32(len(body)))
	return append(out, body...), nil
}

func encodeBody(payload Payload) ([]byte, *EncodeError) {
	w := &payloadWriter{}
	switch p := payload.(type) {
	case Hello:
		w.u16(p.ProtocolVersion)
		w.u8(p.SDDLKind)
		w.u16(p.MaxRaw)
		w.u32(p.CreditBytes)
		w.u32(p.ChunkBytes)
		w.u32(p.HandshakeDeadlineMs)
		w.u32(p.InitialAdmissionEpoch)
		w.str(p.PipeName, "pipeName")
		w.str(p.TimeoutRefusalBytes, "timeoutRefusalBytes")
	case Admit:
		w.u32(p.AdmissionEpoch)
	case Refuse:
		w.str(p.Bytes, "bytes")
	case Credit:
		w.u32(p.Bytes)
	case Pause, Resume, Close, Open, QuitAck, End:
	case Lock:
		w.u32(p.AdmissionEpoch)
	case Quit:
		w.u32(p.DeadlineMs)
	case Ping:
		w.u64(p.Nonce)
	case HelloAck:
		w.u16(p.ProtocolVersion)
		if p.AnnouncedGeneration == 0 {
			w.fail("generation_zero", "HELLO_ACK must carry a fresh non-zero generation")
		}
		w.u32(p.AnnouncedGeneration)
		w.u32(p.Pid)
		w.str(p.FrontVersion, "frontVersion")
		w.str(p.BuildHash, "buildHash")
	case Bound:
		if p.FlagsApplied&^boundFlagsMask != 0 {
			w.fail("bound_flags_reserved", fmt.Sprintf("flagsApplied = %d", p.FlagsApplied))
		}
		w.u8(p.FlagsApplied)
		w.str(p.PipeName, "pipeName")
	case WriteDone:
		w.u64(p.AckThroughSequence)
	case PeerClosed:
		if p.Reason < PeerClosedPeerEOF || p.Reason > peerClosedHighestDefined {
			w.fail("peer_closed_reason", fmt.Sprintf("reason = %d", p.Reason))
		}
		w.u8(uint8(p.Reason))
		w.u64(p.ThroughDataSequence)
	case LockAck:
		w.u32(p.AdmissionEpoch)
		w.u32(p.ClosedCount)
	case Pong:
		w.u64(p.Nonce)
	case ErrorReport:
		if !p.Code.defined() {
			w.fail("error_code", fmt.Sprintf(
				"%d is not one of the front's frozen structural codes", p.Code))
		}
		w.u16(uint16(p.Code))
		w.u32(p.Count)
	case Data:
		if len(p.Payload) == 0 {
			w.fail("empty_data", "DATA carries no bytes")
		}
		w.out = append(w.out, p.Payload...)
	default:
		return nil, &EncodeError{
			Reason: "unknown_type",
			Detail: fmt.Sprintf("%T", payload),
		}
	}
	if w.err != nil {
		return nil, w.err
	}
	return w.out, nil
}
