// The internal main<->front wire, executed against the GOLDEN VECTORS.
//
// `pipe-front-vectors.json` is the one fixture both codecs agree on: this suite
// runs it against the Go codec and `src/__tests__/vex-agent/mcp/
// pipe-front-frames.test.ts` runs the SAME FILE, by path, against the
// TypeScript one. Neither shares a line with the other, so a drift shows up as
// a red test on one side rather than as a front that relays nothing.
//
// Every vector is proven BOTH WAYS where it is a valid frame - bytes decode to
// the named fields, and those fields encode back to exactly those bytes - and
// decode-only where it is malformed, because a malformed frame has no encoder
// that would produce it.
package frames_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/vectors"
)

func load(t *testing.T) *vectors.FrontFramesFile {
	t.Helper()
	file, err := vectors.LoadFrontFrames()
	if err != nil {
		t.Fatalf("loading the pipe-front vectors: %v", err)
	}
	if file.ProtocolVersion != int(frames.ProtocolVersion) {
		t.Fatalf("the fixture is protocol v%d; this codec speaks v%d",
			file.ProtocolVersion, frames.ProtocolVersion)
	}
	return file
}

func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("the fixture carries a non-hex vector: %v", err)
	}
	return raw
}

func mustU64(t *testing.T, value string) uint64 {
	t.Helper()
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		t.Fatalf("the fixture carries a non-u64 sequence %q: %v", value, err)
	}
	return parsed
}

// number pulls one numeric payload field. A field the fixture omits is a
// fixture defect, not a zero value, so this fails rather than defaulting.
func number(t *testing.T, expect vectors.FrontExpect, field string) uint64 {
	t.Helper()
	raw, ok := expect.Payload[field]
	if !ok {
		t.Fatalf("%s: the fixture names no payload field %q", expect.Type, field)
	}
	var value uint64
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s.%s is not a number: %v", expect.Type, field, err)
	}
	return value
}

// u64String pulls a u64 payload field, which the fixture carries as a DECIMAL
// STRING so no reader on either side rounds it through a float.
func u64String(t *testing.T, expect vectors.FrontExpect, field string) uint64 {
	t.Helper()
	raw, ok := expect.Payload[field]
	if !ok {
		t.Fatalf("%s: the fixture names no payload field %q", expect.Type, field)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s.%s is not a decimal string: %v", expect.Type, field, err)
	}
	return mustU64(t, value)
}

func text(t *testing.T, expect vectors.FrontExpect, field string) string {
	t.Helper()
	raw, ok := expect.Payload[field]
	if !ok {
		t.Fatalf("%s: the fixture names no payload field %q", expect.Type, field)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s.%s is not a string: %v", expect.Type, field, err)
	}
	return value
}

// payloadFor rebuilds the codec's payload value from a fixture row, with no
// help from the codec's own decoder.
func payloadFor(t *testing.T, expect vectors.FrontExpect) frames.Payload {
	t.Helper()
	switch expect.Type {
	case "HELLO":
		return frames.Hello{
			ProtocolVersion:     uint16(number(t, expect, "protocolVersion")),
			SDDLKind:            uint8(number(t, expect, "sddlKind")),
			MaxRaw:              uint16(number(t, expect, "maxRaw")),
			CreditBytes:         uint32(number(t, expect, "creditBytes")),
			ChunkBytes:          uint32(number(t, expect, "chunkBytes")),
			HandshakeDeadlineMs: uint32(number(t, expect, "handshakeDeadlineMs")),
			// DYNAMIC, not a frozen equality value: it initialises a restarted
			// front's admission epoch to main's own.
			InitialAdmissionEpoch: uint32(number(t, expect, "initialAdmissionEpoch")),
			PipeName:              text(t, expect, "pipeName"),
			TimeoutRefusalBytes:   text(t, expect, "timeoutRefusalBytes"),
		}
	case "ADMIT":
		return frames.Admit{AdmissionEpoch: uint32(number(t, expect, "admissionEpoch"))}
	case "REFUSE":
		return frames.Refuse{Bytes: text(t, expect, "bytes")}
	case "CREDIT":
		return frames.Credit{Bytes: uint32(number(t, expect, "bytes"))}
	case "PAUSE":
		return frames.Pause{}
	case "RESUME":
		return frames.Resume{}
	case "CLOSE":
		return frames.Close{}
	case "LOCK":
		return frames.Lock{AdmissionEpoch: uint32(number(t, expect, "admissionEpoch"))}
	case "QUIT":
		return frames.Quit{DeadlineMs: uint32(number(t, expect, "deadlineMs"))}
	case "PING":
		return frames.Ping{Nonce: u64String(t, expect, "nonce")}
	case "HELLO_ACK":
		return frames.HelloAck{
			ProtocolVersion:     uint16(number(t, expect, "protocolVersion")),
			AnnouncedGeneration: uint32(number(t, expect, "announcedGeneration")),
			Pid:                 uint32(number(t, expect, "pid")),
			FrontVersion:        text(t, expect, "frontVersion"),
			BuildHash:           text(t, expect, "buildHash"),
		}
	case "BOUND":
		return frames.Bound{
			FlagsApplied: uint8(number(t, expect, "flagsApplied")),
			PipeName:     text(t, expect, "pipeName"),
		}
	case "OPEN":
		return frames.Open{}
	case "WRITE_DONE":
		return frames.WriteDone{
			AckThroughSequence: u64String(t, expect, "ackThroughSequence"),
		}
	case "PEER_CLOSED":
		return frames.PeerClosed{
			Reason:              frames.PeerClosedReason(number(t, expect, "reason")),
			ThroughDataSequence: u64String(t, expect, "throughDataSequence"),
		}
	case "LOCK_ACK":
		return frames.LockAck{
			AdmissionEpoch: uint32(number(t, expect, "admissionEpoch")),
			ClosedCount:    uint32(number(t, expect, "closedCount")),
		}
	case "QUIT_ACK":
		return frames.QuitAck{}
	case "PONG":
		return frames.Pong{Nonce: u64String(t, expect, "nonce")}
	case "ERROR":
		return frames.ErrorReport{
			Code:  frames.ErrorCode(number(t, expect, "code")),
			Count: uint32(number(t, expect, "count")),
		}
	case "DATA":
		return frames.Data{Payload: mustHex(t, text(t, expect, "payloadHex"))}
	case "END":
		return frames.End{}
	default:
		t.Fatalf("the fixture names a type this test cannot build: %q", expect.Type)
		return nil
	}
}

