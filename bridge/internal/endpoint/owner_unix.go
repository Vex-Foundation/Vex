//go:build !windows

package endpoint

import (
	"io/fs"
	"syscall"
)

// ownerUID reads the owning uid from the platform stat structure. The override
// ownership check is the reason this exists, and it is the only fact the plan
// cannot take from portable fs.FileInfo.
func ownerUID(info fs.FileInfo) int {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return -1
	}
	return int(stat.Uid)
}
