package handshake_test

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
	"github.com/Vex-Foundation/vex/bridge/internal/vectors"
)

const projectID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

func TestRequestMatchesTheFixtureBytes(t *testing.T) {
	file, err := vectors.Load()
	if err != nil {
		t.Fatalf("loading the golden vectors: %v", err)
	}
	// The host's own "valid handshake" case is the line this bridge must emit,
	// byte for byte. If the two disagree the host answers `malformed`.
	var valid string
	for _, testCase := range file.Handshake.Cases {
		if testCase.Expect.Kind == "accepted" && testCase.Expect.Remainder == "" {
			valid = testCase.Line
			break
		}
	}
	if valid == "" {
		t.Fatal("the fixture carries no accepted handshake case")
	}
	if got := string(handshake.EncodeRequest(projectID)); got != valid {
		t.Fatalf("the bridge sends %q; the contract's accepted line is %q", got, valid)
	}
	if file.Limits["handshakeMaxBytes"] != handshake.MaxLineBytes {
		t.Errorf("handshakeMaxBytes: fixture %d, package %d",
			file.Limits["handshakeMaxBytes"], handshake.MaxLineBytes)
	}
	if file.Limits["bridgeAckDeadlineMs"] != int(handshake.AckDeadline.Milliseconds()) {
		t.Errorf("bridgeAckDeadlineMs: fixture %d, package %d",
			file.Limits["bridgeAckDeadlineMs"], handshake.AckDeadline.Milliseconds())
	}
	if file.Limits["bridgeDiagnosticMaxBytes"] != handshake.DiagnosticMaxBytes {
		t.Errorf("bridgeDiagnosticMaxBytes: fixture %d, package %d",
			file.Limits["bridgeDiagnosticMaxBytes"], handshake.DiagnosticMaxBytes)
	}
	if file.Handshake.Acks.Accepted != `{"ok":true}`+"\n" {
		t.Errorf("the accepted ack shape drifted: %q", file.Handshake.Acks.Accepted)
	}
}

func TestParseAckAcceptsEveryFixtureRefusalCode(t *testing.T) {
	file, err := vectors.Load()
	if err != nil {
		t.Fatalf("loading the golden vectors: %v", err)
	}
	for _, code := range file.Handshake.Acks.RefusalCodes {
		ack, err := handshake.ParseAck([]byte(`{"ok":false,"code":"` + code + `","message":"why"}`))
		if err != nil {
			t.Fatalf("refusal %q: %v", code, err)
		}
		if ack.OK || string(ack.Code) != code || ack.Message != "why" {
			t.Fatalf("refusal %q parsed as %+v", code, ack)
		}
	}
	// Every code the contract names must be one this bridge already switches
	// on, or the exit-code table has a hole.
	known := map[string]bool{}
	for _, code := range handshake.KnownRefusalCodes {
		known[string(code)] = true
	}
	for _, code := range file.Handshake.Acks.RefusalCodes {
		if !known[code] {
			t.Errorf("the contract names refusal %q and the bridge does not know it", code)
		}
	}
}

// STRICT on the contract's fields, TOLERANT of the ones it does not name: a
// host that adds an optional key stays compatible with a v1 bridge, and the
// contract lists that as an additive change.
func TestParseAckStrictAndTolerant(t *testing.T) {
	ack, err := handshake.ParseAck([]byte(`{"ok":true,"serverVersion":"9.9","extra":{"a":[1]}}`))
	if err != nil || !ack.OK {
		t.Fatalf("unknown optional fields must not break a v1 bridge: %+v %v", ack, err)
	}
	// An unknown refusal CODE is not a parse failure either.
	ack, err = handshake.ParseAck([]byte(`{"ok":false,"code":"future_reason","message":"m"}`))
	if err != nil || string(ack.Code) != "future_reason" {
		t.Fatalf("an unknown refusal code must parse: %+v %v", ack, err)
	}

	for name, line := range map[string]string{
		"not JSON":                `not json`,
		"not an object":           `[1,2]`,
		"JSON null":               `null`,
		"no ok field":             `{"code":"locked"}`,
		"ok is not a boolean":     `{"ok":"true"}`,
		"refusal with no code":    `{"ok":false,"message":"m"}`,
		"refusal with empty code": `{"ok":false,"code":"","message":"m"}`,
	} {
		if _, err := handshake.ParseAck([]byte(line)); err == nil {
			t.Errorf("%s must be refused, and was accepted", name)
		}
	}
}

