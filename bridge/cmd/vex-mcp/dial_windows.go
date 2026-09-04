//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
)

// WindowsDialTimeout bounds the whole CreateFile attempt, including every
// ERROR_PIPE_BUSY retry below.
//
// WHY A BOUND EXISTS AT ALL. CreateFile against a named pipe whose every
// instance is busy returns ERROR_PIPE_BUSY immediately, so a client that wants
// to wait must loop - and a loop without a deadline is an unbounded wait
// inside somebody else's budget. Claude Code kills an MCP server that has not
// come up within MCP_TIMEOUT (default 30 s), and a bridge that spent that
// budget inside an open() reports nothing at all: the user sees "connection
// timeout" with no cause, which is exactly the 2026-09-04 incident's shape.
//
// WHY FOUR SECONDS. The unix side bounds its connect at endpoint.DialTimeout
// = 2 s. Windows is given twice that for one measured reason: the server here
// is not a kernel socket backlog but the vex-pipe-front CHILD PROCESS, which
// must post a fresh pipe instance through its accept loop after each
// connection, so a burst of clients can find every instance busy for a
// scheduling quantum that unix never spends. Four seconds is far longer than
// that and still leaves at least 20 s of a default 30 s client budget for the
// 5 s handshake ack and the first tools/list, which is the request this
// connection actually exists to answer.
//
// It is NOT a retry (main.go's "NO RETRY, anywhere"): one dial, one deadline,
// one sentence. The ERROR_PIPE_BUSY loop is the documented way to wait for an
// instance of a pipe that IS there, which is what go-winio's tryDialPipe
// (agents-colab/go-winio/pipe.go) does under its own context deadline.
const WindowsDialTimeout = 4 * time.Second

// pipeBusyRetryInterval is the pause between ERROR_PIPE_BUSY attempts, the
// same 10 ms go-winio's tryDialPipe uses. It is a poll rather than
// WaitNamedPipe because the standard library exposes no WaitNamedPipe and this
// binary links nothing beyond it (cmd/vex-pipe-front/imports_test.go).
const pipeBusyRetryInterval = 10 * time.Millisecond

// dialTimeoutRefusalCode names the bound in the sentence, so a support
// transcript can match the message back to this rule.
const dialTimeoutRefusalCode = "windows_pipe_busy_timeout"

// Impersonation-level flags for CreateFile, absent from stdlib `syscall`.
// Values and spelling match golang.org/x/sys/windows and WinBase.h.
const (
	securitySQOSPresent    = 0x00100000 // SECURITY_SQOS_PRESENT
	securityIdentification = 0x00010000 // SECURITY_IDENTIFICATION (SecurityIdentification << 16)
)

// errorPipeBusy is ERROR_PIPE_BUSY (winerror.h, 231): "All pipe instances are
// busy." CreateFile returns it when the pipe NAME exists and every instance
// the server has posted is already connected, which is the one dial failure a
// client is meant to wait out rather than report.
//
// DEFINED LOCALLY for the same reason the SQOS flags above are: stdlib
// `syscall` does not export it on windows (verified against the installed
// go1.27.0 tree), and this binary deliberately links no third-party package.
// The value is the one golang.org/x/sys/windows and go-winio carry.
const errorPipeBusy = syscall.Errno(231)

