//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
)

// THE CROSS-USER MEASUREMENT THE REST OF THIS SUITE CANNOT MAKE.
//
// hostauth_windows_test.go proves the SAME-USER path through the real syscalls
// and the refusal branches through the injected resolver seam, and says so
// plainly: "a pipe server owned by a genuinely different user cannot exist
// here". Contract 1.6 item 7 is exactly that missing case, and it needs a
// second account.
//
// The `bridge-windows` CI job now creates a temporary local account for the
// run, has it serve a pipe with cmd/probe-pipe-acl (whose `open` descriptor is
// the accurate squatter: an adversary who took the name in order to be talked
// to grants everyone access, because a squatter who locked the victim out would
// defeat its own purpose), and points this test at that pipe. Off that job the
// environment variable is absent and the test SKIPS with the reason, because a
// test that quietly passed without a foreign server would be the very claim
// this file exists to stop making.
//
// WHAT IT DRIVES: `dialPipe`, the production wiring - real CreateFile with the
// shipped SQOS flags, real GetNamedPipeServerProcessId, real OpenProcess, real
// token query, real SID comparison. No seam, no fake.
const foreignPipeEnv = "VEX_PROBE_FOREIGN_PIPE"

// A FOREIGN USER'S PIPE SERVER IS REFUSED, AND THE HANDSHAKE NEVER HAPPENS.
func TestHostAuthRefusesAForeignUsersServer(t *testing.T) {
	path := os.Getenv(foreignPipeEnv)
	if path == "" {
		t.Skipf("%s is not set: this measurement needs a named pipe served by a DIFFERENT local "+
			"user, which only the two-account step of the bridge-windows job provides. Contract "+
			"1.6 item 7 stays unproven by this run.", foreignPipeEnv)
	}

	conn, err := dialPipe(context.Background(), path)
	if conn != nil {
		_ = conn.Close()
	}
	if err == nil {
		t.Fatal("the bridge accepted a pipe server owned by another local user; host " +
			"authentication is the anti-squatting control and it did not refuse")
	}

	// A DENIAL BY THE OPERATING SYSTEM IS NOT A REFUSAL BY THIS CONTROL. If
	// CreateFile itself failed, the dial never reached the SID comparison, so
	// this run proves nothing about it - and saying so is the point of the
	// distinction. The step that sets up the foreign server grants everyone
	// access precisely so this branch does not happen.
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == syscall.ERROR_ACCESS_DENIED {
		t.Fatalf("the foreign pipe could not be opened at all (ERROR_ACCESS_DENIED), so host "+
			"authentication never ran; the %s server must grant this account access for the "+
			"measurement to mean anything", foreignPipeEnv)
	}

	refusal, ok := asLocalRefusal(err)
	if !ok {
		t.Fatalf("a foreign pipe server must produce a LOCAL refusal, so cmd/vex-mcp exits 2 "+
			"rather than 3; got %T", err)
	}
	message := refusal.Error()
	if !strings.Contains(message, hostAuthRefusalCode) {
		t.Fatalf("the refusal does not name its code %q", hostAuthRefusalCode)
	}
	if !strings.Contains(message, "does not run as this user") {
		t.Fatalf("the refusal is not the identity mismatch: %q", message)
	}

	// THE REFUSAL MUST NOT PUBLISH THE OTHER ACCOUNT. It learned that identity
	// incidentally; the sentence the user sees names a pid and nothing else.
	// Against a REAL foreign server this is a real assertion - the SID exists
	// and the code held it - where the single-account suite could only check a
	// literal it had made up itself.
	if strings.Contains(strings.ToUpper(message), "S-1-") {
		t.Fatalf("the refusal carries a SID; it must carry a pid and no identity: %q", message)
	}
}