func TestValidProjectID(t *testing.T) {
	if !handshake.ValidProjectID(projectID) {
		t.Fatal("a UUID must be accepted")
	}
	for _, bad := range []string{"", "not-a-uuid", projectID + "x", "3f2504e04f8941d39a0c0305e82c3301"} {
		if handshake.ValidProjectID(bad) {
			t.Errorf("%q must be refused", bad)
		}
	}
}

// A refusal message is peer-controlled text on its way to a log. Control
// characters cannot survive as line breaks, and a message over the bound is
// bounded with the omission NAMED, never silently cut.
func TestDiagnosticSanitizesAndReportsItsBound(t *testing.T) {
	got := handshake.Diagnostic("first\nsecond\r\tthird\x00")
	if strings.ContainsAny(got, "\n\r\t\x00") {
		t.Fatalf("a control character survived: %q", got)
	}
	if !strings.Contains(got, "first") || !strings.Contains(got, "third") {
		t.Fatalf("sanitizing dropped content: %q", got)
	}

	long := strings.Repeat("x", handshake.DiagnosticMaxBytes*3)
	bounded := handshake.Diagnostic(long)
	if !strings.Contains(bounded, "more bytes omitted") {
		t.Fatalf("a bounded message must report what it left out: %q", bounded)
	}
	// The count is derived from what was ACTUALLY kept, so the assertion is
	// computed rather than copied: the whole line is the budget, so the
	// retained content is `bound minus the notice`, not the bound itself.
	kept := strings.Index(bounded, " [")
	if kept < 0 {
		t.Fatalf("the notice is missing its delimiter: %q", bounded)
	}
	expected := fmt.Sprintf("[%d more bytes omitted from a %d-byte host message]",
		len(long)-kept, len(long))
	if !strings.HasSuffix(bounded, expected) {
		t.Fatalf("the omitted count must be exact; want suffix %q in %q", expected, bounded)
	}
	short := handshake.Diagnostic("a short sentence.")
	if short != "a short sentence." {
		t.Fatalf("a message inside the bound must pass through whole: %q", short)
	}
	// Invalid UTF-8 becomes a replacement rather than raw bytes in a log.
	if handshake.Diagnostic(string([]byte{0xff, 0xfe})) == string([]byte{0xff, 0xfe}) {
		t.Fatal("invalid UTF-8 must not reach the log verbatim")
	}
}

// THE BUDGET IS THE WHOLE WIRE LINE, prefix and newline included.
//
// Two corrections met here. The first kept DiagnosticMaxBytes of content and
// then appended the omission notice, so a long host message produced 578 bytes
// from a bound that names 512. The second is this one: the body was budgeted
// 512 and the writer then added `vex-mcp: ` and "\n", so the BUILT BINARY put
// 522 bytes on the pipe. The assertion is now on StderrLine - what actually
// reaches stderr - across the sizes where the notice's own digit count
// changes, so neither the fixed-point loop nor the framing can regress.
func TestStderrLineNeverExceedsTheBound(t *testing.T) {
	sizes := []int{
		0, 1, 100,
		handshake.DiagnosticBodyMaxBytes - 1,
		handshake.DiagnosticBodyMaxBytes,
		handshake.DiagnosticBodyMaxBytes + 1,
		handshake.DiagnosticMaxBytes - 1,
		handshake.DiagnosticMaxBytes,
		handshake.DiagnosticMaxBytes + 1,
		handshake.DiagnosticMaxBytes + 47,
		1000, 9999, 10000, 100000, 999999, 1000000,
	}
	for _, size := range sizes {
		message := strings.Repeat("x", size)
		body := handshake.Diagnostic(message)
		if len(body) > handshake.DiagnosticBodyMaxBytes {
			t.Errorf("a %d-byte message produced a %d-byte body, over the %d-byte budget",
				size, len(body), handshake.DiagnosticBodyMaxBytes)
		}
		line := handshake.StderrLine(message)
		if len(line) > handshake.DiagnosticMaxBytes {
			t.Errorf("a %d-byte message produced a %d-byte COMPLETE line, over the %d-byte bound: %q",
				size, len(line), handshake.DiagnosticMaxBytes, line)
		}
		if !strings.HasPrefix(line, handshake.StderrPrefix) || !strings.HasSuffix(line, "\n") {
			t.Errorf("a %d-byte message produced an unframed line: %q", size, line)
		}
		if strings.Count(line, "\n") != 1 || strings.ContainsRune(line, '\r') {
			t.Errorf("a %d-byte message produced more than one line", size)
		}
	}
}