// dialPipe opens the Vex Studio named pipe for OVERLAPPED (asynchronous) I/O.
//
// WHY NOT os.OpenFile(path, os.O_RDWR, 0). That is CreateFile WITHOUT
// FILE_FLAG_OVERLAPPED, which yields a SYNCHRONOUS handle: the Windows I/O
// manager serializes every operation on it, so a pending read blocks the next
// write on the same handle. The relay reads and writes CONCURRENTLY from two
// goroutines, which is precisely the pattern a synchronous handle deadlocks.
// The blocking handle also cannot carry a deadline, so the handshake's ack
// bound degraded to the close-the-handle watchdog.
//
// MICROSOFT: CreateFile's FILE_FLAG_OVERLAPPED - "the file or device is being
// opened or created for asynchronous I/O ... operations being performed on the
// file or device can complete concurrently"
// (learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew).
//
// GO SUPPORT, VERIFIED against the INSTALLED go1.27.0 source rather than
// remembered:
//   - src/os/file_windows.go, newFile: for kindNewFile it calls
//     internal/syscall/windows.IsNonblock(h) and passes the result as
//     `nonBlocking` to pfd.Init. IsNonblock asks NtQueryInformationFile for
//     FileModeInformation and reports true when neither
//     FILE_SYNCHRONOUS_IO_ALERT nor FILE_SYNCHRONOUS_IO_NONALERT is set -
//     which is exactly what FILE_FLAG_OVERLAPPED produces.
//   - src/internal/poll/fd_windows.go, FD.Init: with pollable=true it
//     associates the handle with the runtime poller ("It is safe to add
//     overlapped handles that also perform I/O outside of the runtime
//     poller"), sets fd.associated and the completion-notification modes.
//   - src/internal/poll/fd_poll_runtime.go, setDeadlineImpl: returns
//     ErrNoDeadline only when pd.runtimeCtx == 0, i.e. only for a handle the
//     poller did NOT take. An overlapped handle registered above therefore
//     honours SetDeadline.
//
// So os.NewFile is the supported way to hand an overlapped handle to the
// runtime poller in go1.27, and no golang.org/x/sys dependency is needed.
//
// SQOS: THE SERVER MAY IDENTIFY US, NOT ACT AS US.
//
// The pipe name is derived from a hash of the config directory and is
// therefore PREDICTABLE (endpoint.PipeName). A named pipe is first-come:
// whoever creates the name first owns it, so another user on the machine can
// create `\\.\pipe\vex-studio-<hash>` before Vex does and be the server this
// client connects to. Without an explicit security quality of service, a
// CreateFile client handle to a pipe grants the server IMPERSONATION, which
// lets that squatting server act with this user's token.
//
// SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION caps the server at the
// IDENTIFICATION level: it may obtain this client's identity and privileges
// for an access check, and may not impersonate the client.
//
// MICROSOFT: CreateFile's dwFlagsAndAttributes documents SECURITY_SQOS_PRESENT
// as the flag that makes the SECURITY_* impersonation values effective, and
// SECURITY_IDENTIFICATION as "the server process can obtain information about
// the client, such as security identifiers and privileges, but it cannot
// impersonate the client"
// (learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew,
// "Impersonation Levels"). The values are the ones the Go project itself
// carries in golang.org/x/sys/windows (types_windows.go: SECURITY_SQOS_PRESENT
// = 0x100000, SECURITY_IDENTIFICATION = SecurityIdentification << 16 with
// SecurityIdentification = 1, i.e. 0x10000), verified in the vendored copy
// inside the installed go1.27.0 tree. They are DEFINED LOCALLY below because
// stdlib `syscall` does not export them and THIS BINARY deliberately links no
// third-party package. The claim is now binary-level rather than module-level:
// the module requires go-winio and golang.org/x/sys for the packaged
// `vex-pipe-front`, and `bridge/cmd/vex-pipe-front/imports_test.go` holds
// `vex-mcp` to the standard library plus this module on every release target.
//
// NECESSARY, NOT SUFFICIENT. SQOS bounds what a hostile server can do with
// our token; it does not tell us WHO the server is. The load-bearing
// anti-squatting control is HOST AUTHENTICATION - GetNamedPipeServerProcessId
// followed by a comparison of the server process token's user SID against
// this process's - and it now runs HERE, in dialPipeWith, between CreateFile
// returning a handle and that handle becoming a Conn the handshake could
// write to. Its rationale, its citations and its limits live in
// hostauth_windows.go.
//
// MEASURED ON A RUNNER, AND REACHED AT RUNTIME. endpoint.WindowsTransportProven
// is true, so this is the production dial. The `bridge-windows` job proves it
// on a real pipe rather than by construction: rows 5 and 6 of the contract's
// 1.6 matrix (run 33663385959) drive this handle's overlapped duplex, its
// deadlines and its close cancellation from dial_windows_test.go, and row 7
// (run 33646484002) drives this exact path against a pipe served by a temporary
// SECOND local account the job creates, where the host authentication below
// refuses with `windows_host_not_current_user` and no byte is written.
func dialPipe(path string) (handshake.Conn, error) {
	return dialPipeWith(path, resolveServerUserSID, resolveCurrentUserSID)
}

