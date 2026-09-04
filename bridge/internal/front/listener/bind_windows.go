//go:build windows

package listener

import (
	"fmt"
	"net"
	"time"
	"unsafe"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
)

// THE PIPE, ITS DESCRIPTOR, AND WHY THE FRONT READS IT BACK.
//
// `sddlKind = 1` (protocol section 5.1 and 13) names ONE policy and main can
// name no other: "a PROTECTED allow-list containing only the current user's SID
// and SYSTEM allow ACEs. NO Everyone-deny ACE." The descriptor itself is
// compiled in HERE, where it can be reviewed and tested, because a main process
// that could hand the front an arbitrary security descriptor would be a
// privileged sink fed from a string.
//
// NO DENY ACE, and it is not an oversight. An allow-list already denies
// everyone it does not name, and a PROTECTED descriptor stops inheritance from
// adding anyone, while a deny ACE sorted ahead of the allows can deny the owner
// through a group membership nobody predicted.
//
// WHY `SY` AND NOT LookupSidByName("SYSTEM"). go-winio's own helper resolves
// account NAMES (sd.go:56-116), and account names are LOCALIZED: the machine
// account that is "SYSTEM" on an English install is "SYSTEM" spelled otherwise
// on many others, and a lookup that fails there would take the whole front down
// on a correct machine. `SY` is an SDDL alias for S-1-5-18 and is
// locale-independent, so the descriptor is built from the process token's user
// SID (the reviewed pattern of cmd/vex-mcp/hostauth_windows.go) plus that
// alias. The readback below compares against S-1-5-18 directly, so nothing in
// this path depends on a display name.
//
// WHY `FA` AND NOT `GA`. GENERIC_ALL is a mask the kernel MAPS to specific
// rights when it stores the ACE, so a descriptor written with GA never reads
// back as GA. FA is FILE_ALL_ACCESS, the mapped value itself, which makes the
// readback a comparison and not a translation.

// fileAllAccess is FILE_ALL_ACCESS, what the SDDL abbreviation `FA` denotes:
// STANDARD_RIGHTS_ALL | FILE_* specific rights. It is the mask an allow ACE
// written with `FA` carries when it is read back.
const fileAllAccess uint32 = 0x1F01FF

// genericAll is GENERIC_ALL. It is ACCEPTED by the readback as well as
// fileAllAccess: a descriptor is not weaker for carrying the unmapped form, and
// refusing it would make the front's start depend on a mapping detail rather
// than on who is allowed in.
const genericAll uint32 = 0x10000000

// pipeBufferBytes is the explicit input and output buffer size requested for
// every instance. It is the per-connection flow-control window, so the
// operating system's own buffering can never be larger than the window that
// bounds what either side may have outstanding.
const pipeBufferBytes = 65536

// probeTimeout bounds the self-connect the readback needs. The pipe is local
// and the peer is this process; anything slower is a failure, not a delay.
const probeTimeout = 2 * time.Second

// Bind creates the named pipe main told the front to serve, verifies it at
// runtime, and returns it with the flags it could CONFIRM.
//
// THE PIPE NAME COMES FROM HELLO, VERBATIM. The front never derives it: the
// derivation is the endpoint contract's section 1.2 and it belongs to main, two
// derivations are two sources of truth, and the front does not have main's
// config directory.
func Bind(pipeName string) (*Binding, error) {
	user, err := currentUserSID()
	if err != nil {
		return nil, &BindError{Err: err}
	}
	sddl := fmt.Sprintf("D:P(A;;FA;;;%s)(A;;FA;;;SY)", user.String())

	// go-winio's first instance is created by NtCreateNamedPipeFile with the
	// FILE_CREATE disposition (pipe.go:378-386), which fails with
	// STATUS_OBJECT_NAME_COLLISION when the name already exists. So ListenPipe
	// RETURNING is itself the runtime fact behind the firstInstance flag: this
	// process created the pipe and did not join somebody else's. That is also
	// why go-winio does not use FILE_FLAG_FIRST_PIPE_INSTANCE - it defines the
	// constant and never uses it.
	//
	// FILE_PIPE_REJECT_REMOTE_CLIENTS is set UNCONDITIONALLY by go-winio
	// (pipe.go:373-376); it is still reported only if the readback confirms it.
	l, err := winio.ListenPipe(pipeName, &winio.PipeConfig{
		SecurityDescriptor: sddl,
		// MessageMode is REQUIRED, not preferred: CloseWrite exists only for
		// message-mode pipes, and CloseWrite is the half-close the relay's
		// END depends on.
		MessageMode:      true,
		InputBufferSize:  pipeBufferBytes,
		OutputBufferSize: pipeBufferBytes,
	})
	if err != nil {
		return nil, &BindError{Err: err}
	}

	flags, err := readBackBinding(l, pipeName, user)
	if err != nil {
		_ = l.Close()
		return nil, err
	}
	return &Binding{Listener: l, FlagsApplied: flags}, nil
}

