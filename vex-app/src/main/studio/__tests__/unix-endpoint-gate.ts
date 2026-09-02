/**
 * THE WIN32 GATE for the suites that drive a REAL unix endpoint.
 *
 * Five suites assemble the whole host on an `AF_UNIX` socket under a 0700 temp
 * directory: `mcp-socket-contract`, `mcp-host-admission`, `mcp-host-lifecycle`,
 * `host-status-transitions` and `mcp-wire-error-redaction` - each of them binds
 * a real endpoint through `startStudioMcpHost` and asserts on the result of
 * that bind. On Windows the host refuses to bind that transport at all (the
 * section 1.6 gate of `studio-mcp/bridge-endpoint-contract.md`; the Windows
 * transport is stage B4.2b-2's named-pipe front), so those suites cannot pass
 * there and never could.
 *
 * They carried no skip. The Windows CI lane is soft today, so their failures
 * were absorbed rather than reported - which is the worst of both worlds: no
 * signal, and no record of why. `describe.skipIf` makes the skip and its reason
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
