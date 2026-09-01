//go:build windows

package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"

	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
)

// HOST AUTHENTICATION FOR THE WINDOWS NAMED-PIPE TRANSPORT (contract 1.6).
//
// THE THREAT. The pipe name is a hash of the config directory
// (endpoint.PipeName) and is therefore PREDICTABLE, and the Windows pipe
// namespace is first-come: any local user may create
// `\\.\pipe\vex-studio-<hash>` before Vex does and become the server this
// bridge connects to. CreateFile succeeding proves only that SOMETHING owns
// that name. SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION (dial_windows.go)
// bounds what such a squatter can do with our token; it does not answer WHO
// the server is, and the very first byte the bridge would otherwise send is
// the handshake carrying the project id.
//
// THE CONTROL. Before any byte leaves this process, ask the kernel which
// process serves the connected pipe, open that process's token, and compare
// its user SID with this process's user SID. Anything other than an exact
// match - including every failure on the way to the answer - closes the
// handle and refuses locally.
//
// WHAT IT DOES NOT PROVE. Same-user is the boundary Windows can enforce on a
// shared machine; it does not distinguish Vex from another program running as
// the same user, which is out of scope for a boundary whose whole subject is
// the OTHER user. And this code has never been exercised against a REAL
// second local user: the `bridge-windows` CI job runs one account, so the
// cross-user refusal is proven here only through the injected resolver seam.
// The real two-account run is item 7 of the contract's 1.6 matrix and has not
// happened; that gap is why endpoint.WindowsTransportProven stays false.
//
// WIRE NAMES AND VALUES, verified against the INSTALLED go1.27.0 tree rather
// than remembered:
//   - GetNamedPipeServerProcessId, kernel32, `(pipe Handle,
//     serverProcessID *uint32) (err error)` with the r1 == 0 failure
//     convention: src/cmd/vendor/golang.org/x/sys/windows/syscall_windows.go
//     line 172 (the //sys declaration) and zsyscall_windows.go line 2563 (the
//     generated body, and the modkernel32.NewProc name at line 295).
//   - PROCESS_QUERY_LIMITED_INFORMATION = 0x1000:
//     src/cmd/vendor/golang.org/x/sys/windows/types_windows.go line 200.
//
// Everything else on this path is stdlib `syscall`, which already exports
// OpenProcess, OpenProcessToken, TOKEN_QUERY, GetTokenInformation (through
// Token.GetTokenUser, which asks for the TokenUser class) and SID.String().
// This module deliberately has no external dependencies, so the two names
// above are the only ones declared locally.

// processQueryLimitedInformation is PROCESS_QUERY_LIMITED_INFORMATION, the
// least authority that permits OpenProcessToken on another process: it is
// granted for processes this user owns without asking for the broader
// PROCESS_QUERY_INFORMATION. Absent from stdlib `syscall`; see the citation
// above.
const processQueryLimitedInformation = 0x1000

// hostAuthRefusalCode is the local refusal this check emits. It joins the
// endpoint package's local-refusal vocabulary in spirit but is owned here,
// because it is the only refusal that can be decided after CreateFile has
// already returned a handle.
const hostAuthRefusalCode = "windows_host_not_current_user"

var (
	modkernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procGetNamedPipeServerProcessID = modkernel32.NewProc("GetNamedPipeServerProcessId")
)

// serverSIDResolver answers "which user runs the process serving this pipe",
// returning the server's pid (safe to report: a number, not an identity) and
// its user SID in canonical string form.
//
// It is a seam so the refusal paths can be driven in a test on a
// single-account CI runner, where a genuinely foreign server cannot exist.
type serverSIDResolver func(pipe syscall.Handle) (pid uint32, sid string, err error)

// userSIDResolver answers "which user runs THIS process".
type userSIDResolver func() (sid string, err error)