// readBackBinding obtains a real handle to the pipe that was just created and
// reads its properties back from the operating system.
//
// WHY A SELF-CONNECT. go-winio's listener keeps its first handle private and
// creates an instance only when Accept is called, so there is no handle to
// interrogate until somebody connects. The front therefore connects to ITSELF
// once, before it announces anything: BOUND has not been written, main has told
// nobody the pipe exists, and the probe closes both ends before the real accept
// loop starts. BOTH halves must succeed - if something else took the instance,
// the dial fails and the front refuses to serve rather than reporting flags it
// read from a stranger's connection.
func readBackBinding(l net.Listener, pipeName string, user *windows.SID) (uint8, error) {
	type accepted struct {
		conn net.Conn
		err  error
	}
	accepts := make(chan accepted, 1)
	go func() {
		c, err := l.Accept()
		accepts <- accepted{conn: c, err: err}
	}()

	timeout := probeTimeout
	client, err := winio.DialPipe(pipeName, &timeout)
	if err != nil {
		// The accept goroutine is still parked. Closing the listener is the
		// caller's job on this path and it cancels the pending accept.
		return 0, &ReadbackError{Reason: ReasonProbeFailed, Got: 0, Want: 1}
	}
	defer client.Close()

	var server net.Conn
	select {
	case a := <-accepts:
		if a.err != nil {
			return 0, &ReadbackError{Reason: ReasonProbeFailed, Got: 0, Want: 1}
		}
		server = a.conn
	case <-time.After(probeTimeout):
		return 0, &ReadbackError{Reason: ReasonProbeFailed, Got: 0, Want: 1}
	}
	defer server.Close()

	// go-winio's pipe connection promotes win32File.Fd (file.go:277), which is
	// the only way to reach the kernel handle behind a net.Conn it returns.
	handled, ok := server.(interface{ Fd() uintptr })
	if !ok {
		return 0, &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}
	h := windows.Handle(handled.Fd())

	// THE ACCEPTED INSTANCE MUST BE THE FRONT'S OWN CONNECTION. go-winio creates
	// one listening instance per Accept, so a stranger who won the race for it
	// leaves the self-dial above to time out; this check makes that property
	// EXPLICIT rather than inherited from the library's instance discipline:
	// the instance's client pid must be this process, or the readback is
	// refused without a byte being read from it.
	if err := verifyProbePeer(h); err != nil {
		return 0, err
	}

	if err := verifyDescriptor(h, user); err != nil {
		return 0, err
	}

	// firstInstance is confirmed by the FILE_CREATE disposition above having
	// succeeded, which is a runtime outcome and not an echoed request.
	flags := frames.BoundFlagFirstInstance

	messageMode, err := readMessageMode(h)
	if err != nil {
		return 0, &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}
	if !messageMode {
		return 0, &ReadbackError{Reason: ReasonMessageModeAbsent, Got: 0, Want: 1}
	}
	flags |= frames.BoundFlagMessageMode

	// REJECT-REMOTE IS REPORTED, NEVER ASSUMED. Windows documents no readback
	// for PIPE_REJECT_REMOTE_CLIENTS; the closest is the NamedPipeType field of
	// FILE_PIPE_LOCAL_INFORMATION, which is the same ULONG go-winio passes to
	// NtCreateNamedPipeFile. If that call fails, or the bit is absent, the flag
	// is reported 0 and MAIN decides what to do about it - which is exactly
	// what protocol section 6.2 asks of an unconfirmed flag, and is why an
	// unconfirmed reject-remote is NOT fatal here while an unconfirmed message
	// mode is.
	if rejectRemote, err := readRejectRemote(h); err == nil && rejectRemote {
		flags |= frames.BoundFlagRejectRemote
	}
	return flags, nil
}

