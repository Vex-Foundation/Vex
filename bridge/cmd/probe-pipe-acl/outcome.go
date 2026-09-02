// Command probe-pipe-acl MEASURES, on a Windows machine with two accounts,
// whether another local user can connect to the pipe the Vex Studio front
// creates. It exists because the front's descriptor has only ever been verified
// by the front's own readback and by same-user tests: the property that matters
// to a self-custodial wallet - ANOTHER LOCAL USER CANNOT CONNECT - had never
// been measured, and endpoint contract 1.6 refuses to open the Windows
// transport gate on an unmeasured claim.
//
// It is an INSTRUMENT, not a shipped binary: no packaging path builds it, and
// nothing in the app links it. Its two modes are driven by the `bridge-windows`
// CI job, which creates a temporary local account for the run and removes it
// afterwards.
//
// WHAT IT PRINTS. One JSON object per line on stdout, and nothing else. The
// output is STRUCTURAL: an outcome name, a Windows error code, a process id, a
// boolean. It never carries the security descriptor, a SID, an account name, a
// password or the pipe path - the pipe path in particular arrives inside almost
// every Windows error string, which is why no error string is ever printed
// (rules 05 and 07, and the same discipline as internal/front/listener, whose
// readback reports a reason constant and two numbers).
//
// This file is DELIBERATELY FREE OF BUILD TAGS. The outcome vocabulary, the
// error-code classification and the JSON shapes are the part of the instrument
// that can be wrong in a way a Windows-only test would find late, so they are a
// table test that runs on every platform, and the Windows file below is left
// with the system calls alone.
package main

import (
	"encoding/json"
	"fmt"
	"io"
)

// Exit codes. They are a CLOSED set and each one means exactly one thing to the
// CI step that reads it.
const (
	// exitOK is a measurement that came out as the caller said it must.
	exitOK = 0
	// exitMismatch is a measurement that came out OTHERWISE. It is the only
	// interesting failure: the JSON line on stdout says what actually happened.
	exitMismatch = 1
	// exitUnsupported is a run on a platform that has no named pipes. It is
	// distinct from every other code so "wrong platform" can never be read as
	// "the measurement broke", the same split cmd/spike-overlapped-stdio uses.
	exitUnsupported = 2
	// exitBroken is the INSTRUMENT failing: bad arguments, a pipe that could
	// not be created, a ready file that could not be written. It is not a
	// measurement at all.
	exitBroken = 3
)

// outcome is the CLOSED classification of one connect attempt. Every Windows
// error code that is not named below is `other`, and `other` always travels
// with the code itself so an unexpected result is diagnosable without a second
// run.
type outcome string

const (
	outcomeConnected    outcome = "connected"
	outcomeAccessDenied outcome = "access_denied"
	outcomeFileNotFound outcome = "file_not_found"
	outcomePipeBusy     outcome = "pipe_busy"
	outcomeOther        outcome = "other"
)

// The Windows error codes this instrument distinguishes. The values are READ
// FROM THE MACHINE ARTIFACT, not from convention: golang.org/x/sys/windows
// v0.10.0 - the version go-winio v0.6.2 requires and this module already
// carries - declares them in zerrors_windows.go as
//
//	ERROR_FILE_NOT_FOUND syscall.Errno = 2    (line 155)
//	ERROR_ACCESS_DENIED  syscall.Errno = 5    (line 158)
//	ERROR_PIPE_BUSY      syscall.Errno = 231  (line 332)
//
// They are restated here as plain numbers rather than imported so that the
// classifier - the part with the interesting logic - compiles and is tested on
// every platform. The table test pins each value against that citation.
const (
	errorFileNotFound uint32 = 2
	errorAccessDenied uint32 = 5
	errorPipeBusy     uint32 = 231
)

// classifyDialError maps a Win32 error code from CreateFile on a pipe path to
// the closed outcome set.
//
// ERROR_FILE_NOT_FOUND is the answer for a name NOBODY serves (go-winio's own
// TestDialUnknownFailsImmediately asserts exactly that, pipe_test.go:25-30), so
// it is kept distinct from a denial: "the pipe was not there" and "the pipe
// refused me" are different measurements and collapsing them would let a
// mistyped name pass for a proven denial.
func classifyDialError(code uint32) outcome {
	switch code {
	case errorAccessDenied:
		return outcomeAccessDenied
	case errorFileNotFound:
		return outcomeFileNotFound
	case errorPipeBusy:
		return outcomePipeBusy
	default:
		return outcomeOther
	}
}

// The two expectations `dial --expect` accepts. `denied` is spelled shorter
// than the outcome it requires because it is the CI step's word for the
// property being proven, and access denial is the ONLY denial that proves it: a
// dial that failed with "not found" or "busy" has proven nothing about the
// descriptor.
const (
	expectConnected = "connected"
	expectDenied    = "denied"
)

