//go:build windows

package listener

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync/atomic"
	"testing"
	"time"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
)

// THESE ARE THE PROOFS ONLY A WINDOWS RUNNER CAN GIVE, and they run on the
// REQUIRED `bridge-windows` job. Everything else about the front is proven on
// every platform, deliberately: this job is one runner and one account, and a
// suite that lived here would prove less, less often.
//
// The shapes follow go-winio's own suite (pipe_test.go): a restricted
// descriptor measured through a denied dial, a half-close measured through the
// EOF it produces, and a second listen measured through the collision it
// causes.

var pipeCounter atomic.Uint64

// uniquePipeName keeps parallel and repeated runs from colliding on a name the
// operating system holds for the life of a server.
func uniquePipeName(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf(`\\.\pipe\vex-pipe-front-test-%d-%d`, os.Getpid(), pipeCounter.Add(1))
}

func dialTimeout() *time.Duration {
	d := 5 * time.Second
	return &d
}

// THE PIPE THE FRONT CREATES SERVES THIS USER, and the flags BOUND reports are
// the ones the front READ BACK from the live handle.
func TestBindServesTheCurrentUserAndReportsVerifiedFlags(t *testing.T) {
	name := uniquePipeName(t)
	binding, err := Bind(name)
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	defer binding.Listener.Close()

	// firstInstance is the FILE_CREATE disposition having succeeded, and
	// messageMode is FATAL when unconfirmed, so both must be set here.
	if binding.FlagsApplied&frames.BoundFlagFirstInstance == 0 {
		t.Error("firstInstance must be reported for a pipe this process created")
	}
	if binding.FlagsApplied&frames.BoundFlagMessageMode == 0 {
		t.Error("messageMode must be confirmed; CloseWrite depends on it")
	}
	// Reject-remote has no documented readback. The front reports what it
	// CONFIRMED and main decides, so the test records the measurement rather
	// than asserting an operating-system fact nobody has documented.
	t.Logf("rejectRemote read back as %v (flagsApplied=0x%02x)",
		binding.FlagsApplied&frames.BoundFlagRejectRemote != 0, binding.FlagsApplied)
	if binding.FlagsApplied&^(frames.BoundFlagRejectRemote|frames.BoundFlagFirstInstance|frames.BoundFlagMessageMode) != 0 {
		t.Errorf("flagsApplied sets a reserved bit: 0x%02x", binding.FlagsApplied)
	}

	accepted := make(chan net.Conn, 1)
	failed := make(chan error, 1)
	go func() {
		conn, err := binding.Listener.Accept()
		if err != nil {
			failed <- err
			return
		}
		accepted <- conn
	}()

	client, err := winio.DialPipe(name, dialTimeout())
	if err != nil {
		t.Fatalf("a same-user dial must succeed against the front's descriptor: %v", err)
	}
	defer client.Close()

	select {
	case server := <-accepted:
		defer server.Close()
	case err := <-failed:
		t.Fatalf("Accept: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the front's listener never accepted the same-user dial")
	}
}

// FIRST-INSTANCE PROTECTION. go-winio creates the first handle with the
// FILE_CREATE disposition, which fails when the name already exists; that is
// the runtime fact behind the firstInstance flag, and this is what pins it.
func TestSecondBindOnTheSameNameFails(t *testing.T) {
	name := uniquePipeName(t)
	first, err := Bind(name)
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	defer first.Listener.Close()

	second, err := Bind(name)
	if err == nil {
		_ = second.Listener.Close()
		t.Fatal("a second listener on the same name must fail; the name is first-come")
	}
	var bindErr *BindError
	if !errors.As(err, &bindErr) {
		t.Fatalf("a collision is a bind failure, got %v", err)
	}
}

// THE DESCRIPTOR IS REALLY APPLIED BY THE OPERATING SYSTEM. This is go-winio's
// own TestDialAccessDeniedWithRestrictedSD shape: a descriptor that grants
// everyone read and synchronize but not write denies a duplex dial. Without
// this measurement, every other assertion about the DACL would be an assertion
// about a string nobody proved the kernel honours.
func TestRestrictedDescriptorDeniesADuplexDial(t *testing.T) {
	name := uniquePipeName(t)
	l, err := winio.ListenPipe(name, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;0x1200FF;;;WD)",
		MessageMode:        true,
	})
	if err != nil {
		t.Fatalf("ListenPipe: %v", err)
	}
	defer l.Close()

	_, err = winio.DialPipe(name, dialTimeout())
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("expected ERROR_ACCESS_DENIED, got %v", err)
	}
}