// currentUserSID answers "which user runs THIS process", from the PROCESS token
// rather than the thread token: an impersonating thread would answer for
// whoever it impersonates, and the question here is who owns the pipe.
func currentUserSID() (*windows.SID, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("GetTokenInformation(TokenUser): %w", err)
	}
	if user == nil || user.User.Sid == nil {
		return nil, fmt.Errorf("GetTokenInformation(TokenUser) returned no user SID")
	}
	return user.User.Sid, nil
}

// aclHeader is the ACL structure, declared here because x/sys/windows keeps its
// own fields unexported.
//
// Layout, from the documented ACL structure (winnt.h): AclRevision, Sbz1,
// AclSize, AceCount, Sbz2 - and the ACEs follow immediately, packed.
type aclHeader struct {
	revision byte
	sbz1     byte
	size     uint16
	aceCount uint16
	sbz2     uint16
}

// aceHeader is ACE_HEADER (winnt.h): AceType, AceFlags, AceSize. An
// ACCESS_ALLOWED_ACE continues with an ACCESS_MASK and then the SID, packed.
type aceHeader struct {
	aceType  byte
	aceFlags byte
	aceSize  uint16
}

// accessAllowedAceType is ACCESS_ALLOWED_ACE_TYPE (winnt.h).
const accessAllowedAceType byte = 0x00

// verifyDescriptor reads the DACL back from the live pipe handle and checks it
// against the ONE policy sddlKind = 1 names.
//
// It is a SEMANTIC comparison, not a string one. The descriptor is stored in
// binary and rendered back through a converter whose spelling of a mask is an
// implementation detail; comparing SDDL text would make the front's start
// depend on that spelling. What matters is: the DACL is present, it is
// PROTECTED, and it contains exactly two ACEs, both plain allow ACEs with no
// inheritance flags, granting full access to this user and to SYSTEM. An
// Everyone ACE, a deny ACE or a third trustee fails every one of those.
func verifyDescriptor(h windows.Handle, user *windows.SID) error {
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}
	control, _, err := sd.Control()
	if err != nil {
		return &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}
	if control&windows.SE_DACL_PRESENT == 0 {
		return &ReadbackError{Reason: ReasonDaclAbsent, Got: uint64(control), Want: windows.SE_DACL_PRESENT}
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return &ReadbackError{Reason: ReasonDaclNotProtected, Got: uint64(control), Want: windows.SE_DACL_PROTECTED}
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		// A NULL DACL is not an empty one: it grants everyone.
		return &ReadbackError{Reason: ReasonDaclAbsent, Got: 0, Want: 1}
	}

	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}

	header := (*aclHeader)(unsafe.Pointer(dacl))
	if header.aceCount != 2 {
		return &ReadbackError{Reason: ReasonAceCount, Got: uint64(header.aceCount), Want: 2}
	}
	wanted := []*windows.SID{user, system}
	// The ACEs are PACKED immediately after the ACL header, so the walk is
	// pointer arithmetic through unsafe.Add rather than a slice: unsafe.Add
	// keeps the value an unsafe.Pointer at every step, which is the form the
	// unsafe rules (and `go vet`) require of a derived pointer.
	cursor := unsafe.Add(unsafe.Pointer(dacl), unsafe.Sizeof(aclHeader{}))
	for i := range int(header.aceCount) {
		ace := (*aceHeader)(cursor)
		if ace.aceType != accessAllowedAceType {
			return &ReadbackError{Reason: ReasonAceType, Got: uint64(ace.aceType), Want: uint64(accessAllowedAceType)}
		}
		if ace.aceFlags != 0 {
			return &ReadbackError{Reason: ReasonAceFlags, Got: uint64(ace.aceFlags), Want: 0}
		}
		mask := *(*uint32)(unsafe.Add(cursor, unsafe.Sizeof(aceHeader{})))
		if mask != fileAllAccess && mask != genericAll {
			return &ReadbackError{Reason: ReasonAceMask, Got: uint64(mask), Want: uint64(fileAllAccess)}
		}
		sid := (*windows.SID)(unsafe.Add(cursor, unsafe.Sizeof(aceHeader{})+unsafe.Sizeof(mask)))
		if !sid.Equals(wanted[i]) {
			// The trustee is NOT reported: on a shared machine it is another
			// account's identity, and this process learned it incidentally.
			return &ReadbackError{Reason: ReasonAceTrustee, Got: uint64(i), Want: uint64(i)}
		}
		cursor = unsafe.Add(cursor, uintptr(ace.aceSize))
	}
	return nil
}

