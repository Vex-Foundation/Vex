/**
 * The Vex Studio MCP host's BOUNDS, in one leaf module.
 *
 * They live here rather than beside the listener or the connection registry
 * because both owners need them and neither owns them: the listener derives
 * its own socket cap from the two connection bounds, and the registry enforces
 * them. A leaf module is what keeps that shared vocabulary free of a cycle.
 *
 * The public surface is still `mcp-host.ts`, which re-exports every constant
 * below; callers outside this directory import from there.
 */

/** The contract's established-connection bound. Connection 17 is REFUSED. */
export const STUDIO_MAX_CONNECTIONS = 16;

/** The contract's concurrent handshake-pending bound. */
export const STUDIO_MAX_HANDSHAKE_PENDING = 4;

/** The contract's global in-flight bound. Matches the broker's waiter cap. */
export const STUDIO_MAX_INFLIGHT_GLOBAL = 32;

/**
 * The listener's own socket cap: the two bounds plus ONE overflow socket.
 *
 * `maxConnections` is a Node-level DROP - accepted and destroyed with no byte
 * written - so at exactly 16 established plus 4 pending the next bridge saw an
 * unexplained close where the contract promises a typed `at_capacity` ack. The
 * overflow slot admits the 21st far enough to reach the handshake-pending path,
 * be refused with that ack, and be closed. The bounds are still real: the 22nd
 * is dropped, and the established reservation is a separate synchronous bound.
 */
export const STUDIO_MAX_LISTENER_SOCKETS =
  STUDIO_MAX_CONNECTIONS + STUDIO_MAX_HANDSHAKE_PENDING + 1;

/** How long the host waits for connections to settle on shutdown. */
export const STUDIO_HOST_SHUTDOWN_DEADLINE_MS = 5_000;
