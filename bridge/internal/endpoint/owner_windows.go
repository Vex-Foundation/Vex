//go:build windows

package endpoint

import "io/fs"

// ownerUID has no meaning on Windows, and no Windows code path reaches it: the
// endpoint there is a NAMED PIPE, which has no parent directory to probe for
// ownership or mode. A pipe's access control is its security descriptor, held
// by the process that served it, and the bridge's admission is the handshake.
func ownerUID(_ fs.FileInfo) int { return -1 }
