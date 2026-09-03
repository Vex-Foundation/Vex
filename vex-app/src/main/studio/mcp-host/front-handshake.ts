/**
 * THE FRONT HANDSHAKE, as pure decisions over frames.
 *
 * Normative wire: `src/vex-agent/tools/tool-surface-spec/studio-mcp/
 * pipe-front-protocol.md` sections 4 (generation and bootstrap), 5.1 (`HELLO`),
 * 5.2 (the dynamic admission epoch), 6.1 (`HELLO_ACK`) and 6.2 (`BOUND`).
 *
 * It is separated from `front-supervisor.ts` for one reason: the supervisor
 * owns a child process, four streams and five timers, and the questions asked
 * here - is this ack our child's, has this generation been seen before, did
 * Windows actually confirm the flags we required, is a restart a remedy for
 * what just happened, and what does this exit code mean - are answered from
 * frame fields and constants alone. A pure module can be table-tested against
 * every failure without spawning anything, which is what makes the
 * supervisor's own tests about lifecycle rather than about classification.
 *
 * So this module owns the FAILURE VOCABULARY as well as the handshake: the
 * closed set of names, what each one costs (a restart, or a durable refusal),
 * what the front's exit codes mean, and what a human is told. Those four
 * questions change together - a new failure needs all four answers in the same
 * commit - which is what makes them one responsibility rather than four.
 *
 * ## The six frozen numbers are NOT configuration
 *
 * `protocolVersion`, `sddlKind`, `maxRaw`, `creditBytes`, `chunkBytes` and
 * `handshakeDeadlineMs` are compared by the front against its own compiled-in
 * constants and ANY difference makes it refuse to serve and exit 3 (protocol
 * 5.1). Main and the front ship in one signed package, so a difference is a
 * packaging fault, never a negotiation. Every one of them is therefore derived
 * here from the module that already owns it - the host's bounds, the codec's
 * constants, the handshake's deadline - so the two peers cannot drift by
 * someone re-typing a number.
 *
 * `initialAdmissionEpoch` is the ONE dynamic field (5.2) and it is supplied by
 * the caller from `studioAdmissionEpoch()` at the moment of the spawn, so a
 * RESTARTED front is handed the SAME current epoch the dead one was serving.
 */

import {
  PIPE_FRONT_BOUND_FLAGS,
  PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES,
  PIPE_FRONT_PLANE,
  PIPE_FRONT_PROTOCOL_VERSION,
  PIPE_FRONT_SDDL_KIND,
  type PipeFrontFrame,
} from "@vex-agent/mcp/pipe-front-frames.js";

import type { StudioHostUnavailableCause } from "@shared/schemas/studio.js";

import { STUDIO_MAX_LISTENER_SOCKETS } from "./bounds.js";
import { STUDIO_HANDSHAKE_DEADLINE_MS } from "./handshake.js";

/** Protocol 5.1: the frozen `protocolVersion`. */
export const FRONT_PROTOCOL_VERSION = PIPE_FRONT_PROTOCOL_VERSION;

/** Protocol 5.1: `1` = owner+SYSTEM protected allow-list. The only v1 value. */
export const FRONT_SDDL_KIND = PIPE_FRONT_SDDL_KIND;

/**
 * Protocol 5.1's `maxRaw`, DERIVED from the listener's own socket cap.
 *
 * The front's raw handle bound and main's listener bound are the same number
 * for the same reason (16 established + 4 handshaking + 1 overflow slot), and
 * spelling `21` here would be a second owner of a bound `bounds.ts` already
 * holds. The front's `listener.MaxRawHandles` is the third copy and the vector
 * suite is what keeps all three equal.
 */
export const FRONT_MAX_RAW = STUDIO_MAX_LISTENER_SOCKETS;

/** Protocol 11: per-connection credit main grants, front -> main. */
export const FRONT_CREDIT_BYTES = 65536;

/** Protocol 11: `chunkBytes`, which is the data planes' payload bound. */
export const FRONT_CHUNK_BYTES = PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES;