// dialPipeWith is dialPipe with its identity sources injected, so the refusal
// branches can be driven deterministically on a single-account runner. The
// production call above is the only non-test caller.
func dialPipeWith(path string, server serverSIDResolver, current userSIDResolver) (handshake.Conn, error) {
	return dialPipeWithin(path, WindowsDialTimeout, server, current)
}

// dialPipeWithin is dialPipeWith with the bound injected, so the deadline
// branch is driven in milliseconds rather than in four real seconds.
func dialPipeWithin(
	path string,
	budget time.Duration,
	server serverSIDResolver,
	current userSIDResolver,
) (handshake.Conn, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	handle, err := createPipeHandleWithin(name, budget)
	if err != nil {
		if _, busy := asDialTimeout(err); busy {
			return nil, err
		}
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	// BEFORE os.NewFile, therefore before any caller can hold something
	// writable: on refusal the raw handle is closed here and nothing this
	// process knows - the project id above all - has reached the pipe.
	if refusal := authenticatePipeHost(handle, path, server, current); refusal != nil {
		_ = syscall.CloseHandle(handle)
		return nil, refusal
	}
	return os.NewFile(uintptr(handle), path), nil
}

// createPipeHandleWithin opens the pipe, waiting out ERROR_PIPE_BUSY until the
// deadline.
//
// THE SHAPE IS go-winio's tryDialPipe (agents-colab/go-winio/pipe.go line
// 207), written against the standard library because this binary links nothing
// else: attempt, return on success, return on any error that is not
// ERROR_PIPE_BUSY, otherwise sleep a fixed interval and attempt again while
// there is budget left. The deadline is checked BEFORE each attempt and after
// each sleep, so the loop cannot overrun it by a whole interval.
//
// Exhaustion is a dialTimeout, which carries its own sentence; every other
// failure is the operating system's and keeps its errno so dialSentence can
// name ENOENT and the rest.
func createPipeHandleWithin(name *uint16, budget time.Duration) (syscall.Handle, error) {
	deadline := time.Now().Add(budget)
	attempts := 0
	for {
		handle, err := syscall.CreateFile(
			name,
			syscall.GENERIC_READ|syscall.GENERIC_WRITE,
			0,   // no sharing: this is a client handle to one pipe instance
			nil, // default security attributes; the handle is not inherited
			syscall.OPEN_EXISTING,
			syscall.FILE_FLAG_OVERLAPPED|securitySQOSPresent|securityIdentification,
			0,
		)
		attempts++
		if err == nil {
			return handle, nil
		}
		if !errors.Is(err, errorPipeBusy) {
			return syscall.InvalidHandle, err
		}
		if !time.Now().Add(pipeBusyRetryInterval).Before(deadline) {
			return syscall.InvalidHandle, &dialTimeout{message: fmt.Sprintf(
				"%s: every instance of the Vex Studio named pipe was busy for %s "+
					"(%d attempts), so the Vex Studio bridge stopped without sending "+
					"anything. Vex is running but its pipe front is not accepting new "+
					"connections; close some Vex Studio MCP connections, or restart Vex, "+
					"and connect again.",
				dialTimeoutRefusalCode, budget, attempts)}
		}
		time.Sleep(pipeBusyRetryInterval)
	}
}
