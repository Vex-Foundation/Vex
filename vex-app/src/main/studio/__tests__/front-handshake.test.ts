/**
 * THE FRONT'S PURE DECISIONS: the frozen numbers, and what a human is told.
 *
 * Two classes of claim live here because neither needs a process:
 *
 *   1. THE SIX FROZEN VALUES ARE DERIVED, NOT SPELLED. The front compares each
 *      against its own compiled-in constant and refuses to serve on ANY
 *      difference (protocol 5.1), so a number re-typed here is a packaging
 *      fault discovered by a user rather than by a test. Each one is asserted
 *      against the module that already owns it.
 *   2. EVERY FAILURE HAS A CAUSE A USER CAN ACT ON. The failure vocabulary is
 *      an operator's; the cause is the renderer's, and the mapping is total.
 */

import { describe, expect, it } from "vitest";

import {
  PIPE_FRONT_BOUND_FLAGS,
  PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES,
  PIPE_FRONT_PROTOCOL_VERSION,
  PIPE_FRONT_SDDL_KIND,
} from "@vex-agent/mcp/pipe-front-frames.js";
import { studioHostUnavailableCauseSchema } from "@shared/schemas/studio.js";

import { STUDIO_MAX_LISTENER_SOCKETS } from "../mcp-host/bounds.js";
import { STUDIO_HANDSHAKE_DEADLINE_MS } from "../mcp-host/handshake.js";
import {
  FRONT_BOUND_REQUIRED_FLAGS,
  FRONT_CHUNK_BYTES,
  FRONT_CREDIT_BYTES,
  FRONT_HANDSHAKE_DEADLINE_MS,
  FRONT_MAX_RAW,
  FRONT_PROTOCOL_VERSION,
  FRONT_SDDL_KIND,
  frontFailureCause,
  type FrontFailureName,
} from "../mcp-host/front-handshake.js";

/**
 * The CLOSED failure vocabulary, enumerated as data.
 *
 * A union cannot be iterated at runtime, so this list is the runtime half and
 * the `satisfies` below is the compile-time half: a member added to the type
 * without being added here fails to compile.
 */
const FAILURES = [
  "binary_unavailable",
  "unsupported_platform",
  "spawn_failed",
  "child_exit",
  "plane_eof",
  "plane_io_error",
  "malformed_frame",
  "hello_ack_version",
  "hello_ack_pid",
  "hello_ack_generation_reused",
  "unexpected_frame",
  "bound_pipe_name",
  "bound_flags_unconfirmed",
  "sddl_readback_mismatch",
  "admission_epoch_exhausted",
  "front_error",
  "lock_ack_timeout",
  "lock_before_hello_ack",
  "credit_overrun",
  "data_after_end",
  "ack_regression",
  "restart_budget_exhausted",
] as const satisfies readonly FrontFailureName[];

describe("the six frozen HELLO values", () => {
  it("are DERIVED from the modules that own them, never re-typed", () => {
    // Two internal peers that disagree about `chunkBytes` are a packaging
    // fault, and the front turns any difference into exit code 3. Deriving is
    // what stops a build error from becoming a bounds mismatch under load.
    expect({
      protocolVersion: FRONT_PROTOCOL_VERSION,
      sddlKind: FRONT_SDDL_KIND,
      maxRaw: FRONT_MAX_RAW,
      chunkBytes: FRONT_CHUNK_BYTES,
      handshakeDeadlineMs: FRONT_HANDSHAKE_DEADLINE_MS,
    }).toEqual({
      protocolVersion: PIPE_FRONT_PROTOCOL_VERSION,
      sddlKind: PIPE_FRONT_SDDL_KIND,
      // The front's raw handle bound IS main's listener socket cap: 16
      // established plus 4 handshaking plus one overflow slot.
      maxRaw: STUDIO_MAX_LISTENER_SOCKETS,
      chunkBytes: PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES,
      handshakeDeadlineMs: STUDIO_HANDSHAKE_DEADLINE_MS,
    });
  });

  it("keeps the window at HALF the measured OS pipe buffer", () => {
    // 65536 is deliberately half of the 131072 bytes the B4.2a spike measured,
    // so one connection's outstanding bytes can never fill the shared plane and
    // block a second connection's chunk behind it (protocol 11.2).
    expect(FRONT_CREDIT_BYTES * 2).toBe(131_072);
  });

  it("requires every pipe flag Windows must CONFIRM at runtime", () => {
    expect(FRONT_BOUND_REQUIRED_FLAGS).toBe(
      PIPE_FRONT_BOUND_FLAGS.rejectRemote
        | PIPE_FRONT_BOUND_FLAGS.firstInstance
        | PIPE_FRONT_BOUND_FLAGS.messageMode,
    );
  });
});

describe("what the human is told", () => {
  it("maps EVERY failure to a cause the wire can carry", () => {
    for (const failure of FAILURES) {
      expect(
        { failure, member: studioHostUnavailableCauseSchema.options.includes(
          frontFailureCause(failure),
        ) },
      ).toEqual({ failure, member: true });
    }
  });

  it("separates the four remedies rather than collapsing them", () => {
    // Each of these sends the user somewhere DIFFERENT: repair the
    // installation, restart Vex because the fence is spent, restart Vex because
    // the helper crash-looped, or stop because Windows would not confirm the
    // pipe's protection. One cause for all four would be an "unexpected error"
    // in four costumes (rule 90).
    expect({
      missing: frontFailureCause("binary_unavailable"),
      readback: frontFailureCause("sddl_readback_mismatch"),
      flags: frontFailureCause("bound_flags_unconfirmed"),
      budget: frontFailureCause("restart_budget_exhausted"),
      epoch: frontFailureCause("admission_epoch_exhausted"),
    }).toEqual({
      missing: "front_unavailable",
      readback: "pipe_security_unconfirmed",
      flags: "pipe_security_unconfirmed",
      budget: "front_restart_budget_exhausted",
      epoch: "admission_permanently_closed",
    });
  });
});
