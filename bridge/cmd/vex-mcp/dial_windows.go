//go:build windows

package main

import (
	"os"
	"syscall"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
)

// Impersonation-level flags for CreateFile, absent from stdlib `syscall`.
// Values and spelling match golang.org/x/sys/windows and WinBase.h.
const (
	securitySQOSPresent    = 0x00100000 // SECURITY_SQOS_PRESENT
	securityIdentification = 0x00010000 // SECURITY_IDENTIFICATION (SecurityIdentification << 16)
)

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
// stdlib `syscall` does not export them and this module deliberately has no
// dependencies.
//
// NECESSARY, NOT SUFFICIENT. SQOS bounds what a hostile server can do with
// our token; it does not tell us WHO the server is. The load-bearing
// anti-squatting control is HOST AUTHENTICATION - GetNamedPipeServerProcessId
// followed by a comparison of the server process token's SID against the
// current user's, or an equivalent reviewed mechanism - and it is NOT
// IMPLEMENTED HERE. It is Windows-runtime code that cannot be exercised on
// the Linux development and CI hosts, and the transport is runtime-disabled,
// so it is named as a REQUIRED-BEFORE-FLIP item in contract section 1.6
// rather than written blind. Do not flip endpoint.WindowsTransportProven
// until that check exists and its test runs on the `bridge-windows` job.
//
// NONE OF THIS IS PROVEN ON A RUNNER YET. endpoint.WindowsTransportProven is
// false, so this function is unreachable at runtime; the `bridge-windows` CI
// job compiles it, and the contract's section 1.6 matrix is what must run
// before the flag flips.
func dialPipe(path string) (handshake.Conn, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	handle, err := syscall.CreateFile(
		name,
		syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		0,   // no sharing: this is a client handle to one pipe instance
		nil, // default security attributes; the handle is not inherited
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OVERLAPPED|securitySQOSPresent|securityIdentification,
		0,
	)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(handle), path), nil
}
