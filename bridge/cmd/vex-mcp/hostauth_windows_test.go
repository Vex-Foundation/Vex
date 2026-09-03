//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
)

// WHAT THESE TESTS CAN AND CANNOT PROVE.
//
// The `bridge-windows` CI job runs as ONE account, so a pipe server owned by a
// genuinely different user cannot exist here. The POSITIVE test therefore
// drives the real syscall chain end to end against a real in-test pipe server
// - GetNamedPipeServerProcessId, OpenProcess, the token query and the SID
// comparison - and the REFUSAL tests drive the branches through the injected
// resolver seam. The adversarial cross-user run is item 7 of contract section
// 1.6, happens on a two-account machine, and is not claimed by anything here.
//
// Test pipe servers are created with CreateNamedPipeW through the same
// kernel32 lazy DLL the production code uses; this module has no external
// dependencies, in tests either. The pattern - real pipe servers inside the
// test process rather than mocks - is go-winio's (pipe_test.go).

// Values verified in the installed go1.27.0 tree, at
// src/cmd/vendor/golang.org/x/sys/windows/types_windows.go lines 3472-3486.
const (
	pipeAccessDuplex        = 0x3
	pipeTypeByte            = 0x0
	pipeReadmodeByte        = 0x0
	pipeWaitMode            = 0x0
	pipeRejectRemoteClients = 0x8
)

// Errno values verified in the same tree, zerrors_windows.go (ERROR_BROKEN_PIPE
// 109, ERROR_PIPE_NOT_CONNECTED 233, ERROR_NO_DATA 232, ERROR_PIPE_LISTENING
// 536).
const (
	errorBrokenPipe       syscall.Errno = 109
	errorNoData           syscall.Errno = 232
	errorPipeNotConnected syscall.Errno = 233
	errorPipeListening    syscall.Errno = 536
)

var (
	procCreateNamedPipeW = modkernel32.NewProc("CreateNamedPipeW")
	testPipeCounter      atomic.Uint64
)

func testPipeName(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf(`\\.\pipe\vex-mcp-hostauth-%d-%d`, os.Getpid(), testPipeCounter.Add(1))
}

// newTestPipeServer creates one blocking, byte-mode, single-instance pipe
// server owned by this process and this user, and returns its handle.
func newTestPipeServer(t *testing.T, name string) syscall.Handle {
	t.Helper()
	name16, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		t.Fatalf("pipe name %q: %v", name, err)
	}
	if err := procCreateNamedPipeW.Find(); err != nil {
		t.Fatalf("CreateNamedPipeW is unavailable: %v", err)
	}
	r1, _, errno := syscall.SyscallN(procCreateNamedPipeW.Addr(),
		uintptr(unsafe.Pointer(name16)),
		uintptr(pipeAccessDuplex),
		uintptr(pipeTypeByte|pipeReadmodeByte|pipeWaitMode|pipeRejectRemoteClients),
		1,    // one instance: this test owns the name for its duration
		4096, // out buffer
		4096, // in buffer
		0,    // default timeout
		0,    // default security attributes: this user's default pipe DACL
	)
	handle := syscall.Handle(r1)
	if handle == syscall.InvalidHandle {
		t.Fatalf("CreateNamedPipeW(%s): %v", name, errno)
	}
	t.Cleanup(func() { _ = syscall.CloseHandle(handle) })
	return handle
}

// readOutcome is one bounded read on the server side of a test pipe.
type readOutcome struct {
	n   uint32
	err error
}

// serverRead reads once on the server handle, under a watchdog.
//
// The watchdog is not the proof of anything; it exists because the server
// handle is blocking, and a hung read must fail the test rather than hang the
// suite. The PROOF is the outcome: zero bytes plus a disconnect error.
func serverRead(t *testing.T, server syscall.Handle) readOutcome {
	t.Helper()
	done := make(chan readOutcome, 1)
	go func() {
		buffer := make([]byte, 64)
		var read uint32
		err := syscall.ReadFile(server, buffer, &read, nil)
		done <- readOutcome{n: read, err: err}
	}()
	select {
	case outcome := <-done:
		return outcome
	case <-time.After(10 * time.Second):
		t.Fatal("the server side of the test pipe neither received data nor saw the client " +
			"leave within 10s")
		return readOutcome{}
	}
}