func frameFor(t *testing.T, plane uint8, expect vectors.FrontExpect) frames.Frame {
	t.Helper()
	return frames.Frame{
		Plane:      frames.Plane(plane),
		Generation: expect.Generation,
		Connection: expect.Connection,
		Sequence:   mustU64(t, expect.Sequence),
		Payload:    payloadFor(t, expect),
	}
}

func assertMatches(t *testing.T, got frames.Frame, want frames.Frame) {
	t.Helper()
	if got.Plane != want.Plane || got.Generation != want.Generation ||
		got.Connection != want.Connection || got.Sequence != want.Sequence {
		t.Fatalf("envelope: got plane=%d generation=%d connection=%d sequence=%d, fixture says %d/%d/%d/%d",
			got.Plane, got.Generation, got.Connection, got.Sequence,
			want.Plane, want.Generation, want.Connection, want.Sequence)
	}
	gotData, gotIsData := got.Payload.(frames.Data)
	wantData, wantIsData := want.Payload.(frames.Data)
	if gotIsData != wantIsData {
		t.Fatalf("payload kind: got %T, fixture says %T", got.Payload, want.Payload)
	}
	if gotIsData {
		if !bytes.Equal(gotData.Payload, wantData.Payload) {
			t.Fatalf("DATA payload differs from the fixture (%d bytes vs %d)",
				len(gotData.Payload), len(wantData.Payload))
		}
		return
	}
	if got.Payload != want.Payload {
		t.Fatalf("payload: got %#v, fixture says %#v", got.Payload, want.Payload)
	}
}

// ---------------------------------------------------------------- the fixture

