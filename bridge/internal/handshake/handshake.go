// Package handshake performs the bridge side of the Vex Studio handshake: one
// line out, one ack line in, then MCP.
//
// The wire is frozen in `studio-mcp/bridge-endpoint-contract.md` section 2.
// The parser here is STRICT about the fields the contract names and TOLERANT
// of fields it does not: a future host may add an optional key, and a v1
// bridge that refused the connection over it would break a compatible change
// the contract explicitly allows.
package handshake

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// ProtocolVersion is the one MAJOR this bridge speaks.
const ProtocolVersion = 1

// MaxLineBytes is the contract's handshake line bound, applied to the ack the
// bridge READS as well as the line it writes. A host that never sends a
// newline must not make the bridge buffer without limit.
const MaxLineBytes = 4096

// AckDeadline bounds the wait for the ack. It matches the host's own
// handshake deadline (contract section 2.1) so the two sides give up at the
// same point rather than one hanging on the other's silence.
const AckDeadline = 5 * time.Second

// StderrPrefix is the process tag every diagnostic line carries. It is part of
// the WIRE, not decoration: DiagnosticMaxBytes budgets for it.
const StderrPrefix = "vex-mcp: "

// DiagnosticMaxBytes bounds one COMPLETE stderr line: the StderrPrefix, the
// diagnostic body, and the terminating newline. A host message is
// peer-controlled text; it is sanitized and bounded, and when it does not fit
// the remainder is REPORTED rather than silently dropped.
//
// COMPLETE, because the built binary emitted 522 bytes from a "512-byte"
// bound: Diagnostic budgeted 512 for the body and the writer then prepended
// the 9-byte prefix and appended the newline. The bound now covers what
// actually reaches the pipe.
const DiagnosticMaxBytes = 512

// DiagnosticBodyMaxBytes is what is left for the sanitized body once the
// prefix and the newline are paid for: 512 - 9 - 1 = 502.
const DiagnosticBodyMaxBytes = DiagnosticMaxBytes - len(StderrPrefix) - 1

// StderrLine renders the COMPLETE line one diagnostic writes, prefix and
// newline included, within DiagnosticMaxBytes. It is the only assembly of a
// stderr line in this program, so the bound has exactly one owner.
func StderrLine(message string) string {
	return StderrPrefix + Diagnostic(message) + "\n"
}

// RefusalCode is the closed set the host may answer with.
type RefusalCode string

const (
	RefuseUnknownProject      RefusalCode = "unknown_project"
	RefuseIncompatibleVersion RefusalCode = "incompatible_version"
	RefuseLocked              RefusalCode = "locked"
	RefuseAtCapacity          RefusalCode = "at_capacity"
	RefuseMalformed           RefusalCode = "malformed"
)

// KnownRefusalCodes is the v1 set. An UNKNOWN code is not an error: the
// contract lists "a new refusal code" as an additive change, and a v1 bridge
// is required to print the message and exit non-zero.
var KnownRefusalCodes = []RefusalCode{
	RefuseUnknownProject, RefuseIncompatibleVersion, RefuseLocked,
	RefuseAtCapacity, RefuseMalformed,
}

// Ack is the host's answer. Message is present only on a refusal.
type Ack struct {
	OK      bool
	Code    RefusalCode
	Message string
}

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ValidProjectID reports whether a project id is the UUID the host requires.
// Checked here so a typo is a local usage error with a sentence, rather than a
// round trip that comes back `malformed`.
func ValidProjectID(value string) bool { return uuidRE.MatchString(value) }

// EncodeRequest builds the single line the bridge sends.
//
// Field order is fixed so the bytes on the wire are reproducible and a capture
// from one run compares against another.
func EncodeRequest(projectID string) []byte {
	return []byte(fmt.Sprintf(`{"v":%d,"projectId":%s}`+"\n",
		ProtocolVersion, mustJSONString(projectID)))
}

func mustJSONString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		// json.Marshal of a string cannot fail; the branch exists so the
		// caller never sees a silently empty field.
		return `""`
	}
	return string(encoded)
}

// ErrAckTooLong is returned when no newline arrives within the line bound.
var ErrAckTooLong = errors.New("the Vex Studio host sent no ack line within the 4096-byte bound")