// assertNothingWasWritten is the assertion the whole check exists for: the
// bridge refused, and the server saw a client arrive and leave WITHOUT a byte.
func assertNothingWasWritten(t *testing.T, server syscall.Handle) {
	t.Helper()
	outcome := serverRead(t, server)
	if outcome.n != 0 {
		t.Fatalf("the refused connection wrote %d bytes to the pipe server; the project id must "+
			"never leave the process on a refusal", outcome.n)
	}
	switch {
	case errors.Is(outcome.err, errorBrokenPipe),
		errors.Is(outcome.err, errorNoData),
		errors.Is(outcome.err, errorPipeNotConnected):
		// A client connected and went away without writing. That is the fact
		// under test.
	case errors.Is(outcome.err, errorPipeListening):
		t.Fatal("no client ever connected to the test pipe, so the test proved nothing about " +
			"what a refused dial writes")
	default:
		t.Fatalf("unexpected server-side read outcome: %v", outcome.err)
	}
}

func mustRefuse(t *testing.T, conn handshake.Conn, err error) *localRefusal {
	t.Helper()
	if err == nil {
		t.Fatal("the dial returned a usable connection where host authentication had to refuse")
	}
	refusal, ok := asLocalRefusal(err)
	if !ok {
		t.Fatalf("host authentication failed with %T (%v); it must be a local refusal so that "+
			"cmd/vex-mcp exits 2 rather than 3", err, err)
	}
	if conn != nil {
		t.Fatal("a refusing dial returned a non-nil connection")
	}
	if !strings.Contains(refusal.Error(), hostAuthRefusalCode) {
		t.Fatalf("the refusal does not name its code: %q", refusal.Error())
	}
	return refusal
}

// THE POSITIVE PATH, THROUGH THE REAL SYSCALLS. Production wiring, real pipe
// server, real GetNamedPipeServerProcessId, real token comparison.
func TestDialPipeAcceptsThisUsersPipeServer(t *testing.T) {
	name := testPipeName(t)
	server := newTestPipeServer(t, name)

	conn, err := dialPipe(name)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	defer conn.Close()

	// The connection is usable after authentication: one byte through it, seen
	// on the server side. A check that left a broken handle behind would pass
	// every assertion above and fail here.
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatalf("writing to the authenticated pipe failed: %v", err)
	}
	outcome := serverRead(t, server)
	if outcome.err != nil || outcome.n != 1 {
		t.Fatalf("the server read %d bytes, err %v; expected the one byte the client wrote",
			outcome.n, outcome.err)
	}
}

// THE REAL RESOLVERS ANSWER FOR THIS PROCESS. Same real chain as above, with
// the answers observed rather than only their verdict: the pid the kernel
// reports for the pipe server is this process, and the SID it resolves to is
// this process's own.
func TestResolveServerUserSIDIdentifiesThisProcess(t *testing.T) {
	name := testPipeName(t)
	newTestPipeServer(t, name)

	var observedPID uint32
	var observedSID string
	recording := func(pipe syscall.Handle) (uint32, string, error) {
		pid, sid, err := resolveServerUserSID(pipe)
		observedPID, observedSID = pid, sid
		return pid, sid, err
	}

	conn, err := dialPipeWith(name, recording, resolveCurrentUserSID)
	if err != nil {
		t.Fatalf("dialing this process's own pipe server was refused: %v", err)
	}
	defer conn.Close()

	if observedPID != uint32(os.Getpid()) {
		t.Fatalf("GetNamedPipeServerProcessId reported pid %d for a pipe served by pid %d",
			observedPID, os.Getpid())
	}
	current, err := resolveCurrentUserSID()
	if err != nil {
		t.Fatalf("resolving this process's user SID failed: %v", err)
	}
	if !strings.HasPrefix(current, "S-1-") {
		t.Fatalf("the current user SID is not in canonical string form: %q", current)
	}
	if observedSID != current {
		t.Fatalf("the pipe server's user SID %q differs from this process's %q, in one process",
			observedSID, current)
	}
}

