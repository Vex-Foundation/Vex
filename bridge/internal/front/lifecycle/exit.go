// Package lifecycle owns the vex-pipe-front PROCESS: its exit vocabulary, its
// structural stderr log, the four framed planes it inherits from main, and the
// parent-death watch that ends it when main is gone.
//
// Normative specification:
// `src/vex-agent/tools/tool-surface-spec/studio-mcp/pipe-front-protocol.md`
// sections 1 (planes), 8 (lifecycle) and 10 (malformed handling).
//
// NOTHING IN THIS PACKAGE EVER LOGS CONTENT. Protocol section 10 permits the
// plane, the type, the length, the sequence and a structural reason; peer
// bytes, project ids, security descriptors and full paths are none of those,
// and the log API below cannot carry them (rules 05 and 07).
package lifecycle

// Exit codes. They are a CLOSED set with one meaning each, so main's supervisor
// can tell "the front refused the packaging it was given" from "the front broke
// under load" without parsing a sentence.
//
// 2 matches cmd/spike-overlapped-stdio's exitUnsupported so "wrong platform"
// reads the same for every binary in this module.
const (
	// ExitClean is a commanded shutdown: QUIT answered, or plane 3 at EOF.
	ExitClean = 0
	// ExitStartup is a front that never reached a serving state: the planes
	// could not be acquired, or HELLO never arrived.
	ExitStartup = 1
	// ExitUnsupported is the non-Windows build refusing to pretend.
	ExitUnsupported = 2
	// ExitHelloRejected is a HELLO whose frozen equality values differ from the
	// front's compiled-in constants (protocol section 5.1). Main and the front
	// ship in one package, so this is a packaging fault, not a negotiation.
	ExitHelloRejected = 3
	// ExitMalformedFrame is a frame from main that did not parse (section 10).
	ExitMalformedFrame = 4
	// ExitPlaneIO is a read or write failure on one of the four planes.
	ExitPlaneIO = 5
	// ExitListener is a pipe that could not be created, or whose runtime
	// readback did not confirm what was asked for (section 6.2).
	ExitListener = 6
	// ExitCreditViolation is a relay-level credit or window rule broken by main
	// (section 11 and the named failures of section 12.3).
	ExitCreditViolation = 7
	// ExitInternalInvariant is an invariant the front broke itself.
	ExitInternalInvariant = 8
	// ExitParentGone is stdin EOF, or the parent otherwise signalling its death
	// (section 8). It is not a failure; it is the front outliving its reason to
	// exist by a few milliseconds.
	ExitParentGone = 9
)