/**
 * Protocol 9: the handshake deadline the FRONT owns, measured from `Accept`.
 *
 * It is the endpoint contract's own 5000 ms, taken from the module that owns
 * it, so main cannot tell the front a deadline that differs from the one main's
 * direct-socket path applies on Linux and macOS.
 */
export const FRONT_HANDSHAKE_DEADLINE_MS = STUDIO_HANDSHAKE_DEADLINE_MS;

/** Protocol 8: the `LOCK_ACK` deadline. Past it main kills and restarts LOCKED. */
export const FRONT_LOCK_ACK_DEADLINE_MS = 1_000;

/**
 * The BOUND flags main REQUIRES Windows to have confirmed at runtime.
 *
 * `firstInstance` proves the front CREATED the pipe rather than joining one
 * another process already owns - which is the named-pipe form of the
 * stale-endpoint check the unix path performs with a connect probe.
 * `messageMode` is what makes `CloseWrite` available (endpoint contract 3.5),
 * and without it a half-close is not expressible on this transport at all.
 *
 * `rejectRemote` is required too, and it is listed apart in `FRONT_BOUND_
 * REQUIRED_FLAGS` only because its absence has its own history: the whole
 * Windows gate exists because libuv creates the pipe WITHOUT
 * `PIPE_REJECT_REMOTE_CLIENTS`. A front that asked for it and could not read it
 * back reports `0` (protocol 6.2 forbids echoing the request), and main fails
 * closed rather than publishing a listener with a security property it cannot
 * demonstrate.
 */
export const FRONT_BOUND_REQUIRED_FLAGS =
  PIPE_FRONT_BOUND_FLAGS.rejectRemote
  | PIPE_FRONT_BOUND_FLAGS.firstInstance
  | PIPE_FRONT_BOUND_FLAGS.messageMode;

/**
 * Every way the front relationship can end, as ONE closed vocabulary that both
 * the structural log and the host-status mapping read.
 *
 * They are names, never sentences: the log line carries the name plus counts
 * (protocol 10 permits the plane, the type, the length, the sequence and the
 * reason, and nothing else), and the renderer sees only the mapped cause.
 */
export type FrontFailureName =
  /** The resolver has no binary: missing build, or a damaged installation. */
  | "binary_unavailable"
  /** The platform has no front at all. Not a failure. */
  | "unsupported_platform"
  /** `child_process.spawn` threw, or the child raised `error`. */
  | "spawn_failed"
  /** The child exited before or after serving, without being asked to. */
  | "child_exit"
  /** A plane reached EOF while the front was supposed to be live. */
  | "plane_eof"
  /** A plane raised an I/O error. */
  | "plane_io_error"
  /** A frame from the front did not parse (protocol 10). */
  | "malformed_frame"
  /** `HELLO_ACK` carried a protocol version this main does not speak. */
  | "hello_ack_version"
  /** `HELLO_ACK`'s pid is not the pid `spawn` returned (protocol 6.1). */
  | "hello_ack_pid"
  /** `HELLO_ACK` announced a generation main has already seen (protocol 4). */
  | "hello_ack_generation_reused"
  /** A frame arrived in a state where the protocol does not allow it. */
  | "unexpected_frame"
  /** `BOUND` echoed a pipe name that is not the one main told it to serve. */
  | "bound_pipe_name"
  /** `BOUND` did not confirm every flag main requires (protocol 6.2). */
  | "bound_flags_unconfirmed"
  /** `ERROR` 5: the descriptor read back from the handle is not the one asked for. */
  | "sddl_readback_mismatch"
  /** `ERROR` 7: the u32 admission epoch is spent. */
  | "admission_epoch_exhausted"
  /** Any other `ERROR` code from the front's frozen closed set. */
  | "front_error"
  /** `LOCK_ACK` did not arrive within its 1000 ms deadline (protocol 8). */
  | "lock_ack_timeout"
  /**
   * `LOCK` was requested while the front had not yet answered `HELLO_ACK`.
   * Its planes still carry generation 0, so the frame cannot be encoded; the
   * child is killed and restarted LOCKED instead (the same rule QUIT follows).
   */
  | "lock_before_hello_ack"
  /** A `DATA` frame took a connection past its granted credit (12.3). */
  | "credit_overrun"
  /** A `DATA` or `END` arrived for a direction already ended (12.3). */
  | "data_after_end"
  /** A `WRITE_DONE` regressed, or named a sequence main never sent (12.3). */
  | "ack_regression"
  /** The restart budget is spent. */
  | "restart_budget_exhausted";