// A DIFFERENT USER IS REFUSED, AND NOTHING IS WRITTEN.
func TestDialPipeRefusesAForeignUsersPipeServer(t *testing.T) {
	name := testPipeName(t)
	server := newTestPipeServer(t, name)

	const foreign = "S-1-5-21-1111111111-2222222222-3333333333-1001"
	conn, err := dialPipeWith(name,
		func(syscall.Handle) (uint32, string, error) { return 4242, foreign, nil },
		func() (string, error) { return "S-1-5-21-9-9-9-500", nil })
	refusal := mustRefuse(t, conn, err)

	if strings.Contains(refusal.Error(), foreign) {
		t.Fatalf("the refusal leaks the other user's identity: %q", refusal.Error())
	}
	if !strings.Contains(refusal.Error(), "4242") {
		t.Fatalf("the refusal does not name the server pid the user can act on: %q",
			refusal.Error())
	}
	assertNothingWasWritten(t, server)
}

// EVERY FAILURE ON THE WAY TO THE ANSWER IS A REFUSAL, and none of them
// writes.
func TestDialPipeRefusesWhenIdentityCannotBeEstablished(t *testing.T) {
	sameSID := func() (string, error) { return "S-1-5-21-9-9-9-500", nil }

	cases := []struct {
		name    string
		server  serverSIDResolver
		current userSIDResolver
	}{
		{
			name:    "the server process id or token cannot be read",
			server:  func(syscall.Handle) (uint32, string, error) { return 0, "", errors.New("boom") },
			current: sameSID,
		},
		{
			name:    "this process's own identity cannot be read",
			server:  func(syscall.Handle) (uint32, string, error) { return 7, "S-1-5-21-9-9-9-500", nil },
			current: func() (string, error) { return "", errors.New("boom") },
		},
		{
			name:    "the server SID came back empty",
			server:  func(syscall.Handle) (uint32, string, error) { return 7, "", nil },
			current: sameSID,
		},
		{
			name:    "both SIDs came back empty, which is not a match",
			server:  func(syscall.Handle) (uint32, string, error) { return 7, "", nil },
			current: func() (string, error) { return "", nil },
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			name := testPipeName(t)
			server := newTestPipeServer(t, name)
			conn, err := dialPipeWith(name, testCase.server, testCase.current)
			mustRefuse(t, conn, err)
			assertNothingWasWritten(t, server)
		})
	}
}

// WIRE NAMES AND CONSTANT VALUES COME FROM MACHINE ARTIFACTS, NOT FROM
// SPELLING. The procedure name is resolved against the running kernel32, and
// each locally declared constant is enumerated against the value cited beside
// its declaration.
func TestWindowsDialConstantsAndProcedureNames(t *testing.T) {
	if err := procGetNamedPipeServerProcessID.Find(); err != nil {
		t.Fatalf("kernel32!GetNamedPipeServerProcessId did not resolve: %v", err)
	}

	constants := []struct {
		name     string
		got      uintptr
		expected uintptr
		source   string
	}{
		{"PROCESS_QUERY_LIMITED_INFORMATION", processQueryLimitedInformation, 0x1000,
			"x/sys/windows types_windows.go"},
		{"SECURITY_SQOS_PRESENT", securitySQOSPresent, 0x00100000,
			"x/sys/windows types_windows.go / WinBase.h"},
		{"SECURITY_IDENTIFICATION", securityIdentification, 0x00010000,
			"SecurityIdentification(1) << 16"},
		{"PIPE_ACCESS_DUPLEX", pipeAccessDuplex, 0x3, "x/sys/windows types_windows.go"},
		{"PIPE_REJECT_REMOTE_CLIENTS", pipeRejectRemoteClients, 0x8,
			"x/sys/windows types_windows.go"},
		{"TOKEN_QUERY", syscall.TOKEN_QUERY, 0x8, "syscall/security_windows.go"},
		{"TokenUser", syscall.TokenUser, 1, "syscall/security_windows.go"},
	}
	for _, constant := range constants {
		if constant.got != constant.expected {
			t.Errorf("%s = %#x, want %#x (%s)", constant.name, constant.got, constant.expected,
				constant.source)
		}
	}
}