// The prefix and the newline are PAID FOR, not assumed to fit. A drift in
// either would silently eat into the body budget.
func TestDiagnosticBodyBudgetPaysForTheFraming(t *testing.T) {
	want := handshake.DiagnosticMaxBytes - len(handshake.StderrPrefix) - 1
	if handshake.DiagnosticBodyMaxBytes != want {
		t.Fatalf("DiagnosticBodyMaxBytes is %d, want %d",
			handshake.DiagnosticBodyMaxBytes, want)
	}
	if handshake.StderrPrefix != "vex-mcp: " {
		t.Fatalf("the stderr prefix changed to %q; the bound budgets for it",
			handshake.StderrPrefix)
	}
}

// The bound is applied to BYTES, and a multi-byte rune must not be cut in
// half: the sanitiser promised the result is valid UTF-8, and a severed rune
// would put replacement bytes in a log the reader is told is clean.
func TestDiagnosticNeverSplitsARune(t *testing.T) {
	// Three-byte runes, so most byte offsets fall INSIDE a rune.
	for _, size := range []int{300, 400, 500, 600, 1200} {
		message := strings.Repeat("世", size)
		got := handshake.Diagnostic(message)
		if len(handshake.StderrLine(message)) > handshake.DiagnosticMaxBytes {
			t.Fatalf("%d runes produced a %d-byte line", size, len(handshake.StderrLine(message)))
		}
		if !utf8.ValidString(got) {
			t.Fatalf("%d runes produced invalid UTF-8: %q", size, got)
		}
	}
}

// An ack line carries ONE decision. `json.Decoder` reads a stream and stops at
// the end of the first value, so `{"ok":true}{"ok":false}` used to be accepted
// as an ACCEPT while the refusal that followed it was never read.
func TestParseAckRequiresEOFAfterTheFirstValue(t *testing.T) {
	for name, line := range map[string]string{
		"two objects, accept then refuse": `{"ok":true}{"ok":false,"code":"locked"}`,
		"two objects, refuse then accept": `{"ok":false,"code":"locked"}{"ok":true}`,
		"the same object twice":           `{"ok":true}{"ok":true}`,
		"trailing garbage bytes":          `{"ok":true}garbage`,
		"a trailing scalar":               `{"ok":true}7`,
		"a trailing array":                `{"ok":true}[]`,
		"a trailing null":                 `{"ok":true}null`,
		"a trailing brace":                `{"ok":true}}`,
	} {
		t.Run(name, func(t *testing.T) {
			ack, err := handshake.ParseAck([]byte(line))
			if err == nil {
				t.Fatalf("%q was accepted as %+v; a line with more than one value is malformed", line, ack)
			}
		})
	}
}

// The tolerance that must SURVIVE the strictness above: whitespace around the
// single value is framing, not a second value.
func TestParseAckToleratesSurroundingWhitespace(t *testing.T) {
	for _, line := range []string{
		`{"ok":true}`,
		` {"ok":true} `,
		"\t{\"ok\":true}\t",
		`{"ok":true}` + "\r",
	} {
		ack, err := handshake.ParseAck([]byte(line))
		if err != nil {
			t.Fatalf("%q was refused: %v", line, err)
		}
		if !ack.OK {
			t.Fatalf("%q parsed as a refusal", line)
		}
	}
}