/**
 * What the HUMAN is told, per failure.
 *
 * FOUR causes for twenty failures, and the collapse is deliberate: the user's
 * REMEDY is what distinguishes a cause, and every packaging fault has the same
 * one. The name above is what the operator's log carries, so nothing is lost.
 */
export function frontFailureCause(
  name: FrontFailureName,
): StudioHostUnavailableCause {
  switch (name) {
    case "sddl_readback_mismatch":
    case "bound_flags_unconfirmed":
    case "bound_pipe_name":
      // Windows did not confirm the pipe's protection. FAIL CLOSED: this is the
      // one class where continuing would publish a listener whose security
      // property main cannot demonstrate.
      return "pipe_security_unconfirmed";
    case "restart_budget_exhausted":
      return "front_restart_budget_exhausted";
    case "admission_epoch_exhausted":
      return "admission_permanently_closed";
    default:
      // Everything else is a packaging or runtime fault of the child itself,
      // and the remedy is the same sentence: reinstall, or rebuild from source.
      return "front_unavailable";
  }
}

/** The `HELLO` frame main writes on plane 3, sequence 1, generation 0. */
export function composeFrontHello(input: {
  readonly pipeName: string;
  readonly initialAdmissionEpoch: number;
  readonly timeoutRefusalBytes: string;
}): PipeFrontFrame {
  return {
    plane: PIPE_FRONT_PLANE.controlDown,
    generation: 0,
    connection: 0,
    sequence: 1n,
    type: "HELLO",
    protocolVersion: FRONT_PROTOCOL_VERSION,
    sddlKind: FRONT_SDDL_KIND,
    maxRaw: FRONT_MAX_RAW,
    creditBytes: FRONT_CREDIT_BYTES,
    chunkBytes: FRONT_CHUNK_BYTES,
    handshakeDeadlineMs: FRONT_HANDSHAKE_DEADLINE_MS,
    initialAdmissionEpoch: input.initialAdmissionEpoch,
    pipeName: input.pipeName,
    timeoutRefusalBytes: input.timeoutRefusalBytes,
  };
}

export type FrontHandshakeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: FrontFailureName; readonly detail: string };

/**
 * Validate `HELLO_ACK` BEFORE any later frame of the same batch is acted on.
 *
 * Protocol 6.1 makes the ordering normative: the codec ADOPTS the announced
 * generation while decoding, because every frame after `HELLO_ACK` in the same
 * `push` would otherwise be `bad_generation`. Adoption is a FRAMING decision
 * and proves nothing semantic, so a front could attach a `BOUND` and an `OPEN`
 * behind an ack main is about to reject. The supervisor walks the batch in
 * order, calls this first, and discards the tail on failure.
 *
 * `seenGenerations` is main's app-lifetime memory. Only main survives a restart,
 * so only main can reject a generation a dead front already used - which is the
 * bookkeeping protocol section 4 assigns to it by name.
 */
