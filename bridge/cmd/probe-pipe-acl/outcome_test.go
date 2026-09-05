package main

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// THE CLASSIFIER IS THE PART THAT CAN BE QUIETLY WRONG. A probe that reported
// `other` where the operating system said ACCESS DENIED would turn a proven
// denial into a failed job, and one that reported `access_denied` for a name
// nobody serves would turn a typo into proof. Both are decided here, on a
// number, so both are a table test that runs on every platform.
func TestClassifyDialError(t *testing.T) {
	cases := []struct {
		name string
		code uint32
		want outcome
	}{
		// ERROR_ACCESS_DENIED = 5: the measurement the whole instrument exists
		// for. go-winio asserts the same code for a dial against a restricted
		// descriptor (pipe_test.go TestDialAccessDeniedWithRestrictedSD).
		{"access denied", 5, outcomeAccessDenied},
		// ERROR_FILE_NOT_FOUND = 2: nobody serves the name (go-winio's
		// TestDialUnknownFailsImmediately).
		{"file not found", 2, outcomeFileNotFound},
		// ERROR_PIPE_BUSY = 231: served, but no free instance right now.
		{"pipe busy", 231, outcomePipeBusy},
		// ERROR_PATH_NOT_FOUND = 3 is NOT file-not-found: a different code is a
		// different fact, and only the three above are named.
		{"path not found is other", 3, outcomeOther},
		// ERROR_SEM_TIMEOUT = 121, what a wait on a pipe can produce.
		{"semaphore timeout is other", 121, outcomeOther},
		// A failure that carried no code at all still classifies, and never as
		// a success.
		{"no code is other", 0, outcomeOther},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyDialError(c.code); got != c.want {
				t.Errorf("classifyDialError(%d) = %q, want %q", c.code, got, c.want)
			}
		})
	}
}

// NO CODE CLASSIFIES AS `connected`. A connection is proven by CreateFile
// RETURNING A HANDLE and by nothing else; if any error code could be read as a
// success, a denial could be reported as an open pipe.
func TestNoErrorCodeClassifiesAsConnected(t *testing.T) {
	for code := uint32(0); code < 1500; code++ {
		if classifyDialError(code) == outcomeConnected {
			t.Fatalf("error code %d classified as %q", code, outcomeConnected)
		}
	}
}

// THE EXPECTATION IS SATISFIED ONLY BY A DENIAL THAT IS A DENIAL. `--expect
// denied` must not be satisfied by "not found" or "busy": both are outcomes of
// a pipe the account never reached, and accepting them would let a mistyped
// name or a shut-down server pass for a proven access control.
func TestRequiredOutcome(t *testing.T) {
	cases := []struct {
		expect string
		want   outcome
		assert bool
		valid  bool
	}{
		{expectConnected, outcomeConnected, true, true},
		{expectDenied, outcomeAccessDenied, true, true},
		// OMITTED is valid and asserts nothing: the recording mode contract 1.6
		// item 3 needs, because nobody has measured what the loopback
		// redirector path does yet.
		{"", "", false, true},
		{"file_not_found", "", false, false},
		{"pipe_busy", "", false, false},
		{"DENIED", "", false, false},
	}
	for _, c := range cases {
		want, assert, valid := requiredOutcome(c.expect)
		if want != c.want || assert != c.assert || valid != c.valid {
			t.Errorf("requiredOutcome(%q) = (%q, %v, %v), want (%q, %v, %v)",
				c.expect, want, assert, valid, c.want, c.assert, c.valid)
		}
	}
}

// THE LEVEL NAMES ARE THE JOB LOG'S WORDS FOR THE ENUM, and the one that
// decides item 8 is `identification`. The value 2 is NOT identification - it is
// SecurityImpersonation, the level the shipped bridge's SQOS flags exist to
// prevent - and naming it wrongly in a report is how a failed control gets read
// as a passing one.
func TestImpersonationLevelName(t *testing.T) {
	cases := map[uint32]string{
		0: "anonymous",
		1: "identification",
		2: "impersonation",
		3: "delegation",
		4: "unknown",
	}
	for level, want := range cases {
		if got := impersonationLevelName(level); got != want {
			t.Errorf("impersonationLevelName(%d) = %q, want %q", level, got, want)
		}
	}
	if impersonationLevelName(impersonationIdentification) != "identification" {
		t.Error("impersonationIdentification must be the identification level")
	}
	if impersonationIdentification != 1 {
		t.Errorf("SecurityIdentification is 1, not %d", impersonationIdentification)
	}
}

