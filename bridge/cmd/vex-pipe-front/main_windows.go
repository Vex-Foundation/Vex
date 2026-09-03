//go:build windows

// Command vex-pipe-front owns the Windows named pipe for the Vex Studio MCP
// host.
//
// It is spawned by the Electron MAIN process with SEVEN stdio slots and speaks
// the internal protocol of
// `src/vex-agent/tools/tool-surface-spec/studio-mcp/pipe-front-protocol.md` on
// slots 3 to 6. Slot 0 carries nothing and its EOF is the parent-death signal;
// slot 1 is never written; slot 2 carries structural codes and counts only.
//
// It is the ONLY process that touches the pipe, and it is trusted for pipe
// mechanics alone: never for wallet policy, never for teardown-cause
// authorship, and never for a refusal line, all of which are main's
// (protocol section 13).
package main

import (
	"crypto/rand"
	"encoding/binary"
	"os"

	"github.com/Vex-Foundation/vex/bridge/internal/front/control"
	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
	"github.com/Vex-Foundation/vex/bridge/internal/front/listener"
)

// frontVersion and buildHash are recorded in main's structural log so a support
// bundle can say which front produced a session. They are overridable at link
// time by the packaging chain (-ldflags -X).
var (
	frontVersion = "dev"
	buildHash    = "unknown"
)

func main() {
	log := lifecycle.NewLogger(os.Stderr)

	planes, err := lifecycle.Acquire()
	if err != nil {
		// The failure text names no path and no handle value: it is the one
		// startup line a human may have to read, and it is written before any
		// framed stream exists.
		log.Event("planes_unavailable")
		os.Exit(lifecycle.ExitStartup)
	}
	defer planes.Close()

	supervisor := control.New(control.Options{
		Planes:       planes,
		Log:          log,
		Bind:         listener.Bind,
		Parent:       lifecycle.WatchParent(os.Stdin),
		FrontVersion: frontVersion,
		BuildHash:    buildHash,
		Pid:          uint32(os.Getpid()),
		Generation:   freshGeneration,
	})
	os.Exit(supervisor.Run())
}

// freshGeneration picks the NON-ZERO generation HELLO_ACK announces.
//
// It is random rather than counted because the front is the process whose
// identity it names and a restarted front remembers nothing: a counter would
// restart at the same value and hand main a generation it has already seen.
// MONOTONICITY ACROSS RESTARTS IS MAIN'S BOOKKEEPING - main rejects a
// HELLO_ACK whose generation it has already seen and restarts - because only
// main survives a restart and only main can remember (protocol section 4).
func freshGeneration() uint32 {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// crypto/rand does not fail on Windows in practice, and a front that
		// guessed here would be inventing the one value that separates its
		// frames from a dead front's. Zero is refused by the supervisor.
		return 0
	}
	generation := binary.LittleEndian.Uint32(raw[:])
	if generation == 0 {
		// 0 is the bootstrap generation and can never be announced.
		generation = 1
	}
	return generation
}