export function validateFrontHelloAck(
  frame: PipeFrontFrame,
  context: {
    readonly childPid: number | undefined;
    readonly seenGenerations: ReadonlySet<number>;
  },
): FrontHandshakeCheck {
  if (frame.type !== "HELLO_ACK") {
    return {
      ok: false,
      failure: "unexpected_frame",
      detail: `expected HELLO_ACK, got ${frame.type}`,
    };
  }
  if (frame.protocolVersion !== FRONT_PROTOCOL_VERSION) {
    return {
      ok: false,
      failure: "hello_ack_version",
      detail: `front speaks v${String(frame.protocolVersion)}`,
    };
  }
  // A CONSISTENCY CHECK, never authentication (protocol 6.1). Main's authority
  // over the front comes from having spawned a packaged binary at a path it
  // controls; a pid an attacker could choose is evidence of nothing. A
  // MISMATCH, however, means main is talking to a process it did not start,
  // which is fatal in the structural sense.
  if (context.childPid === undefined || frame.pid !== context.childPid) {
    return {
      ok: false,
      failure: "hello_ack_pid",
      detail: "the ack names a process main did not spawn",
    };
  }
  if (frame.announcedGeneration === 0) {
    // Unreachable through the codec, which rejects it as `generation_zero`.
    // Checked anyway: this function is the semantic gate and must not depend on
    // a framing check to hold a semantic invariant.
    return {
      ok: false,
      failure: "hello_ack_generation_reused",
      detail: "the ack announced the bootstrap generation",
    };
  }
  if (context.seenGenerations.has(frame.announcedGeneration)) {
    return {
      ok: false,
      failure: "hello_ack_generation_reused",
      detail: "this main has already served that generation",
    };
  }
  return { ok: true };
}

/**
 * Validate `BOUND`. The flags are what Windows CONFIRMED, never what was asked.
 *
 * Protocol 6.2: a flag the front requested and could not read back is reported
 * as `0`, and main decides. For v1 main REFUSES to publish the listener, which
 * is the fail-closed answer rule 90 requires of a wallet transport: a listener
 * announced with `rejectRemote` unconfirmed is a listener whose cross-user
 * posture is exactly the unknown the whole Windows gate exists for.
 */
export function validateFrontBound(
  frame: PipeFrontFrame,
  context: { readonly pipeName: string },
): FrontHandshakeCheck {
  if (frame.type !== "BOUND") {
    return {
      ok: false,
      failure: "unexpected_frame",
      detail: `expected BOUND, got ${frame.type}`,
    };
  }
  if (frame.pipeName !== context.pipeName) {
    // The echo exists so main can assert the front served the name it was
    // TOLD to serve. The names are never logged: the mismatch is the fact.
    return {
      ok: false,
      failure: "bound_pipe_name",
      detail: "the front bound a name other than the one HELLO carried",
    };
  }
  const missing = FRONT_BOUND_REQUIRED_FLAGS & ~frame.flagsApplied;
  if (missing !== 0) {
    return {
      ok: false,
      failure: "bound_flags_unconfirmed",
      detail: `unconfirmed flag mask ${String(missing)}`,
    };
  }
  return { ok: true };
}

/**
 * IS A RESTART A REMEDY FOR THIS FAILURE?
 *
 * The split is the whole value of the restart budget. A front that died under
 * load, lost a plane or broke a flow-control invariant may well come up clean,
 * and restarting is the honest response. A front that could not have its
 * security flags confirmed, that speaks a different protocol version, that
 * refused main's frozen `HELLO` numbers, or whose epoch is spent will produce
 * the IDENTICAL result on the next spawn, and restarting it six times only
 * delays the truthful message by six spawns.
 */
export function frontFailureIsRestartable(failure: FrontFailureName): boolean {
  switch (failure) {
    case "binary_unavailable":
    case "unsupported_platform":
    case "hello_ack_version":
    case "bound_flags_unconfirmed":
    case "bound_pipe_name":
    case "sddl_readback_mismatch":
    case "admission_epoch_exhausted":
    case "restart_budget_exhausted":
      return false;
    default:
      return true;
  }
}

/**
 * The front's exit codes are a CLOSED set with one meaning each
 * (`bridge/internal/front/lifecycle/exit.go`), so main can tell "the front
 * refused the packaging it was given" from "the front broke under load"
 * without parsing a sentence.
 */
export function frontExitFailure(code: number | null): FrontFailureName {
  switch (code) {
    case 2:
      return "unsupported_platform";
    case 3:
      // The front's compiled-in constants differ from main's frozen HELLO
      // numbers. Main and the front ship in one signed package, so this is a
      // packaging fault and a restart is not a remedy.
      return "hello_ack_version";
    case 4:
      return "malformed_frame";
    case 6:
      return "bound_flags_unconfirmed";
    case 7:
      return "credit_overrun";
    default:
      return "child_exit";
  }
}
