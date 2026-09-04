/**
 * THE WINDOWS BRANCH OF THE LISTENER: the endpoint served by a child process.
 *
 * `listener.ts` binds a unix socket with `server.listen` and owns the handle.
 * On Windows under this transport main owns no handle at all - the packaged
 * `vex-pipe-front` child creates the named pipe, applies the security
 * descriptor, verifies it by reading it back, and relays frames over inherited
 * stdio. This module is the seam between the two: the listener asks it to bring
 * an endpoint up, and everything about processes, planes, generations and the
 * restart budget stays behind it.
 *
 * It exists as its own module rather than as a branch inside `listener.ts` for
 * the reason rule 03 gives: it has its own lifecycle owner (a child process),
 * its own failure vocabulary and its own tests, and folding it in would have
 * put a second lifecycle in a file whose whole documented value is owning ONE.
 *
 * ## What it consults, and what the listener therefore still does not know
 *
 * It reads ADMISSION, which the listener deliberately does not: the pipe front
 * needs main's current epoch for `HELLO` and for every `ADMIT`, and it answers
 * a locked Vex with `REFUSE` before a byte is read (protocol 8). That is the
 * same authority question `mcp-host.ts` answers on the direct-socket path,
 * asked one process earlier because this transport has a primitive for it.
 *
 * ## The one behavioural difference from the direct-socket path, stated
 *
 * A LOCKED OR UNREADY HOST REFUSES BEFORE THE CONNECTION IS REGISTERED. On a
 * socket the refusal is written after `StudioConnection` exists, because there
 * is no way to answer a socket without reading it. Here `REFUSE(conn, bytes)`
 * writes main's exact bytes and closes WITHOUT EVER READING, so no connection
 * object, no handshake-pending slot and no `data` listener is created at all.
 * The bytes the peer sees are identical, and they are authored in the same
 * place (`handshake.ts`).
 */

import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";

import type { StudioHostUnavailableCause } from "@shared/schemas/studio.js";

import { log } from "../../logger/index.js";
import {
  locateStudioPipeFront,
  type StudioPipeFrontLocation,
} from "../installer/bridge-path.js";
import { studioAdmission, studioAdmissionEpoch } from "./admission.js";
import { frontFailureCause } from "./front-handshake.js";
import type { FrontSpawn } from "./front-spawn.js";
import { FrontSupervisor } from "./front-supervisor.js";
import {
  encodeStudioHandshakeAck,
  handshakeTimeoutRefusal,
  lockedRefusal,
} from "./handshake.js";

export type StudioFrontStart =
  | { readonly started: true }
  | {
      readonly started: false;
      readonly reason: string;
      readonly cause: StudioHostUnavailableCause;
    };

export interface StudioFrontEndpointInput {
  /** The pipe name MAIN derived. The front serves it and never derives one. */
  readonly pipeName: string;
  /** Every admitted connection, as the contract every consumer already speaks. */
  readonly onConnection: (wire: StudioDuplexTransport) => void;
  /** Republish the host status. */
  readonly onTransition: () => void;
  /** Test seam: the resolver. Production passes nothing. */
  readonly locate?: () => Promise<StudioPipeFrontLocation>;
  /** Test seam: the spawn. Production passes nothing. */
  readonly spawnFront?: FrontSpawn;
}

/**
 * The ONE supervisor for this process, held at module scope exactly as the
 * listener holds its server: there is one endpoint, so there is one front.
 */
let supervisor: FrontSupervisor | null = null;

/**
 * Bring the front up and wait for `BOUND`.
 *
 * Returns started only once the front has created the pipe AND Windows has
 * confirmed every flag main requires. A front that spawned and answered
 * `HELLO_ACK` has served nothing, so nothing is published for it.
 */
