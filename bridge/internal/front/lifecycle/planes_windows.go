//go:build windows

package lifecycle

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// RECOVERING THE INHERITED PLANES ON WINDOWS.
//
// On unix a child inherits NUMBERED descriptors and fd 3 is fd 3. On Windows
// there are no descriptors at the kernel boundary: a child inherits HANDLES,
// and `os.NewFile` on Windows takes a HANDLE VALUE rather than a CRT descriptor
// number. Passing the literal 3 names whatever kernel object happens to carry
// handle value 3 in this process, which is nothing anybody asked for.
//
// The Microsoft C runtime passes inherited descriptors to a child through the
// STARTUPINFOW reserved block (cbReserved2 / lpReserved2), and libuv - what
// Electron's `child_process.spawn` uses underneath - writes exactly that block
// for every stdio slot it is given (libuv src/win/process-stdio.c,
// uv__stdio_create):
//
//	uint32  count
//	uint8   crt_flags[count]
//	uintptr handles[count]
//
// The handle array is NOT padded after the flags array, so the block is walked
// BYTE-WISE through encoding/binary rather than by casting it to a struct: a
// pointer cast at an odd offset is an unaligned read, and it would break
// silently if the layout ever gained padding.
//
// THE TECHNIQUE IS THE SPIKE'S, MEASURED. cmd/spike-overlapped-stdio is the
// measurement that established these handles arrive as OVERLAPPED, poller-
// eligible pipes with working deadlines and cancellation
// (`dedicated_overlapped_planes_usable: true`). This file is the production
// reader of the same block; the spike stays what it is, a measurement command,
// and neither imports the other, because a spike that could be changed by
// production needs is no longer evidence.

// invalidHandleValue is INVALID_HANDLE_VALUE, which libuv writes into every CRT
// slot it was not asked to populate.
const invalidHandleValue = ^uintptr(0)

// planeSlots are the CRT slots protocol section 1 assigns to the four framed
// streams, in the order Planes names them.
var planeSlots = [4]int{3, 4, 5, 6}

var (
	modkernel32           = syscall.NewLazyDLL("kernel32.dll")
	procGetStartupInfoW   = modkernel32.NewProc("GetStartupInfoW")
	errNoCRTReservedBlock = errors.New("no CRT reserved block: the parent passed no inheritable stdio descriptors")
)

// startupInfoW mirrors the C STARTUPINFOW.
//
// It is DECLARED HERE rather than reused from `syscall`, because
// syscall.StartupInfo leaves cbReserved2 and lpReserved2 as unexported blank
// fields, and those two are the only fields this decoder needs.
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

// Acquire opens the four framed planes from the CRT reserved block.
//
// On ANY failure it closes what it already opened and returns the primary
// cause, so a partly-acquired front never reaches a serving state (rule 05's
// acquisition and rollback).
func Acquire() (*Planes, error) {
	handles, err := inheritedHandles()
	if err != nil {
		return nil, err
	}

	planes := &Planes{}
	for i, slot := range planeSlots {
		if slot >= len(handles) || uintptr(handles[slot]) == invalidHandleValue || handles[slot] == 0 {
			_ = planes.Close()
			return nil, fmt.Errorf("stdio slot %d carries no inherited handle: main must spawn the front with seven stdio slots", slot)
		}
		// os.NewFile hands an OVERLAPPED handle to the runtime poller, which is
		// what makes deadlines and Close-cancels-a-blocked-read work on these
		// planes; cmd/vex-mcp/dial_windows.go carries the go1.27.0 source
		// citations for that hand-off.
		f := os.NewFile(uintptr(handles[slot]), fmt.Sprintf("plane%d", slot))
		if f == nil {
			_ = planes.Close()
			return nil, fmt.Errorf("stdio slot %d is not a usable handle", slot)
		}
		planes.files = append(planes.files, f)
		switch i {
		case 0:
			planes.ControlDown = f
		case 1:
			planes.ControlUp = f
		case 2:
			planes.DataDown = f
		case 3:
			planes.DataUp = f
		}
	}
	return planes, nil
}

// inheritedHandles decodes the CRT reserved block into slot-indexed handles,
// INCLUDING unused slots, so a missing plane is reported as missing rather than
// silently renumbering the ones that arrived.
func inheritedHandles() ([]syscall.Handle, error) {
	var si startupInfoW
	si.Cb = uint32(unsafe.Sizeof(si))
	// GetStartupInfoW returns void and cannot fail.
	_, _, _ = procGetStartupInfoW.Call(uintptr(unsafe.Pointer(&si)))

	reserved := int(si.CbReserved2)
	if si.LpReserved2 == nil || reserved < 4 {
		return nil, errNoCRTReservedBlock
	}
	block := unsafe.Slice(si.LpReserved2, reserved)

	count := int(binary.LittleEndian.Uint32(block[:4]))
	ptrSize := int(unsafe.Sizeof(uintptr(0)))
	need := 4 + count + count*ptrSize
	if count < 0 || need > len(block) {
		return nil, fmt.Errorf(
			"CRT reserved block claims %d slots, which needs %d bytes, but only %d arrived",
			count, need, len(block))
	}

	handles := make([]syscall.Handle, count)
	for i := range count {
		off := 4 + count + i*ptrSize
		var raw uintptr
		if ptrSize == 8 {
			raw = uintptr(binary.LittleEndian.Uint64(block[off : off+8]))
		} else {
			raw = uintptr(binary.LittleEndian.Uint32(block[off : off+4]))
		}
		handles[i] = syscall.Handle(raw)
	}
	return handles, nil
}