func TestFixturePinsThisCodec(t *testing.T) {
	file := load(t)

	if file.Header.Bytes != frames.HeaderBytes {
		t.Errorf("header bytes: fixture %d, codec %d", file.Header.Bytes, frames.HeaderBytes)
	}
	if file.Header.Magic != frames.Magic {
		t.Errorf("magic: fixture %#x, codec %#x", file.Header.Magic, frames.Magic)
	}
	// The magic read as ASCII off the wire, little-endian, is "VEXF".
	wire := mustHex(t, file.Header.MagicWireBytes)
	if string(wire) != "VEXF" {
		t.Errorf("the magic's wire bytes read as %q, not VEXF", wire)
	}
	wantLayout := []string{
		"magic@0+4", "generation@4+4", "connection@8+4", "sequence@12+8",
		"type@20+1", "flags@21+1", "reserved@22+2", "length@24+4",
	}
	if len(file.Header.Fields) != len(wantLayout) {
		t.Fatalf("header fields: fixture names %d, the codec has %d",
			len(file.Header.Fields), len(wantLayout))
	}
	for i, field := range file.Header.Fields {
		got := fmt.Sprintf("%s@%d+%d", field.Name, field.Offset, field.Size)
		if got != wantLayout[i] {
			t.Errorf("header field %d: fixture %s, codec %s", i, got, wantLayout[i])
		}
	}

	for name, want := range map[string]uint8{
		"controlDown": uint8(frames.PlaneControlDown),
		"controlUp":   uint8(frames.PlaneControlUp),
		"dataDown":    uint8(frames.PlaneDataDown),
		"dataUp":      uint8(frames.PlaneDataUp),
	} {
		if file.Planes[name] != want {
			t.Errorf("plane %s: fixture %d, codec %d", name, file.Planes[name], want)
		}
	}

	// EVERY type id comes from the fixture, never from a hand-spelled constant
	// in a test: rule 10's "wire names come from machine artifacts".
	all := map[string]uint8{}
	for _, group := range []map[string]uint8{
		file.Types.MainToFrontControl, file.Types.FrontToMainControl, file.Types.Data,
	} {
		for name, id := range group {
			all[name] = id
		}
	}
	for name, id := range all {
		if got := frames.Type(id).Name(); got != name {
			t.Errorf("type 0x%02x: fixture calls it %s, codec calls it %q", id, name, got)
		}
	}

	for name, want := range map[string]uint8{
		"peer_eof":        uint8(frames.PeerClosedPeerEOF),
		"io_error":        uint8(frames.PeerClosedIOError),
		"commanded_close": uint8(frames.PeerClosedCommandedClose),
	} {
		if file.PeerClosedReasons[name] != want {
			t.Errorf("PEER_CLOSED reason %s: fixture %d, codec %d",
				name, file.PeerClosedReasons[name], want)
		}
	}
	for name, want := range map[string]uint8{
		"rejectRemote":  frames.BoundFlagRejectRemote,
		"firstInstance": frames.BoundFlagFirstInstance,
		"messageMode":   frames.BoundFlagMessageMode,
	} {
		if file.BoundFlags[name] != want {
			t.Errorf("BOUND flag %s: fixture %d, codec %d", name, file.BoundFlags[name], want)
		}
	}

	// The front's structural codes are a CLOSED set: main resolves every code
	// it logs, and an undefined one is a malformed frame.
	if len(file.ErrorCodes) == 0 {
		t.Fatal("the fixture declares no ERROR codes")
	}
	for name, id := range file.ErrorCodes {
		if got := frames.ErrorCode(id).Name(); got != name {
			t.Errorf("error code %d: fixture calls it %s, codec calls it %q", id, name, got)
		}
	}
}

// TestFixturePinsTheValidationOrder holds this codec to protocol section 10.1
// mechanically. A frame can violate two rules at once, and two codecs that
// checked them in different orders would report DIFFERENT reasons for the same
// bytes - and the reason is what an operator reads. Every adjacent pair of the
// order has a row that violates both and expects the earlier one.
func TestFixturePinsTheValidationOrder(t *testing.T) {
	file := load(t)
	if len(file.ValidationOrder) < 2 {
		t.Fatal("the fixture declares no validation order")
	}
	rank := map[string]int{}
	for i, step := range file.ValidationOrder {
		rank[step] = i
	}

	covered := map[string]bool{}
	for _, testCase := range file.Frames {
		claim := testCase.Precedence
		if claim == nil {
			continue
		}
		earlier, ok := rank[claim.Earlier]
		if !ok {
			t.Fatalf("%s: the order names no step %q", testCase.Name, claim.Earlier)
		}
		later, ok := rank[claim.Later]
		if !ok {
			t.Fatalf("%s: the order names no step %q", testCase.Name, claim.Later)
		}
		if earlier >= later {
			t.Errorf("%s: %s does not precede %s", testCase.Name, claim.Earlier, claim.Later)
		}
		if testCase.Expect.Kind != "malformed" {
			t.Errorf("%s: a precedence row must be malformed", testCase.Name)
			continue
		}
		produced := false
		for _, reason := range file.ValidationOrderReasons[claim.Earlier] {
			if reason == testCase.Expect.Reason {
				produced = true
			}
		}
		if !produced {
			t.Errorf("%s: step %s cannot produce reason %s",
				testCase.Name, claim.Earlier, testCase.Expect.Reason)
		}
		covered[claim.Earlier+">"+claim.Later] = true
	}

	unsatisfiable := map[string]bool{}
	for _, pair := range file.ValidationOrderUnsatisfiablePairs {
		unsatisfiable[pair.Earlier+">"+pair.Later] = true
	}
	for i := 0; i+1 < len(file.ValidationOrder); i++ {
		pair := file.ValidationOrder[i] + ">" + file.ValidationOrder[i+1]
		if !covered[pair] && !unsatisfiable[pair] {
			t.Errorf("no multi-fault vector proves the adjacent pair %s", pair)
		}
	}

	// A pair declared unsatisfiable still has to say how its earlier step is
	// pinned, so the declaration cannot become a way to drop a step.
	for _, pair := range file.ValidationOrderUnsatisfiablePairs {
		discharged := false
		if pair.ProvenAgainst == nil {
			for claim := range covered {
				if strings.HasSuffix(claim, ">"+pair.Earlier) {
					discharged = true
				}
			}
		} else {
			discharged = covered[pair.Earlier+">"+*pair.ProvenAgainst]
		}
		if !discharged {
			t.Errorf("the unsatisfiable pair %s>%s leaves its earlier step unproven",
				pair.Earlier, pair.Later)
		}
	}
}