// ParseAck decodes one ack line.
//
// STRICT on the contract's own fields: `ok` must be present and boolean, and a
// refusal must carry a non-empty string `code`. TOLERANT of everything else,
// so a host that adds an optional key stays compatible with this bridge.
func ParseAck(line []byte) (Ack, error) {
	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	if err := decoder.Decode(&fields); err != nil {
		return Ack{}, fmt.Errorf("the Vex Studio ack is not a JSON object: %w", err)
	}
	// EXACTLY ONE VALUE, then EOF. `json.Decoder` reads a STREAM, so it
	// stops at the end of the first value and reports success while
	// `{"ok":true}{"ok":false}` still sits in the buffer - the bridge would
	// have acted on the first and never seen the second. An ack line carries
	// one decision; anything after it means the two sides disagree about what
	// this line is, which is malformed, not tolerable extension. (Trailing
	// whitespace is not trailing content: the decoder skips it before EOF.)
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return Ack{}, errors.New("the Vex Studio ack line carries more than one JSON value")
	}
	if fields == nil {
		return Ack{}, errors.New("the Vex Studio ack is JSON null, not an object")
	}

	rawOK, present := fields["ok"]
	if !present {
		return Ack{}, errors.New(`the Vex Studio ack has no "ok" field`)
	}
	var ok bool
	if err := json.Unmarshal(rawOK, &ok); err != nil {
		return Ack{}, errors.New(`the Vex Studio ack's "ok" field is not a boolean`)
	}
	if ok {
		return Ack{OK: true}, nil
	}

	rawCode, present := fields["code"]
	if !present {
		return Ack{}, errors.New(`the Vex Studio ack refused without a "code"`)
	}
	var code string
	if err := json.Unmarshal(rawCode, &code); err != nil || code == "" {
		return Ack{}, errors.New(`the Vex Studio ack's "code" is not a non-empty string`)
	}

	var message string
	if rawMessage, present := fields["message"]; present {
		// A non-string message is tolerated as absent rather than fatal: the
		// message is diagnostics, and the CODE is what the bridge acts on.
		_ = json.Unmarshal(rawMessage, &message)
	}
	return Ack{Code: RefusalCode(code), Message: message}, nil
}

// Conn is what the handshake needs from a transport: bytes in both directions,
// a bound on how long it will wait, and a close it can fall back to.
//
// It is an interface rather than net.Conn because a Windows named pipe is
// opened as an *os.File, not a net.Conn - see Perform's deadline note.
type Conn interface {
	io.ReadWriter
	// SetDeadline bounds the handshake. A transport that cannot honour one
	// returns os.ErrNoDeadline, which Perform handles rather than ignores.
	SetDeadline(t time.Time) error
	Close() error
}

// Perform writes the handshake line and reads the ack, both under deadline.
//
// It returns the leftover bytes the host wrote after the ack newline. The host
// writes nothing before the ack, so that remainder is normally empty; it is
// returned rather than discarded because discarding peer bytes at a protocol
// seam is exactly the class of bug the host's own remainder-preserving parser
// exists to avoid.
func Perform(conn Conn, projectID string, deadline time.Duration) (Ack, []byte, error) {
	// THE DEADLINE IS ENFORCED EITHER WAY. A unix socket takes a real
	// deadline. A handle the runtime poller does not own - a Windows named
	// pipe opened with CreateFile - answers os.ErrNoDeadline, and the bound is
	// then enforced by CLOSING the handle, which is the only mechanism stdlib
	// offers there. Silently proceeding without a bound would let a host that
	// accepts and never answers hang the bridge forever, which is exactly the
	// failure the contract's ack deadline exists to prevent.
	stopWatchdog := func() {}
	if err := conn.SetDeadline(time.Now().Add(deadline)); err != nil {
		if !errors.Is(err, os.ErrNoDeadline) {
			return Ack{}, nil, fmt.Errorf("setting the handshake deadline: %w", err)
		}
		stopWatchdog = closeAfter(conn, deadline)
	}
	defer stopWatchdog()
	if _, err := conn.Write(EncodeRequest(projectID)); err != nil {
		return Ack{}, nil, fmt.Errorf("sending the Vex Studio handshake: %w", err)
	}

	reader := bufio.NewReaderSize(conn, MaxLineBytes+1)
	line, err := readBoundedLine(reader)
	if err != nil {
		return Ack{}, nil, err
	}
	ack, err := ParseAck(line)
	if err != nil {
		return Ack{}, nil, err
	}
	// Clear the deadline: the relay owns its own lifetime from here, and a
	// deadline left in place would kill a healthy long-lived session. A
	// transport with no deadline support has nothing to clear; its watchdog is
	// stopped by the deferred call above.
	if err := conn.SetDeadline(time.Time{}); err != nil && !errors.Is(err, os.ErrNoDeadline) {
		return Ack{}, nil, fmt.Errorf("clearing the handshake deadline: %w", err)
	}
	return ack, bufferedRemainder(reader), nil
}