export async function startStudioFrontEndpoint(
  input: StudioFrontEndpointInput,
): Promise<StudioFrontStart> {
  if (supervisor !== null && supervisor.currentState() === "serving") {
    return { started: true };
  }

  // A PREVIOUS ATTEMPT'S SUPERVISOR IS DISPOSED BEFORE A NEW ONE EXISTS.
  // Dropping the reference would leave its bring-up timer armed and its child
  // alive, and the timer would fire into a supervisor nothing can reach - the
  // "every handle has an owner" rule applied to the retry path, which is
  // exactly where it is easiest to miss.
  supervisor?.dispose();
  supervisor = null;

  const locate = input.locate ?? ((): Promise<StudioPipeFrontLocation> => locateStudioPipeFront());
  const location = await locate();
  if (location.kind !== "found") {
    // `unsupported_platform` and `unavailable` are different facts and the
    // resolver keeps them apart, but the user's remedy is the same sentence, so
    // they share one cause and the DETAIL stays in this log line.
    return {
      started: false,
      reason: location.detail,
      cause: "front_unavailable",
    };
  }

  const front = new FrontSupervisor({
    pipeName: input.pipeName,
    command: location.command,
    admissionEpoch: studioAdmissionEpoch,
    // MAIN AUTHORS EVERY LINE THE PEER SEES (protocol 9). The front owns the
    // handshake timer because it owns `Accept`; it does not own the words.
    timeoutRefusalBytes: encodeStudioHandshakeAck({
      ok: false,
      code: handshakeTimeoutRefusal().code,
      message: handshakeTimeoutRefusal().message,
    }),
    refuseBeforeRead: refuseBeforeRead,
    onConnection: input.onConnection,
    onTransition: input.onTransition,
    spawnFront: input.spawnFront,
  });
  supervisor = front;

  const outcome = await front.start();
  if (outcome.started) return { started: true };
  return {
    started: false,
    reason: `The Vex Studio pipe front did not start (${outcome.failure}): ${outcome.detail}`,
    cause: frontFailureCause(outcome.failure),
  };
}

/**
 * Main's answer for one connection BEFORE a byte of it is read, or `null` to
 * admit.
 *
 * Both non-ready admission states take this path and both carry the `locked`
 * code, exactly as `handleConnection` does on the socket path: the closed set
 * the v1 bridge switches on covers "Vex is locked, still starting, or shutting
 * down" with that one member, and the MESSAGE carries the honest distinction.
 */
function refuseBeforeRead(): string | null {
  const admission = studioAdmission();
  if (admission.state === "ready") return null;
  const refusal = lockedRefusal(admission.cause);
  return encodeStudioHandshakeAck({
    ok: false,
    code: refusal.code,
    message: refusal.message,
  });
}

/**
 * The front's failure as a renderer-visible cause, or `null` while it is fine.
 *
 * The host status reads it so a Windows user is told which of the four things
 * happened - the helper is missing, Windows would not confirm the pipe's
 * protection, the helper crash-looped, or the fence is spent - rather than one
 * word covering all four.
 */
export function studioFrontCause(): StudioHostUnavailableCause | null {
  const failure = supervisor?.failure() ?? null;
  return failure === null ? null : frontFailureCause(failure);
}

/**
 * THE PRIORITY LOCK, synchronous in main.
 *
 * Called from `lockStudioMcpHost` in the same tick it decides, AFTER admission
 * has been closed and the epoch advanced, so the `LOCK` frame carries the new
 * epoch and every `ADMIT` queued behind it at the front is purged.
 */
export function lockStudioFrontEndpoint(): void {
  supervisor?.lock();
}

/**
 * QUIT, under the caller's ONE absolute budget.
 *
 * `remainingMs` is what is left of `STUDIO_HOST_SHUTDOWN_DEADLINE_MS` at this
 * moment, and `deadline` is the SAME promise the host's other quit stages race,
 * so main and the front share one clock rather than arming five seconds each.
 */
export async function quitStudioFrontEndpoint(
  remainingMs: number,
  deadline: Promise<void>,
): Promise<void> {
  const front = supervisor;
  supervisor = null;
  if (front === null) return;
  try {
    await front.quit(remainingMs, deadline);
  } catch (cause: unknown) {
    log.warn(
      `[studio:front] quit failed: ${cause instanceof Error ? cause.name : "unknown"}`,
    );
  }
}

/** Test seam: drop the front this process owns. */
export function resetStudioFrontEndpointForTests(): void {
  supervisor?.dispose();
  supervisor = null;
}