func TestFixturePinsTheBounds(t *testing.T) {
	file := load(t)
	for key, want := range map[string]int{
		"controlPayloadMaxBytes":              frames.ControlPayloadMaxBytes,
		"dataPayloadMaxBytes":                 frames.DataPayloadMaxBytes,
		"maxRetainedPartialControlFrameBytes": frames.PlaneControlDown.RetentionBound(),
		"maxRetainedPartialDataFrameBytes":    frames.PlaneDataUp.RetentionBound(),
	} {
		if file.Limits[key] != want {
			t.Errorf("limit %s: fixture %d, codec %d", key, file.Limits[key], want)
		}
	}
	// The aggregate main retains from plane 6: every raw connection's full
	// credit window plus one decoder's maximum partial frame.
	aggregate := file.Limits["maxRawConnections"]*file.Limits["creditBytesPerConnection"] +
		frames.PlaneDataUp.RetentionBound()
	if file.Limits["aggregateFrontToMainRetainedBytes"] != aggregate {
		t.Errorf("aggregate retention: fixture %d, derived %d",
			file.Limits["aggregateFrontToMainRetainedBytes"], aggregate)
	}
}

func TestFixtureCoversEveryTypeAndReason(t *testing.T) {
	file := load(t)

	coveredTypes := map[string]bool{}
	coveredReasons := map[string]bool{}
	for _, testCase := range file.Frames {
		if testCase.Expect.Kind == "frame" {
			coveredTypes[testCase.Expect.Type] = true
		} else {
			coveredReasons[testCase.Expect.Reason] = true
		}
	}
	for _, group := range []map[string]uint8{
		file.Types.MainToFrontControl, file.Types.FrontToMainControl, file.Types.Data,
	} {
		for name := range group {
			if !coveredTypes[name] {
				t.Errorf("no valid vector for type %s", name)
			}
		}
	}
	for _, reason := range file.MalformedReasons {
		if !coveredReasons[reason] {
			t.Errorf("no malformed vector for reason %s", reason)
		}
	}
}

// ---------------------------------------------------------------- decode

