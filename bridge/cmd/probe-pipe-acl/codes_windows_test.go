//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows"
)

// THE CODES COME FROM THE MACHINE ARTIFACT, NOT FROM A COMMENT.
//
// classifyDialError works on plain numbers so that it compiles and is tested on
// every platform, which means the numbers themselves need a pin to the source
// they were read from. This is that pin: on Windows, where the constants exist,
// each one is compared with golang.org/x/sys/windows - the module go-winio
// v0.6.2 requires and this module already carries - so a transcription error
// cannot survive a build of the package that will actually run the probe.
func TestErrorCodesMatchTheWindowsConstants(t *testing.T) {
	cases := []struct {
		name string
		got  uint32
		want windows.Errno
	}{
		{"ERROR_FILE_NOT_FOUND", errorFileNotFound, windows.ERROR_FILE_NOT_FOUND},
		{"ERROR_ACCESS_DENIED", errorAccessDenied, windows.ERROR_ACCESS_DENIED},
		{"ERROR_PIPE_BUSY", errorPipeBusy, windows.ERROR_PIPE_BUSY},
	}
	for _, c := range cases {
		if uint32(c.want) != c.got {
			t.Errorf("%s: probe has %d, x/sys/windows has %d", c.name, c.got, uint32(c.want))
		}
	}
}

// THE SQOS FLAGS ARE THE ONES THE SHIPPED BRIDGE SENDS. They are mirrored from
// cmd/vex-mcp/dial_windows.go rather than imported (that file is in another
// `package main`), so the values are pinned against x/sys/windows here: a
// probe that dialled at a different impersonation level would be measuring a
// different client than the one the product uses.
func TestSQOSFlagsMatchTheWindowsConstants(t *testing.T) {
	if securitySQOSPresent != windows.SECURITY_SQOS_PRESENT {
		t.Errorf("securitySQOSPresent = 0x%X, want 0x%X", securitySQOSPresent, windows.SECURITY_SQOS_PRESENT)
	}
	if securityIdentification != windows.SECURITY_IDENTIFICATION {
		t.Errorf("securityIdentification = 0x%X, want 0x%X", securityIdentification, windows.SECURITY_IDENTIFICATION)
	}
}

// THE ACCESS MASKS ARE THE TWO OPENS THE MEASUREMENT NEEDS, and nothing else
// is accepted: an unrecognised --access word is an instrument error, not a
// silent duplex dial.
func TestAccessMask(t *testing.T) {
	duplex, ok := accessMask(accessDuplex)
	if !ok || duplex != uint32(windows.GENERIC_READ|windows.GENERIC_WRITE) {
		t.Errorf("duplex mask = 0x%X (ok=%v), want 0x%X", duplex, ok, uint32(windows.GENERIC_READ|windows.GENERIC_WRITE))
	}
	read, ok := accessMask(accessRead)
	if !ok || read != uint32(windows.GENERIC_READ) {
		t.Errorf("read mask = 0x%X (ok=%v), want 0x%X", read, ok, uint32(windows.GENERIC_READ))
	}
	if _, ok := accessMask("write"); ok {
		t.Error("an unrecognised access word must be refused")
	}
}
