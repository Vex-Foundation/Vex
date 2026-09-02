package listener

import (
	"errors"
	"fmt"
	"net"
)

// Binding is a created pipe plus what the front VERIFIED about it at runtime.
//
// FlagsApplied is the bitfield BOUND carries, and it reports CONFIRMATION, not
// intent: a flag the front asked for and could not confirm is 0, and main
// decides what to do about it (protocol section 6.2). A front that echoed its
// own request would tell main "remote clients are rejected" on a build where
// the flag silently did nothing.
type Binding struct {
	Listener     net.Listener
	FlagsApplied uint8
}

// ErrBindUnsupported is what the non-Windows build returns. The front's named
// pipe exists only on Windows; every platform-independent test drives the
// accept loop and the relay over a listener it makes itself.
var ErrBindUnsupported = errors.New("the vex-pipe-front named pipe exists only on Windows")

// BindError is a pipe that could not be created: ERROR code 4,
// `listener_bind_failed`.
type BindError struct{ Err error }

func (e *BindError) Error() string { return "listener: bind failed: " + e.Err.Error() }
func (e *BindError) Unwrap() error { return e.Err }

// Readback reasons. They are CONSTANTS OF THIS REPOSITORY and are the only
// descriptor-related words that may reach the structural log: the descriptor
// itself, the SIDs in it and the pipe name are none of them (rules 05 and 07).
const (
	// ReasonProbeFailed is a readback that could not be performed at all,
	// because the front could not obtain a handle to its own pipe.
	ReasonProbeFailed = "probe_failed"
	// ReasonProbePeerMismatch is a probe whose accepted instance was connected
	// by a process other than the front itself: the readback would have run on
	// a stranger's connection, so it is refused instead.
	ReasonProbePeerMismatch = "probe_peer_mismatch"
	// ReasonQueryFailed is a readback whose system call failed.
	ReasonQueryFailed = "query_failed"
	// ReasonDaclAbsent is a pipe whose read-back descriptor carries no DACL, or
	// a NULL one, which grants everyone.
	ReasonDaclAbsent = "dacl_absent"
	// ReasonDaclNotProtected is a DACL that inheritance may still extend.
	ReasonDaclNotProtected = "dacl_not_protected"
	// ReasonAceCount is a DACL with a number of ACEs other than the two the
	// front asked for.
	ReasonAceCount = "dacl_ace_count"
	// ReasonAceType is an ACE that is not ACCESS_ALLOWED - a deny ACE included.
	ReasonAceType = "dacl_ace_type"
	// ReasonAceFlags is an ACE carrying inheritance flags.
	ReasonAceFlags = "dacl_ace_flags"
	// ReasonAceMask is an allow ACE that does not grant the access the front
	// asked for.
	ReasonAceMask = "dacl_ace_mask"
	// ReasonAceTrustee is an allow ACE naming a SID the front did not ask for.
	ReasonAceTrustee = "dacl_ace_trustee"
	// ReasonMessageModeAbsent is a pipe that came back in byte mode. It is
	// FATAL and not merely unreported: CloseWrite is implemented as a zero-byte
	// write and only a MESSAGE-mode pipe delivers that to the reader as EOF
	// (go-winio pipe.go:146 and the PipeConfig.MessageMode comment), so a
	// byte-mode pipe would break every half-close silently - which is the one
	// failure endpoint contract 3.2 says breaks `claude -p` style sessions
	// without a symptom.
	ReasonMessageModeAbsent = "message_mode_absent"
)

// ReadbackError is a descriptor or flag that came back other than as asked:
// ERROR code 5, `sddl_readback_mismatch`.
//
// It carries a reason constant and two NUMBERS, never a descriptor string, a
// SID or a path.
type ReadbackError struct {
	Reason string
	Got    uint64
	Want   uint64
}

func (e *ReadbackError) Error() string {
	return fmt.Sprintf("listener: readback mismatch (%s): got %d, want %d", e.Reason, e.Got, e.Want)
}