// readMessageMode asks the documented GetNamedPipeInfo whether this handle's
// pipe is in message mode.
func readMessageMode(h windows.Handle) (bool, error) {
	var flags, outSize, inSize, instances uint32
	if err := windows.GetNamedPipeInfo(h, &flags, &outSize, &inSize, &instances); err != nil {
		return false, err
	}
	return flags&windows.PIPE_TYPE_MESSAGE != 0, nil
}

var (
	modntdll                    = windows.NewLazySystemDLL("ntdll.dll")
	procNtQueryInformationFile  = modntdll.NewProc("NtQueryInformationFile")
	filePipeLocalInformationCls = uint32(24)

	// GetNamedPipeClientProcessId (kernel32, Vista and later) is declared
	// locally because golang.org/x/sys v0.10.0, the version go-winio v0.6.2
	// requires, does not export it. Signature: BOOL (HANDLE Pipe, PULONG
	// ClientProcessId), r1 == 0 on failure.
	modkernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procGetNamedPipeClientProcessId = modkernel32.NewProc("GetNamedPipeClientProcessId")
)

// verifyProbePeer confirms that the client behind the accepted probe instance is
// this process. Find before Call, as in readRejectRemote: a missing procedure is
// a reported failure, not a panic.
func verifyProbePeer(h windows.Handle) error {
	if err := procGetNamedPipeClientProcessId.Find(); err != nil {
		return &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}
	var pid uint32
	r1, _, _ := procGetNamedPipeClientProcessId.Call(uintptr(h), uintptr(unsafe.Pointer(&pid)))
	if r1 == 0 {
		return &ReadbackError{Reason: ReasonQueryFailed, Got: 0, Want: 1}
	}
	if pid != windows.GetCurrentProcessId() {
		// Neither pid is reported: a stranger's identity is not the front's to
		// publish, and the mismatch itself is the fact.
		return &ReadbackError{Reason: ReasonProbePeerMismatch, Got: 0, Want: 1}
	}
	return nil
}

// ioStatusBlock is IO_STATUS_BLOCK: a status/pointer union followed by an
// information field, both pointer-sized.
type ioStatusBlock struct {
	status      uintptr
	information uintptr
}

// filePipeLocalInformation is FILE_PIPE_LOCAL_INFORMATION (MS-FSCC 2.4.30). Its
// NamedPipeType field is the same ULONG NtCreateNamedPipeFile was given, which
// is why the reject-remote bit can be looked for there and nowhere else.
type filePipeLocalInformation struct {
	namedPipeType          uint32
	namedPipeConfiguration uint32
	maximumInstances       uint32
	currentInstances       uint32
	inboundQuota           uint32
	readDataAvailable      uint32
	outboundQuota          uint32
	writeQuotaAvailable    uint32
	namedPipeState         uint32
	namedPipeEnd           uint32
}

// filePipeRejectRemoteClients is FILE_PIPE_REJECT_REMOTE_CLIENTS, the bit
// go-winio sets unconditionally in the type it passes to NtCreateNamedPipeFile.
const filePipeRejectRemoteClients uint32 = windows.FILE_PIPE_REJECT_REMOTE_CLIENTS

// readRejectRemote reports whether the pipe rejects remote clients, as far as
// the operating system will say.
//
// Find before Addr: LazyProc.Addr PANICS when the procedure is missing, and a
// panic is not a readback. An absent NtQueryInformationFile is reported as the
// failure it is, and an unconfirmed flag is reported 0 rather than assumed.
func readRejectRemote(h windows.Handle) (bool, error) {
	if err := procNtQueryInformationFile.Find(); err != nil {
		return false, err
	}
	var (
		iosb ioStatusBlock
		info filePipeLocalInformation
	)
	status, _, _ := procNtQueryInformationFile.Call(
		uintptr(h),
		uintptr(unsafe.Pointer(&iosb)),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
		uintptr(filePipeLocalInformationCls),
	)
	if status != 0 {
		return false, fmt.Errorf("NtQueryInformationFile(FilePipeLocalInformation): status 0x%x", status)
	}
	return info.namedPipeType&filePipeRejectRemoteClients != 0, nil
}