// keysOf decodes one emitted line and returns its top-level key set, which is
// the JSON contract the CI step parses.
func keysOf(t *testing.T, line []byte) []string {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(line, &decoded); err != nil {
		t.Fatalf("emitted line is not one JSON object: %v (%s)", err, line)
	}
	keys := make([]string, 0, len(decoded))
	for k := range decoded {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func emitted(t *testing.T, v any) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := emit(&buf, v); err != nil {
		t.Fatalf("emit: %v", err)
	}
	out := buf.Bytes()
	if !bytes.HasSuffix(out, []byte("\n")) {
		t.Fatal("every emitted object must end with a newline")
	}
	body := bytes.TrimSuffix(out, []byte("\n"))
	if bytes.Contains(body, []byte("\n")) {
		t.Fatalf("one object, one line: %s", out)
	}
	return body
}

// ONE OBJECT PER LINE, WITH A STABLE KEY SET. The CI step reads the last line
// of a redirected file and asks for `match` and `outcome`; a renamed or dropped
// key is a broken step, so the shapes are pinned here.
func TestJSONShapes(t *testing.T) {
	flags := uint8(0x07)
	yes := true
	level := impersonationIdentification
	cases := []struct {
		name  string
		value any
		keys  []string
	}{
		{
			"dial",
			dialReport{Event: "dial", Access: accessDuplex, Expect: expectDenied,
				Outcome: outcomeAccessDenied, WindowsError: 5, BusyRetries: 0, Match: &yes},
			[]string{"access", "busyRetries", "event", "expect", "match", "outcome", "windowsError"},
		},
		{
			"dial in recording mode",
			dialReport{Event: "dial", Access: accessDuplex, Outcome: outcomeOther, WindowsError: 53},
			[]string{"access", "busyRetries", "event", "expect", "match", "outcome", "windowsError"},
		},
		{
			"ready front",
			readyReport{Event: "ready", Descriptor: descriptorFront, Pid: 4,
				FlagsApplied: &flags, RejectRemote: &yes, FirstInstance: &yes, MessageMode: &yes},
			[]string{"descriptor", "event", "firstInstance", "flagsApplied", "messageMode", "pid", "rejectRemote"},
		},
		{
			"ready control arm",
			readyReport{Event: "ready", Descriptor: descriptorWinioDefault, Pid: 4},
			[]string{"descriptor", "event", "firstInstance", "flagsApplied", "messageMode", "pid", "rejectRemote"},
		},
		{
			"accepted",
			acceptedReport{Event: "accepted", Count: 1, ClientPid: 1234, ClientPidKnown: true,
				ImpersonationLevel: &level, ImpersonationLevelName: "identification"},
			[]string{"clientPid", "clientPidKnown", "count", "event", "impersonationLevel",
				"impersonationLevelName"},
		},
		{
			"accepted with no impersonation measurement",
			acceptedReport{Event: "accepted", Count: 1, ClientPidKnown: false,
				ImpersonationLevelName: impersonationUnmeasured},
			[]string{"clientPid", "clientPidKnown", "count", "event", "impersonationLevel",
				"impersonationLevelName"},
		},
		{
			"serve done",
			serveDoneReport{Event: "serve_done", Accepted: 2, Overflow: 0},
			[]string{"accepted", "event", "overflow"},
		},
		{
			"broken",
			brokenReport{Event: "broken", Outcome: reasonBindFailed},
			[]string{"event", "outcome"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			line := emitted(t, c.value)
			got := keysOf(t, line)
			if strings.Join(got, ",") != strings.Join(c.keys, ",") {
				t.Errorf("keys = %v, want %v", got, c.keys)
			}
		})
	}
}

// THE CONTROL ARM REPORTS ITS FLAGS AS ABSENT, NOT AS FALSE. It does not run
// the front's readback, so it has nothing to say about the flags; `null` says
// that and `false` would be a claim.
func TestControlArmReportsNoFlags(t *testing.T) {
	line := emitted(t, readyReport{Event: "ready", Descriptor: descriptorWinioDefault, Pid: 4})
	var decoded map[string]any
	if err := json.Unmarshal(line, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"flagsApplied", "rejectRemote", "firstInstance", "messageMode"} {
		if decoded[key] != nil {
			t.Errorf("%s = %v, want null", key, decoded[key])
		}
	}
}

// A BROKEN INSTRUMENT IS NOT A FAILED MEASUREMENT. exitBroken is its own code
// so the CI step can tell "the probe could not run" from "the account was not
// denied", and the reason is a constant of this package rather than a system
// error string - a Windows error on a pipe path carries the path.
func TestEmitBrokenReportsTheReasonAndItsOwnExitCode(t *testing.T) {
	var buf bytes.Buffer
	code := emitBroken(&buf, reasonReadbackFailed)
	if code != exitBroken {
		t.Errorf("emitBroken returned %d, want %d", code, exitBroken)
	}
	var decoded brokenReport
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Event != "broken" || decoded.Outcome != reasonReadbackFailed {
		t.Errorf("got %+v", decoded)
	}
}

// THE FIRST-INSTANCE COLLISION HAS THE LINE THE CI STEP GREPS. Contract 1.6
// item 7's first half is "the front refuses to serve a name a foreign account
// already serves", and what the job asserts is this exact line.
func TestBindFailureIsReportedAsAnOutcome(t *testing.T) {
	var buf bytes.Buffer
	if code := emitBroken(&buf, reasonBindFailed); code == exitOK {
		t.Fatal("a bind failure must not exit 0")
	}
	var decoded map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["outcome"] != "bind_failed" {
		t.Errorf(`outcome = %v, want "bind_failed"`, decoded["outcome"])
	}
}

// THE EXIT CODES ARE DISTINCT. Every one of them is read by a CI step as a
// different conclusion, and two that collided would make one of those
// conclusions unreachable.
func TestExitCodesAreDistinct(t *testing.T) {
	codes := map[int]string{
		exitOK:          "ok",
		exitMismatch:    "mismatch",
		exitUnsupported: "unsupported",
		exitBroken:      "broken",
	}
	if len(codes) != 4 {
		t.Fatalf("exit codes collide: %v", codes)
	}
}