// THE READBACK IS A REAL CHECK. A pipe created with the DEFAULT descriptor -
// which is what libuv produces, and the reason the Windows transport gate is
// closed at all - must FAIL the front's verification rather than pass it.
func TestVerifyDescriptorRejectsTheDefaultPipeDescriptor(t *testing.T) {
	name := uniquePipeName(t)
	l, err := winio.ListenPipe(name, &winio.PipeConfig{MessageMode: true})
	if err != nil {
		t.Fatalf("ListenPipe: %v", err)
	}
	defer l.Close()

	server, client := connectBoth(t, l, name)
	defer server.Close()
	defer client.Close()

	handled, ok := server.(interface{ Fd() uintptr })
	if !ok {
		t.Fatal("go-winio's pipe connection must expose its handle through Fd")
	}
	user, err := currentUserSID()
	if err != nil {
		t.Fatalf("currentUserSID: %v", err)
	}
	err = verifyDescriptor(windows.Handle(handled.Fd()), user)
	if err == nil {
		t.Fatal("the DEFAULT pipe descriptor must not pass the front's verification")
	}
	var readback *ReadbackError
	if !errors.As(err, &readback) {
		t.Fatalf("expected a ReadbackError, got %v", err)
	}
	t.Logf("the default descriptor is refused with reason %q", readback.Reason)
}

// THE FRONT'S OWN DESCRIPTOR PASSES ITS OWN VERIFICATION, which is the other
// half of the test above: a check that refused everything would be as useless
// as one that accepted everything.
func TestVerifyDescriptorAcceptsTheDescriptorTheFrontAsksFor(t *testing.T) {
	name := uniquePipeName(t)
	binding, err := Bind(name)
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	defer binding.Listener.Close()

	server, client := connectBoth(t, binding.Listener, name)
	defer server.Close()
	defer client.Close()

	handled := server.(interface{ Fd() uintptr })
	user, err := currentUserSID()
	if err != nil {
		t.Fatalf("currentUserSID: %v", err)
	}
	if err := verifyDescriptor(windows.Handle(handled.Fd()), user); err != nil {
		t.Fatalf("the front's own descriptor must pass its own readback: %v", err)
	}
}

// MESSAGE MODE IS WHAT MAKES THE HALF-CLOSE REAL. CloseWrite is a zero-byte
// write, and only a message-mode pipe delivers it to the reader as EOF. The
// READABLE side stays open, which is the property endpoint contract 3.2 says
// breaks every one-shot session when it is lost.
func TestMessageModeHalfCloseGivesEOFAndKeepsTheOtherDirectionOpen(t *testing.T) {
	name := uniquePipeName(t)
	binding, err := Bind(name)
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	defer binding.Listener.Close()

	server, client := connectBoth(t, binding.Listener, name)
	defer server.Close()
	defer client.Close()

	closer, ok := client.(interface{ CloseWrite() error })
	if !ok {
		t.Fatal("a message-mode pipe connection must offer CloseWrite")
	}
	if err := closer.CloseWrite(); err != nil {
		t.Fatalf("CloseWrite: %v", err)
	}

	buf := make([]byte, 16)
	if _, err := server.Read(buf); !errors.Is(err, io.EOF) {
		t.Fatalf("the peer's half-close must arrive as EOF, got %v", err)
	}
	// The answer still goes out after the peer has stopped asking.
	answer := []byte("the last response\n")
	if _, err := server.Write(answer); err != nil {
		t.Fatalf("the writable side must survive the peer's half-close: %v", err)
	}
	got := make([]byte, len(answer))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("reading the answer: %v", err)
	}
	if string(got) != string(answer) {
		t.Fatalf("got %q, want %q", got, answer)
	}
}

// connectBoth accepts one connection and dials it, returning both ends.
func connectBoth(t *testing.T, l net.Listener, name string) (server net.Conn, client net.Conn) {
	t.Helper()
	accepted := make(chan net.Conn, 1)
	failed := make(chan error, 1)
	go func() {
		conn, err := l.Accept()
		if err != nil {
			failed <- err
			return
		}
		accepted <- conn
	}()
	client, err := winio.DialPipe(name, dialTimeout())
	if err != nil {
		t.Fatalf("DialPipe: %v", err)
	}
	select {
	case server = <-accepted:
		return server, client
	case err := <-failed:
		_ = client.Close()
		t.Fatalf("Accept: %v", err)
	case <-time.After(5 * time.Second):
		_ = client.Close()
		t.Fatal("Accept never completed")
	}
	return nil, nil
}