func TestDecodeVectors(t *testing.T) {
	file := load(t)
	for _, testCase := range file.Frames {
		t.Run(testCase.Name, func(t *testing.T) {
			raw := mustHex(t, testCase.Hex)
			decoder := frames.NewDecoder(
				frames.Plane(testCase.Plane),
				testCase.ExpectedGeneration,
				mustU64(t, testCase.ExpectedSequence),
			)
			decoded, err := decoder.Push(raw)

			if testCase.Expect.Kind == "malformed" {
				var malformed *frames.MalformedError
				if err == nil {
					t.Fatalf("expected malformed (%s), decoded %d frames",
						testCase.Expect.Reason, len(decoded))
				}
				malformed = decoder.Failure()
				if malformed == nil {
					t.Fatal("the decoder returned an error but latched no failure")
				}
				if string(malformed.Reason) != testCase.Expect.Reason {
					t.Fatalf("reason: got %s, fixture says %s", malformed.Reason, testCase.Expect.Reason)
				}
				if malformed.Plane != frames.Plane(testCase.Plane) {
					t.Errorf("plane: got %d, fixture says %d", malformed.Plane, testCase.Plane)
				}
				// A malformed frame is TERMINAL: the buffer is dropped and the
				// same failure answers every later Push.
				if decoder.RetainedBytes() != 0 {
					t.Errorf("a failed decoder retains %d bytes", decoder.RetainedBytes())
				}
				again, againErr := decoder.Push(raw)
				if len(again) != 0 || againErr != malformed {
					t.Errorf("a failed decoder decoded again: %d frames, err %v", len(again), againErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(decoded) != 1 {
				t.Fatalf("decoded %d frames, expected 1", len(decoded))
			}
			assertMatches(t, decoded[0], frameFor(t, testCase.Plane, testCase.Expect))
			if decoder.RetainedBytes() != 0 {
				t.Errorf("the decoder retains %d bytes after a whole frame", decoder.RetainedBytes())
			}
			if got, want := decoder.ExpectedSequence(), mustU64(t, testCase.Expect.Sequence)+1; got != want {
				t.Errorf("next sequence: got %d, expected %d", got, want)
			}
		})
	}
}

// ---------------------------------------------------------------- encode

func TestEncodeVectors(t *testing.T) {
	file := load(t)
	for _, testCase := range file.Frames {
		if testCase.Expect.Kind != "frame" {
			continue
		}
		t.Run(testCase.Name, func(t *testing.T) {
			encoded, err := frames.Encode(frameFor(t, testCase.Plane, testCase.Expect))
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if got := hex.EncodeToString(encoded); got != testCase.Hex {
				t.Fatalf("encoded %d bytes that differ from the fixture's %d",
					len(encoded), len(testCase.Hex)/2)
			}
		})
	}
}

func TestEncodeRefusesWhatTheProtocolForbids(t *testing.T) {
	const generation = 0x2a7f1c04

	cases := []struct {
		name   string
		frame  frames.Frame
		reason string
	}{
		{
			// Protocol section 9: a refusal that would not fit is a HOST BUG
			// reported loudly, never truncated.
			name: "a refusal line one byte past the control bound",
			frame: frames.Frame{
				Plane: frames.PlaneControlDown, Generation: generation,
				Connection: 8, Sequence: 1,
				Payload: frames.Refuse{Bytes: string(bytes.Repeat([]byte("R"), frames.ControlPayloadMaxBytes-1))},
			},
			reason: "length_over_bound",
		},
		{
			name: "a data payload past the chunk bound",
			frame: frames.Frame{
				Plane: frames.PlaneDataDown, Generation: generation,
				Connection: 7, Sequence: 1,
				Payload: frames.Data{Payload: make([]byte, frames.DataPayloadMaxBytes+1)},
			},
			reason: "length_over_bound",
		},
		{
			name: "a control type on the wrong plane",
			frame: frames.Frame{
				Plane: frames.PlaneControlUp, Generation: generation,
				Connection: 7, Sequence: 1,
				Payload: frames.Admit{AdmissionEpoch: 1},
			},
			reason: "type_not_on_plane",
		},
		{
			name: "LOCK with a connection id",
			frame: frames.Frame{
				Plane: frames.PlaneControlDown, Generation: generation,
				Connection: 5, Sequence: 1,
				Payload: frames.Lock{AdmissionEpoch: 1},
			},
			reason: "connection_not_zero",
		},
		{
			name: "DATA with no connection id",
			frame: frames.Frame{
				Plane: frames.PlaneDataUp, Generation: generation,
				Connection: 0, Sequence: 1,
				Payload: frames.Data{Payload: []byte{1}},
			},
			reason: "connection_zero",
		},
		{
			name: "a non-bootstrap frame under generation zero",
			frame: frames.Frame{
				Plane: frames.PlaneControlDown, Generation: 0,
				Connection: 0, Sequence: 1,
				Payload: frames.Ping{Nonce: 1},
			},
			reason: "bad_generation",
		},
		{
			name: "an empty DATA frame",
			frame: frames.Frame{
				Plane: frames.PlaneDataUp, Generation: generation,
				Connection: 7, Sequence: 1,
				Payload: frames.Data{Payload: nil},
			},
			reason: "empty_data",
		},
		{
			name: "an ERROR code outside the frozen closed set",
			frame: frames.Frame{
				Plane: frames.PlaneControlUp, Generation: generation,
				Connection: 0, Sequence: 1,
				Payload: frames.ErrorReport{Code: 0, Count: 1},
			},
			reason: "error_code",
		},
		{
			name: "an ERROR code above the frozen closed set",
			frame: frames.Frame{
				Plane: frames.PlaneControlUp, Generation: generation,
				Connection: 0, Sequence: 1,
				Payload: frames.ErrorReport{Code: 0x1007, Count: 1},
			},
			reason: "error_code",
		},
		{
			name: "HELLO_ACK that never leaves the bootstrap generation",
			frame: frames.Frame{
				Plane: frames.PlaneControlUp, Generation: 0,
				Connection: 0, Sequence: 1,
				Payload: frames.HelloAck{ProtocolVersion: 1, AnnouncedGeneration: 0, Pid: 1},
			},
			reason: "generation_zero",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := frames.Encode(testCase.frame)
			if err == nil {
				t.Fatalf("the encoder emitted %d bytes it should have refused", len(encoded))
			}
			var refusal *frames.EncodeError
			ok := false
			if refusal, ok = err.(*frames.EncodeError); !ok {
				t.Fatalf("expected an *EncodeError, got %T", err)
			}
			if refusal.Reason != testCase.reason {
				t.Fatalf("reason: got %s, expected %s", refusal.Reason, testCase.reason)
			}
		})
	}
}

// ---------------------------------------------------------------- streams

func TestStreamVectors(t *testing.T) {
	file := load(t)
	if len(file.Streams) == 0 {
		t.Fatal("the fixture carries no stream vectors")
	}
	for _, stream := range file.Streams {
		raw := mustHex(t, stream.Hex)
		plane := frames.Plane(stream.Plane)

		t.Run(stream.Name+" in one push", func(t *testing.T) {
			decoder := frames.NewDecoder(plane, stream.ExpectedGeneration, mustU64(t, stream.StartSequence))
			decoded, err := decoder.Push(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(decoded) != len(stream.Frames) {
				t.Fatalf("decoded %d frames, the fixture names %d", len(decoded), len(stream.Frames))
			}
			for i, want := range stream.Frames {
				assertMatches(t, decoded[i], frameFor(t, stream.Plane, want))
			}
			if decoder.RetainedBytes() != 0 {
				t.Errorf("the decoder retains %d bytes at the end of a stream", decoder.RetainedBytes())
			}
		})

		// A pipe hands over whatever the OS had, so the boundary between two
		// frames lands anywhere. One byte at a time is the worst case.
		t.Run(stream.Name+" one byte at a time", func(t *testing.T) {
			decoder := frames.NewDecoder(plane, stream.ExpectedGeneration, mustU64(t, stream.StartSequence))
			var seen []frames.Frame
			for i := range raw {
				decoded, err := decoder.Push(raw[i : i+1])
				if err != nil {
					t.Fatalf("byte %d: %v", i, err)
				}
				seen = append(seen, decoded...)
				if decoder.RetainedBytes() > plane.RetentionBound() {
					t.Fatalf("retained %d bytes, over the plane's bound of %d",
						decoder.RetainedBytes(), plane.RetentionBound())
				}
			}
			if len(seen) != len(stream.Frames) {
				t.Fatalf("decoded %d frames, the fixture names %d", len(seen), len(stream.Frames))
			}
			for i, want := range stream.Frames {
				assertMatches(t, seen[i], frameFor(t, stream.Plane, want))
			}
		})

		t.Run(stream.Name+" under pseudo-random chunking", func(t *testing.T) {
			// Seeded, so a failure is reproducible rather than a flake.
			for seed := int64(1); seed <= 8; seed++ {
				source := rand.New(rand.NewSource(seed))
				decoder := frames.NewDecoder(plane, stream.ExpectedGeneration, mustU64(t, stream.StartSequence))
				var seen []frames.Frame
				for offset := 0; offset < len(raw); {
					size := 1 + source.Intn(5000)
					if offset+size > len(raw) {
						size = len(raw) - offset
					}
					decoded, err := decoder.Push(raw[offset : offset+size])
					if err != nil {
						t.Fatalf("seed %d at offset %d: %v", seed, offset, err)
					}
					offset += size
					seen = append(seen, decoded...)
					if decoder.RetainedBytes() > plane.RetentionBound() {
						t.Fatalf("seed %d retained %d bytes, over the bound of %d",
							seed, decoder.RetainedBytes(), plane.RetentionBound())
					}
				}
				if len(seen) != len(stream.Frames) {
					t.Fatalf("seed %d decoded %d frames, the fixture names %d",
						seed, len(seen), len(stream.Frames))
				}
			}
		})
	}
}

func TestPartialFrameIsHeldWithinTheBound(t *testing.T) {
	file := load(t)
	var maxData *vectors.FrontFrameCase
	for i := range file.Frames {
		if file.Frames[i].Name == "data at the data payload bound" {
			maxData = &file.Frames[i]
		}
	}
	if maxData == nil {
		t.Fatal("the fixture no longer carries the data payload bound vector")
	}

	raw := mustHex(t, maxData.Hex)
	plane := frames.Plane(maxData.Plane)
	decoder := frames.NewDecoder(plane, maxData.ExpectedGeneration, mustU64(t, maxData.ExpectedSequence))
	decoded, err := decoder.Push(raw[:len(raw)-1])
	if err != nil || len(decoded) != 0 {
		t.Fatalf("a partial frame produced %d frames and err %v", len(decoded), err)
	}
	if decoder.RetainedBytes() != len(raw)-1 {
		t.Fatalf("retained %d bytes of a %d-byte partial frame", decoder.RetainedBytes(), len(raw)-1)
	}
	if decoder.RetainedBytes() > plane.RetentionBound() {
		t.Fatalf("retained %d bytes, over the bound of %d", decoder.RetainedBytes(), plane.RetentionBound())
	}
	decoded, err = decoder.Push(raw[len(raw)-1:])
	if err != nil || len(decoded) != 1 {
		t.Fatalf("the last byte produced %d frames and err %v", len(decoded), err)
	}
}

// The retention bound is only real because the plane's payload bound is
// enforced at header parse. The vector is the 28 header bytes and nothing else.
func TestOverBoundLengthIsRejectedFromTheHeaderAlone(t *testing.T) {
	file := load(t)
	for _, testCase := range file.Frames {
		if testCase.Expect.Reason != "length_over_bound" {
			continue
		}
		t.Run(testCase.Name, func(t *testing.T) {
			raw := mustHex(t, testCase.Hex)
			if len(raw) != frames.HeaderBytes {
				t.Fatalf("the vector is %d bytes; a header-only vector is %d", len(raw), frames.HeaderBytes)
			}
			decoder := frames.NewDecoder(
				frames.Plane(testCase.Plane), testCase.ExpectedGeneration,
				mustU64(t, testCase.ExpectedSequence))
			if _, err := decoder.Push(raw); err == nil {
				t.Fatal("an over-bound length was accepted")
			}
			if decoder.RetainedBytes() != 0 {
				t.Errorf("a rejected header left %d bytes retained", decoder.RetainedBytes())
			}
		})
	}
}

// The retention guarantee measured as a PEAK during one Push, which is what
// the previous "retained bytes after the call returned" assertions could not
// see: a decoder that appended the caller's chunk first would hold all three
// frames at once here and still report 0 retained on the way out.
func TestRetentionBoundHoldsDuringAPush(t *testing.T) {
	const generation = 0x2a7f1c04
	plane := frames.PlaneDataUp
	bound := plane.RetentionBound()

	var chunk []byte
	for sequence := uint64(1); sequence <= 3; sequence++ {
		encoded, err := frames.Encode(frames.Frame{
			Plane: plane, Generation: generation, Connection: 7, Sequence: sequence,
			Payload: frames.Data{Payload: bytes.Repeat([]byte("A"), frames.DataPayloadMaxBytes)},
		})
		if err != nil {
			t.Fatalf("encoding chunk %d: %v", sequence, err)
		}
		chunk = append(chunk, encoded...)
	}
	if len(chunk) != 3*bound {
		t.Fatalf("the push is %d bytes, expected %d", len(chunk), 3*bound)
	}

	decoder := frames.NewDecoder(plane, generation, 1)
	decoded, err := decoder.Push(chunk)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded) != 3 {
		t.Fatalf("decoded %d frames, expected 3", len(decoded))
	}
	if decoder.RetainedBytes() != 0 {
		t.Errorf("the decoder retains %d bytes after three whole frames", decoder.RetainedBytes())
	}
	if got := decoder.PeakRetainedBytes(); got != bound {
		t.Fatalf("peak retention %d bytes, the plane's bound is %d", got, bound)
	}
}

// A hostile push: the 28 header bytes claiming a length far past the plane's
// bound, followed by a real megabyte of body in the SAME chunk. The header
// phase completes first, so no buffer is ever sized from the sender's number.
func TestAMalformedHeaderAllocatesNoBody(t *testing.T) {
	file := load(t)
	var overBound *vectors.FrontFrameCase
	for i := range file.Frames {
		if file.Frames[i].Name == "data length over bound" {
			overBound = &file.Frames[i]
		}
	}
	if overBound == nil {
		t.Fatal("the fixture no longer carries the data length over bound vector")
	}

	raw := mustHex(t, overBound.Hex)
	hostile := append(append([]byte{}, raw...), bytes.Repeat([]byte("B"), 1<<20)...)
	decoder := frames.NewDecoder(
		frames.Plane(overBound.Plane), overBound.ExpectedGeneration,
		mustU64(t, overBound.ExpectedSequence))
	if _, err := decoder.Push(hostile); err == nil {
		t.Fatal("an over-bound length was accepted")
	}
	if decoder.RetainedBytes() != 0 {
		t.Errorf("a rejected header left %d bytes retained", decoder.RetainedBytes())
	}
	if got := decoder.PeakRetainedBytes(); got != frames.HeaderBytes {
		t.Fatalf("peak retention %d bytes; only the %d header bytes may ever be staged",
			got, frames.HeaderBytes)
	}
}

// Adoption is ONE-SHOT and NON-ZERO. A second adoption is the very re-pointing
// protocol section 4 forbids, and adopting 0 would put a live reader back into
// the bootstrap where a stale front's frames parse again.
func TestAdoptGenerationIsOneShotAndNonZero(t *testing.T) {
	decoder := frames.NewDecoder(frames.PlaneDataUp, 0, 1)
	if err := decoder.AdoptGeneration(0); err == nil {
		t.Fatal("the bootstrap generation 0 was adopted")
	} else if state, ok := err.(*frames.StateError); !ok {
		t.Fatalf("expected a *StateError, got %T", err)
	} else if state.Reason != "adopt_generation_zero" {
		t.Fatalf("reason: got %s", state.Reason)
	}
	if err := decoder.AdoptGeneration(0x2a7f1c04); err != nil {
		t.Fatalf("the first adoption failed: %v", err)
	}
	if err := decoder.AdoptGeneration(0x2a7f1c05); err == nil {
		t.Fatal("a second generation was adopted")
	} else if state, ok := err.(*frames.StateError); !ok {
		t.Fatalf("expected a *StateError, got %T", err)
	} else if state.Reason != "adopt_generation_twice" {
		t.Fatalf("reason: got %s", state.Reason)
	}

	// A decoder constructed with a generation has already spent its adoption.
	live := frames.NewDecoder(frames.PlaneDataDown, 0x2a7f1c04, 1)
	if err := live.AdoptGeneration(0x2a7f1c05); err == nil {
		t.Fatal("a decoder past the bootstrap adopted a generation")
	}

	// And so has one that learned it from HELLO_ACK.
	file := load(t)
	var helloAck *vectors.FrontFrameCase
	for i := range file.Frames {
		if file.Frames[i].Name == "hello_ack" {
			helloAck = &file.Frames[i]
		}
	}
	if helloAck == nil {
		t.Fatal("the fixture no longer carries the hello_ack vector")
	}
	learned := frames.NewDecoder(frames.PlaneControlUp, 0, 1)
	if _, err := learned.Push(mustHex(t, helloAck.Hex)); err != nil {
		t.Fatalf("decoding HELLO_ACK: %v", err)
	}
	if err := learned.AdoptGeneration(0x2a7f1c05); err == nil {
		t.Fatal("a decoder that learned its generation adopted a second one")
	}
}

// The generation bootstrap, end to end on the plane the front answers on.
func TestGenerationIsAdoptedFromHelloAck(t *testing.T) {
	file := load(t)
	var stream *vectors.FrontStreamCase
	for i := range file.Streams {
		// The BOOTSTRAP stream: plane 4 read from generation 0. Other plane 4
		// streams start after the generation is already negotiated.
		if file.Streams[i].Plane == uint8(frames.PlaneControlUp) &&
			file.Streams[i].ExpectedGeneration == 0 {
			stream = &file.Streams[i]
		}
	}
	if stream == nil {
		t.Fatal("the fixture carries no bootstrap plane 4 stream")
	}

	decoder := frames.NewDecoder(frames.PlaneControlUp, 0, mustU64(t, stream.StartSequence))
	decoded, err := decoder.Push(mustHex(t, stream.Hex))
	if err != nil {
		t.Fatalf("a decoder that did not adopt the generation would fail here: %v", err)
	}
	ack, ok := decoded[0].Payload.(frames.HelloAck)
	if !ok {
		t.Fatalf("the plane 4 stream starts with %T, not HELLO_ACK", decoded[0].Payload)
	}
	// The HEADER is still the bootstrap 0 while the PAYLOAD names the new
	// generation. One name for both would have lost the header's value.
	if decoded[0].Generation != 0 {
		t.Errorf("HELLO_ACK's header generation is %d, not 0", decoded[0].Generation)
	}
	if ack.AnnouncedGeneration == 0 {
		t.Fatal("HELLO_ACK announced generation 0")
	}

	// A frame from the front main just killed carries the OLD generation.
	stale, err := frames.Encode(frames.Frame{
		Plane: frames.PlaneControlUp, Generation: ack.AnnouncedGeneration + 1,
		Connection: 0, Sequence: decoder.ExpectedSequence(),
		Payload: frames.Pong{Nonce: 7},
	})
	if err != nil {
		t.Fatalf("encoding the stale frame: %v", err)
	}
	if _, err := decoder.Push(stale); err == nil {
		t.Fatal("a stale generation was accepted")
	}
	if got := decoder.Failure().Reason; got != frames.ReasonBadGeneration {
		t.Fatalf("reason: got %s, expected %s", got, frames.ReasonBadGeneration)
	}
}

// A live reader must never be re-pointed at a new generation by a second
// HELLO_ACK.
func TestSecondBootstrapFrameIsRefused(t *testing.T) {
	file := load(t)
	var helloAck *vectors.FrontFrameCase
	for i := range file.Frames {
		if file.Frames[i].Name == "hello_ack" {
			helloAck = &file.Frames[i]
		}
	}
	if helloAck == nil {
		t.Fatal("the fixture no longer carries the hello_ack vector")
	}
	raw := mustHex(t, helloAck.Hex)

	decoder := frames.NewDecoder(frames.PlaneControlUp, 0x2a7f1c04, 1)
	if _, err := decoder.Push(raw); err == nil {
		t.Fatal("a HELLO_ACK reached a decoder that had already adopted a generation")
	}
	if got := decoder.Failure().Reason; got != frames.ReasonBadGeneration {
		t.Fatalf("reason: got %s, expected %s", got, frames.ReasonBadGeneration)
	}
}