// closeAfter is the deadline of last resort: it CLOSES the connection when the
// bound elapses, so a blocked read fails instead of parking forever. The
// returned function stops the timer and is safe to call more than once.
func closeAfter(conn Conn, deadline time.Duration) func() {
	timer := time.AfterFunc(deadline, func() { _ = conn.Close() })
	return func() { timer.Stop() }
}

// readBoundedLine reads up to and including one newline, refusing past the
// contract's bound instead of buffering without limit.
func readBoundedLine(reader *bufio.Reader) ([]byte, error) {
	line := make([]byte, 0, 128)
	for {
		b, err := reader.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) == 0 {
				return nil, errors.New("the Vex Studio host closed the connection without an ack")
			}
			return nil, fmt.Errorf("reading the Vex Studio ack: %w", err)
		}
		if b == '\n' {
			return line, nil
		}
		line = append(line, b)
		if len(line) > MaxLineBytes {
			return nil, ErrAckTooLong
		}
	}
}

// bufferedRemainder drains whatever the ack read pulled in beyond the newline.
func bufferedRemainder(reader *bufio.Reader) []byte {
	n := reader.Buffered()
	if n == 0 {
		return nil
	}
	rest := make([]byte, n)
	if _, err := io.ReadFull(reader, rest); err != nil {
		return nil
	}
	return rest
}

// Diagnostic renders one host-supplied message as ONE stderr-safe BODY of at
// most DiagnosticBodyMaxBytes, so that StderrLine's complete line - prefix,
// body and newline - stays within DiagnosticMaxBytes.
//
// Three obligations, all from peer-controlled text. Control characters
// (embedded newlines included) become spaces, so a hostile or buggy message
// cannot forge extra log lines. Invalid UTF-8 becomes U+FFFD. And the byte
// budget is the WHOLE LINE, omission notice included.
//
// That last point is the correction: the previous version kept
// DiagnosticBodyMaxBytes of content and THEN appended the notice, so a long host
// message produced 578 bytes from a "512-byte" bound - a bound that only held
// when it was not needed. The retained content is now sized so that content
// plus notice fits, and because the notice carries the omitted COUNT, its own
// length depends on how much is kept; the loop below settles that at a fixed
// point rather than guessing a worst case.
//
// The omission is NAMED with its byte count rather than hidden behind an
// ellipsis: the reader can tell exactly how much was left out.
func Diagnostic(message string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == utf8.RuneError || r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(message, string(utf8.RuneError)))
	cleaned = strings.TrimSpace(cleaned)
	if len(cleaned) <= DiagnosticBodyMaxBytes {
		return cleaned
	}

	// kept only ever DECREASES: a smaller kept means a larger omitted count,
	// which can only lengthen the notice, which can only shrink kept again.
	// The loop therefore terminates, and it exits only when the notice it is
	// about to print is the one its own length was computed from.
	kept := DiagnosticBodyMaxBytes
	for {
		suffix := omissionNotice(len(cleaned)-kept, len(cleaned))
		next := DiagnosticBodyMaxBytes - len(suffix)
		if next < 0 {
			next = 0
		}
		if next > kept {
			next = kept
		}
		// Never cut a multi-byte rune in half; that would emit U+FFFD bytes
		// the sanitiser above already promised were gone.
		for next > 0 && !utf8.RuneStart(cleaned[next]) {
			next--
		}
		if next == kept {
			return cleaned[:kept] + suffix
		}
		kept = next
	}
}

func omissionNotice(omitted int, total int) string {
	return fmt.Sprintf(" [%d more bytes omitted from a %d-byte host message]", omitted, total)
}