// requiredOutcome answers which outcome an --expect value demands.
//
//   - `assert` is false for an OMITTED expectation, which is the recording mode
//     item 3 of the 1.6 matrix needs: print what happened, exit 0, assert
//     nothing.
//   - `valid` is false for anything else, which is an instrument error and not a
//     failed measurement.
func requiredOutcome(expect string) (want outcome, assert bool, valid bool) {
	switch expect {
	case "":
		return "", false, true
	case expectConnected:
		return outcomeConnected, true, true
	case expectDenied:
		return outcomeAccessDenied, true, true
	default:
		return "", false, false
	}
}

// The access masks `dial --access` accepts.
//
// WHY READ-ONLY IS A MODE AND NOT A CURIOSITY. Endpoint contract 1.6 item 2
// asks what a second user's READ-ONLY connect does, because the DEFAULT
// Windows named-pipe descriptor grants Everyone read access while denying the
// duplex open: a cross-user read-only connect that consumes a pipe instance is
// a handshake-slot-exhaustion vector, and it is invisible to a duplex-only
// probe.
const (
	accessDuplex = "duplex"
	accessRead   = "read"
)

// The descriptors a serve run can be asked for. EVERY ONE BUT THE FIRST IS
// TEST ONLY, and every one of them is a flag on THIS instrument and never on
// the front: internal/front/listener compiles its descriptor in, precisely so
// that no caller can ask it for another one.
const (
	// descriptorFront is the real thing: listener.Bind, the front's compiled-in
	// descriptor, the front's readback.
	descriptorFront = "front"
	// descriptorWinioDefault is the CONTROL ARM for attributing a denial. A
	// temporary account denied by the front's pipe and ALSO denied by every
	// other pipe would have proven nothing about the front's descriptor - it
	// would have proven that the account cannot open pipes. This arm is the
	// descriptor a process that asks for nothing gets, which endpoint contract
	// 1.6 describes as granting Everyone READ access.
	descriptorWinioDefault = "winio-default"
	// descriptorOpen is the SQUATTER ARM: `D:P(A;;FA;;;WD)`, full access to
	// everyone.
	//
	// It is the accurate adversary, and that is why it is not the default arm.
	// A squatter who took the pipe name in order to be talked to WANTS the
	// victim to connect, so it grants everyone; a squatter whose descriptor
	// locked the victim out would defeat its own purpose. Item 7 of contract
	// 1.6 is about what the BRIDGE does when it reaches a foreign server, so
	// the measurement needs a foreign server the bridge can actually reach.
	descriptorOpen = "open"
)

// openDescriptorSDDL is descriptorOpen's descriptor: PROTECTED, one allow ACE,
// FILE_ALL_ACCESS to Everyone (`WD`, the SDDL alias for S-1-1-0). It is the
// same shape as go-winio's own restricted-descriptor test constant
// (pipe_test.go TestDialAccessDeniedWithRestrictedSD uses
// `D:P(A;;0x1200FF;;;WD)`), opened up instead of narrowed down.
const openDescriptorSDDL = "D:P(A;;FA;;;WD)"

// Impersonation levels, the enum SECURITY_IMPERSONATION_LEVEL. Values read from
// golang.org/x/sys/windows v0.10.0 security_windows.go lines 566-571
// (SecurityAnonymous 0, SecurityIdentification 1, SecurityImpersonation 2,
// SecurityDelegation 3); the Windows test pins the names against that package.
//
// THE ONE THAT MATTERS IS 1. The shipped bridge dials with
// SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION, so a server that impersonates
// the client must land on SecurityIdentification: it may learn who the client
// is and must not be able to act as it. Note that SecurityIdentification is 1
// and not 2 - the value 2 is TokenImpersonation, the token TYPE, a different
// enum in the same header.
const (
	impersonationAnonymous      uint32 = 0
	impersonationIdentification uint32 = 1
	impersonationImpersonation  uint32 = 2
	impersonationDelegation     uint32 = 3
)

// impersonationLevelName turns the measured enum into the word the job log
// carries, so a reader does not have to remember the header.
func impersonationLevelName(level uint32) string {
	switch level {
	case impersonationAnonymous:
		return "anonymous"
	case impersonationIdentification:
		return "identification"
	case impersonationImpersonation:
		return "impersonation"
	case impersonationDelegation:
		return "delegation"
	default:
		return "unknown"
	}
}

