//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

// RECOVERING THE INHERITED STDIO HANDLES ON WINDOWS.
//
// THE PROBLEM, and why `os.NewFile(3, ...)` is not the mechanism here.
// On unix a child inherits NUMBERED file descriptors and fd 3 is fd 3. On
// Windows there are no descriptors at the kernel boundary: a child inherits
// HANDLES, and Go's `os.NewFile` on Windows takes a HANDLE VALUE rather than
// a CRT descriptor number (the same idiom cmd/vex-mcp/dial_windows.go uses
// with the handle CreateFile returned). Passing the literal 3 therefore does
// not name the fourth stdio pipe; it names whatever kernel object happens to
// carry handle value 3 in this process, which is nothing we asked for. The
// spike probes that literal reading separately, with a read-only GetFileType
// and never an I/O call, so the report carries the evidence rather than an
// assertion.
//
// THE ACTUAL MECHANISM. The Microsoft C runtime passes inherited descriptors
// to a child through the STARTUPINFOW reserved block (cbReserved2 /
// lpReserved2), and libuv - which is what Electron's `child_process.spawn`
// uses underneath - writes exactly that block for every stdio slot it is
// given (libuv src/win/process-stdio.c, uv__stdio_create). Its layout is:
//
//	uint32  count
//	uint8   crt_flags[count]
//	uintptr handles[count]
//
// The handle array is NOT padded for alignment after the flags array, so
// libuv's own CHILD_STDIO_HANDLE macro indexes raw bytes. This decoder does
// the same, byte-wise through encoding/binary, instead of casting the block
// to a pointer type: a pointer cast at an odd offset is exactly the kind of
// unaligned read that is undefined on some architectures and wrong on all of
// them if the layout ever gains padding.
//
// Nothing here is Vex-specific. It is the documented CRT convention, and the
// spike exists to find out whether the handles that arrive through it are
// OVERLAPPED and poller-eligible, which is the only part no document answers.

// CRT descriptor flags, from the Microsoft C runtime's internal ioinfo bits.
// Only the ones libuv sets are named; the report prints the raw byte anyway.
const (
	crtFOpen      = 0x01
	crtFEOFlag    = 0x02
	crtFCRLF      = 0x04
	crtFPipe      = 0x08
	crtFNoInherit = 0x10
	crtFAppend    = 0x20
	crtFDev       = 0x40
	crtFText      = 0x80
)

// File types reported by GetFileType, from WinBase.h.
const (
	fileTypeUnknown = 0x0000
	fileTypeDisk    = 0x0001
	fileTypeChar    = 0x0002
	fileTypePipe    = 0x0003
	fileTypeRemote  = 0x8000
)

// invalidHandleValue is INVALID_HANDLE_VALUE, which libuv writes into every
// CRT slot it was not asked to populate.
const invalidHandleValue = ^uintptr(0)

// startupInfoW mirrors the C STARTUPINFOW.
//
// It is DECLARED HERE rather than reused from `syscall`, because
// syscall.StartupInfo leaves cbReserved2 and lpReserved2 as unexported blank
// fields - the two fields this decoder needs - and this module deliberately
// carries no golang.org/x/sys dependency (see bridge/go.mod).
type startupInfoW struct {
	Cb              uint32
	LpReserved      *uint16
	LpDesktop       *uint16
	LpTitle         *uint16
	DwX             uint32
	DwY             uint32
	DwXSize         uint32
	DwYSize         uint32
	DwXCountChars   uint32
	DwYCountChars   uint32
	DwFillAttribute uint32
	DwFlags         uint32
	WShowWindow     uint16
	CbReserved2     uint16
	LpReserved2     *byte
	HStdInput       syscall.Handle
	HStdOutput      syscall.Handle
	HStdError       syscall.Handle
}

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procGetStartupInfo = kernel32.NewProc("GetStartupInfoW")
)

// inheritedSlot is one CRT stdio slot exactly as the parent handed it over.
type inheritedSlot struct {
	fd     int
	flags  byte
	handle syscall.Handle
}

// inheritedStdioSlots decodes the CRT reserved block of this process.
//
// It returns the slots in fd order, INCLUDING unused ones (handle
// INVALID_HANDLE_VALUE), so the report can show that a slot arrived empty
// rather than silently renumbering the planes.
func inheritedStdioSlots() (slots []inheritedSlot, reservedBytes int, err error) {
	var si startupInfoW
	si.Cb = uint32(unsafe.Sizeof(si))
	// GetStartupInfoW returns void and cannot fail.
	_, _, _ = procGetStartupInfo.Call(uintptr(unsafe.Pointer(&si)))

	reservedBytes = int(si.CbReserved2)
	if si.LpReserved2 == nil || reservedBytes < 4 {
		return nil, reservedBytes, errors.New("no CRT reserved block: the parent passed no inheritable stdio descriptors")
	}
	block := unsafe.Slice(si.LpReserved2, reservedBytes)

	count := int(binary.LittleEndian.Uint32(block[:4]))
	ptrSize := int(unsafe.Sizeof(uintptr(0)))
	need := 4 + count + count*ptrSize
	if count < 0 || need > len(block) {
		return nil, reservedBytes, fmt.Errorf(
			"CRT reserved block claims %d slots, which needs %d bytes, but only %d arrived",
			count, need, len(block))
	}

	slots = make([]inheritedSlot, count)
	for i := 0; i < count; i++ {
		off := 4 + count + i*ptrSize
		var raw uintptr
		if ptrSize == 8 {
			raw = uintptr(binary.LittleEndian.Uint64(block[off : off+8]))
		} else {
			raw = uintptr(binary.LittleEndian.Uint32(block[off : off+4]))
		}
		slots[i] = inheritedSlot{fd: i, flags: block[4+i], handle: syscall.Handle(raw)}
	}
	return slots, reservedBytes, nil
}

// usable reports whether the slot carries a real handle.
func (s inheritedSlot) usable() bool {
	return uintptr(s.handle) != invalidHandleValue && s.handle != 0
}

// describeFlags renders the CRT flag byte as raw hex plus the named bits, so
// a reader can tell FPIPE|FOPEN from a slot that arrived as a device.
func describeFlags(flags byte) string {
	names := ""
	add := func(bit byte, name string) {
		if flags&bit != 0 {
			if names != "" {
				names += "|"
			}
			names += name
		}
	}
	add(crtFOpen, "FOPEN")
	add(crtFEOFlag, "FEOFLAG")
	add(crtFCRLF, "FCRLF")
	add(crtFPipe, "FPIPE")
	add(crtFNoInherit, "FNOINHERIT")
	add(crtFAppend, "FAPPEND")
	add(crtFDev, "FDEV")
	add(crtFText, "FTEXT")
	if names == "" {
		names = "none"
	}
	return fmt.Sprintf("0x%02x (%s)", flags, names)
}

// describeFileType names what GetFileType says a handle is. The error is
// returned as a string because it is evidence, not a control-flow signal.
func describeFileType(h syscall.Handle) (string, string) {
	t, err := syscall.GetFileType(h)
	if err != nil {
		return "", err.Error()
	}
	switch t {
	case fileTypeDisk:
		return "disk", ""
	case fileTypeChar:
		return "char", ""
	case fileTypePipe:
		return "pipe", ""
	case fileTypeRemote:
		return "remote", ""
	case fileTypeUnknown:
		return "unknown", ""
	default:
		return fmt.Sprintf("0x%04x", t), ""
	}
}
