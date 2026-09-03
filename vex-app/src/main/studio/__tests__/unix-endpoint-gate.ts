/**
 * THE WIN32 GATE for the suites that drive a REAL unix endpoint.
 *
 * Six suites assemble the whole host on an `AF_UNIX` socket under a 0700 temp
 * directory: `mcp-socket-contract`, `mcp-host-admission`, `mcp-host-lifecycle`,
 * `host-status-transitions`, `mcp-wire-error-redaction` and
 * `mcp-host-serve-failure` - each of them binds a real endpoint through
 * `startStudioMcpHost` and asserts on the result of that bind. Windows has no
 * `AF_UNIX` endpoint for them to assemble - its transport is the named-pipe
 * front - so those suites cannot pass there and never could.
 *
 * THE EQUIVALENT COVERAGE ON WINDOWS, which is what makes this skip a scope
 * statement rather than a hole. The section 1.6 transport gate is OPEN, so the
 * Windows endpoint is driven on the `vex-app-windows` lane by
 * `front-real-binary.test.ts` - the real `vex-pipe-front.exe` spawned by the
 * real host, its descriptor readback, main's refusal relayed byte for byte to a
 * real pipe client, `LOCK_ACK` inside its deadline - and by the win32 arm of
 * `mcp-bridge-conformance.test.ts`, where the real built `vex-mcp.exe`
 * handshakes and relays MCP frames to the real host OVER that pipe. What is
 * skipped below is one transport's assembly, never a contract.
 *
 * They carried no skip. The Windows CI lane was soft when this gate was written,
 * so their failures were absorbed rather than reported - the worst of both
 * worlds: no signal, and no record of why. The lane is REQUIRED now, which
 * makes the visible skip load-bearing rather than tidy: an unexplained failure
 * there stops the merge. `describe.skipIf` makes the skip and its reason
 * VISIBLE in the reporter, which is the repo's existing precedent for a
 * precondition a runner cannot meet (`mcp-bridge-conformance.test.ts`).
 *
 * SCOPE, deliberately narrow. This gate covers exactly "assembles a direct unix
 * listener". Anything provable without one - the framing, the outbound queue,
 * the connection latches, the duplex-transport seam and its fake, and the
 * persistent-EOF replay over a loopback TCP pair - runs on every platform and
 * must NOT be put behind this flag.
 */

export const SKIP_UNIX_ENDPOINT_SUITES = process.platform === "win32";
