//go:build !windows

package control

// isBrokenPipe has no extra cases off Windows: the errno constants the unix
// build needs are already checked in isPeerGone.
func isBrokenPipe(error) bool { return false }