// readyReport is written to the --ready file, atomically, once the pipe exists
// and (for the front descriptor) has passed the front's own readback. Its
// arrival is the CI step's signal that dialling may start.
//
// The flag fields are POINTERS because the control arm has no flags to report:
// it does not run the front's readback, and a `false` there would be a claim
// rather than an absence.
type readyReport struct {
	Event         string `json:"event"`
	Descriptor    string `json:"descriptor"`
	Pid           int    `json:"pid"`
	FlagsApplied  *uint8 `json:"flagsApplied"`
	RejectRemote  *bool  `json:"rejectRemote"`
	FirstInstance *bool  `json:"firstInstance"`
	MessageMode   *bool  `json:"messageMode"`
}

// acceptedReport is one connection the serve loop took. The CLIENT PID is the
// evidence that a cross-user connect reached the accept loop at all - a number
// the reader can act on, and the same thing the front's own readback compares
// (listener.verifyProbePeer). No identity travels with it.
//
// ClientPidKnown is separate from a zero pid: GetNamedPipeClientProcessId can
// fail, and "we could not ask" is not "process 0". ImpersonationLevel is the
// measurement contract 1.6 item 8 asks for - what a server actually gets when
// it impersonates this client - and it is a NUMBER AND A WORD, never a SID:
// the whole point of the measurement is that the server can identify the
// client, so publishing that identity would be the one thing the report must
// not do.
type acceptedReport struct {
	Event                  string  `json:"event"`
	Count                  int     `json:"count"`
	ClientPid              uint32  `json:"clientPid"`
	ClientPidKnown         bool    `json:"clientPidKnown"`
	ImpersonationLevel     *uint32 `json:"impersonationLevel"`
	ImpersonationLevelName string  `json:"impersonationLevelName"`
}

// serveDoneReport closes a serve run: how many connections were accepted in
// total, which is what item 2 of the 1.6 matrix asks about a read-only
// cross-user connect.
type serveDoneReport struct {
	Event    string `json:"event"`
	Accepted int    `json:"accepted"`
	Overflow int    `json:"overflow"`
}

// dialReport is the whole result of one connect attempt.
//
// WindowsError is 0 for a connection that succeeded, and the raw code
// otherwise. BusyRetries records how many times the attempt was repeated
// because no pipe instance was free; it is reported rather than hidden so a
// measurement taken during a busy window is visible as such.
//
// EXPECT AND MATCH ARE OPTIONAL, and that is a deliberate second mode. Contract
// 1.6 item 3 - what Windows does with a connect arriving through the loopback
// REDIRECTOR path - is a question NOBODY IN THIS PROJECT HAS MEASURED, so the
// probe must be able to RECORD an outcome without asserting one. A recording
// run leaves `expect` empty and `match` null, and exits 0 whatever happened;
// inventing an expectation for an unmeasured question is how a guess becomes a
// green check.
type dialReport struct {
	Event        string  `json:"event"`
	Access       string  `json:"access"`
	Expect       string  `json:"expect"`
	Outcome      outcome `json:"outcome"`
	WindowsError uint32  `json:"windowsError"`
	BusyRetries  int     `json:"busyRetries"`
	Match        *bool   `json:"match"`
}

// brokenReport is the instrument saying it could not measure.
//
// The JSON key is `outcome` because that is what a reader of the job log wants
// to grep for on every line the probe prints, and its value is a CONSTANT of
// this file, never a system error string: a Windows error on a pipe path
// carries that path, and the path is not ours to print.
type brokenReport struct {
	Event   string `json:"event"`
	Outcome string `json:"outcome"`
}

// Reasons a run can be broken. Each is a constant, so the CI log carries a word
// that can be grepped rather than a sentence that can change.
// `bind_failed` in particular is the assertion of contract 1.6 item 7's first
// half: the front asked to serve a name a foreign account already serves must
// FAIL, and this is the line that says so.
const (
	reasonUsage           = "usage"
	reasonBindFailed      = "bind_failed"
	reasonReadbackFailed  = "readback_failed"
	reasonReadyWriteFail  = "ready_file_write_failed"
	reasonPipeNameInvalid = "pipe_name_invalid"
)

// impersonationUnmeasured is the level name reported when the impersonation
// measurement itself failed. It is not a level, and it is not silence.
const impersonationUnmeasured = "unmeasured"

// emit writes one JSON object followed by a newline. One object per line is the
// whole output contract: the CI step reads the last line of a redirected file
// and parses it, and a pretty-printed object would break that.
func emit(w io.Writer, v any) error {
	encoded, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s\n", encoded)
	return err
}

// emitBroken reports an instrument failure and returns the exit code for it, so
// every broken path is one line at the call site.
func emitBroken(w io.Writer, reason string) int {
	_ = emit(w, brokenReport{Event: "broken", Outcome: reason})
	return exitBroken
}