// authenticatePipeHost is the whole decision, kept free of syscalls so that
// the comparison itself is testable everywhere.
//
// SIDs are compared in their canonical string form (ConvertSidToStringSid,
// reached through syscall.SID.String). That form encodes the revision, the
// identifier authority and every sub-authority, so two SIDs are equal exactly
// when their strings are - the same equality go-winio's own account lookups
// rely on when they round-trip SIDs as strings.
//
// EVERY failure is a refusal. A SID we could not obtain is not a SID that
// matched.
func authenticatePipeHost(pipe syscall.Handle, path string, server serverSIDResolver, current userSIDResolver) error {
	pid, serverSID, err := server(pipe)
	if err != nil {
		return &localRefusal{message: fmt.Sprintf(
			"%s: Vex cannot tell which user runs the process serving the named pipe %s: %s. "+
				"The Vex Studio bridge sent nothing and stopped.",
			hostAuthRefusalCode, path, handshake.Diagnostic(err.Error()))}
	}
	ourSID, err := current()
	if err != nil {
		return &localRefusal{message: fmt.Sprintf(
			"%s: Vex cannot read its own user identity to check the process serving the named "+
				"pipe %s: %s. The Vex Studio bridge sent nothing and stopped.",
			hostAuthRefusalCode, path, handshake.Diagnostic(err.Error()))}
	}
	if serverSID == "" || ourSID == "" || serverSID != ourSID {
		// The foreign owner's identity is NOT reported: it is another user's
		// name, and this process learned it only incidentally. The pid is a
		// number the user can act on with Task Manager.
		return &localRefusal{message: fmt.Sprintf(
			"%s: the process serving the named pipe %s (pid %d) does not run as this user, so it "+
				"is not this user's Vex. The Vex Studio bridge sent nothing and stopped. Close the "+
				"other process holding that pipe name, or sign in as the user running Vex, and try "+
				"again.",
			hostAuthRefusalCode, path, pid)}
	}
	return nil
}

// resolveServerUserSID is the production wiring of serverSIDResolver.
func resolveServerUserSID(pipe syscall.Handle) (uint32, string, error) {
	// Find before Addr: LazyProc.Addr PANICS when the procedure is missing,
	// and a panic is not a refusal. An absent GetNamedPipeServerProcessId is
	// reported as the failure it is and fails closed with everything else.
	if err := procGetNamedPipeServerProcessID.Find(); err != nil {
		return 0, "", fmt.Errorf("GetNamedPipeServerProcessId is unavailable: %w", err)
	}
	var pid uint32
	r1, _, errno := syscall.SyscallN(procGetNamedPipeServerProcessID.Addr(),
		uintptr(pipe), uintptr(unsafe.Pointer(&pid)))
	if r1 == 0 {
		return 0, "", fmt.Errorf("GetNamedPipeServerProcessId: %w", errnoOrUnknown(errno))
	}
	process, err := syscall.OpenProcess(processQueryLimitedInformation, false, pid)
	if err != nil {
		return pid, "", fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	// The query-only process handle is owned here and released on every path.
	defer syscall.CloseHandle(process)
	sid, err := processUserSID(process)
	if err != nil {
		return pid, "", err
	}
	return pid, sid, nil
}

// resolveCurrentUserSID is the production wiring of userSIDResolver.
//
// The PROCESS token, deliberately, not the thread token: an impersonating
// thread would answer for whoever it impersonates, and the question here is
// which user this program runs as.
func resolveCurrentUserSID() (string, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", fmt.Errorf("OpenProcessToken(current): %w", err)
	}
	// The token is owned here and closed on every path.
	defer token.Close()
	return tokenUserSID(token)
}

func processUserSID(process syscall.Handle) (string, error) {
	var token syscall.Token
	if err := syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token); err != nil {
		return "", fmt.Errorf("OpenProcessToken: %w", err)
	}
	// The token is owned here and closed on every path.
	defer token.Close()
	return tokenUserSID(token)
}

func tokenUserSID(token syscall.Token) (string, error) {
	user, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("GetTokenInformation(TokenUser): %w", err)
	}
	if user == nil || user.User.Sid == nil {
		return "", errors.New("GetTokenInformation(TokenUser) returned no user SID")
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return "", fmt.Errorf("ConvertSidToStringSid: %w", err)
	}
	return sid, nil
}

// errnoOrUnknown keeps a zero Errno from being reported as "success".
//
// SyscallN always returns an Errno; only a non-zero one carries a reason, and
// a Win32 function that fails without calling SetLastError leaves zero
// behind.
func errnoOrUnknown(errno syscall.Errno) error {
	if errno == 0 {
		return errors.New("the call failed and set no error code")
	}
	return errno
}
