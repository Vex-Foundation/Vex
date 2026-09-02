/**
 * The Vex Studio MCP HOST: the public face of the local endpoint an external
 * coding agent's bridge connects to, and the owner of WHO IS CONNECTED.
 *
 * ## Two lifecycles, two owners, one facade
 *
 * The host used to be one state machine, and it conflated two independent
 * questions. It now delegates both and keeps the connection registry:
 *
 *   - `mcp-host/listener.ts` owns the TRANSPORT (`stopped -> starting ->
 *     listening -> shutting_down`): planning, verifying and binding the
 *     endpoint, and closing it on quit.
 *   - `mcp-host/admission.ts` owns AUTHORITY (`locked | unready | ready`): may
 *     what arrives on that socket be served, and the epoch that fences every
 *     in-flight establish when the answer becomes no.
 *   - THIS module owns the connection registry, the bounds, and the derived
 *     renderer-visible status, and it is the entry point every caller uses.
 *
 * The listener is bound ONCE at app-ready, as soon as the executor is
 * configured, and it is independent of the vault and of the settlement barrier.
 * Only application quit closes it.
 *
 * ## What a LOCKED host does, and why binding it is not an open door
 *
 * A locked host reads NOTHING from a peer. The connection is accepted, a typed
 * `locked` handshake refusal is written (a code the v1 bridge already switches
 * on - contract section 2.2), and the connection is closed: no project bytes
 * are read, no project identifier travels in either direction, no
 * established-connection slot is claimed, and no idle connection is held. What
 * the always-bound listener buys is the ability to say "Vex is locked" instead
 * of a connection error that also means "Vex is not installed" and "Vex is
 * still starting".
 *
 * ## The lock order, and why the host sits where it does
 *
 * `secrets/session.ts` performs, in this order:
 *
 *   1. the synchronous scrub and signing revocation, UNCHANGED and FIRST;
 *   2. `lockStudioMcpHost()` - close ADMISSION (advancing the fence epoch) and
 *      destroy every registered socket SYNCHRONOUSLY, while the LISTENER and
 *      its endpoint survive;
 *   3. the existing provider reset, dispatch-generation advance and durable
 *      refusal pass.
 *
 * Step 2 is synchronous on purpose. The generation advance in step 3 must not
 * wait on a per-connection EOF refusal: the advance is the fence that stops a
 * queued action from dispatching, and delaying it behind network teardown
 * would keep that fence down for as long as a peer took to notice. Destroying
 * the sockets in the same tick starts each connection's abort chain with the
 * TRUSTED cause `lock`, and the broker's withdrawal path writes exactly that
 * into `approval_intents.refusal_reason` - the same reason the global refusal
 * pass in step 3 uses, so their CAS race cannot produce a misleading
 * settlement.
 */

import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import type {
  StudioHostStatus,
  StudioHostUnavailableCause,
} from "@shared/schemas/studio.js";

import { publishStudioHostStatus } from "./host-status.js";
import { onStudioReadinessChange } from "./readiness.js";
import {
  closeStudioAdmission,
  openStudioAdmission,
  resetStudioAdmissionForTests,
  studioAdmission,
  studioAdmissionEpoch,
} from "./mcp-host/admission.js";
import {
  closeStudioListener,
  markStudioListenerShuttingDown,
  resetStudioListenerForTests,
  startStudioListener,
  studioConfigDirHashInput,
  studioListenerCause,
  studioListenerEndpoint,
  studioListenerPhase,
  type StudioHostStart,
  type StudioListenerDeps,
} from "./mcp-host/listener.js";
import {
  STUDIO_HOST_SHUTDOWN_DEADLINE_MS,
  STUDIO_MAX_CONNECTIONS,
  STUDIO_MAX_HANDSHAKE_PENDING,
  STUDIO_MAX_INFLIGHT_GLOBAL,
  STUDIO_MAX_LISTENER_SOCKETS,
} from "./mcp-host/bounds.js";
import {
  atCapacityRefusal,
  lockedRefusal,
  unknownProjectRefusal,
  type StudioHandshakeRefused,
} from "./mcp-host/handshake.js";
import { serveOverSocket } from "./mcp-host/serve.js";
import { NodeSocketTransport } from "./mcp-host/node-socket-transport.js";
import {
  StudioConnection,
  type CallSlotOutcome,
  type ConnectionSlotOutcome,
  type ServeConnectionInput,
  type StudioRunCall,
} from "./mcp-host/connection.js";

export {
  STUDIO_HOST_SHUTDOWN_DEADLINE_MS,
  STUDIO_MAX_CONNECTIONS,
  STUDIO_MAX_HANDSHAKE_PENDING,
  STUDIO_MAX_INFLIGHT_GLOBAL,
  STUDIO_MAX_LISTENER_SOCKETS,
};
export { studioConfigDirHashInput };
export type { StudioHostStart };

const connections = new Set<StudioConnection>();
let globalInFlight = 0;

/**
 * Established-connection RESERVATIONS, claimed synchronously.
 *
 * Not derived from `connections`: counting serving connections after the
 * asynchronous project check let two handshakes at 15 both proceed and yield
 * 17. This number is incremented in the same tick the handshake line parses, so
 * the second of two concurrent handshakes sees the first one's claim.
 */
let reservedConnections = 0;

/**
 * THE RENDERER-VISIBLE STATUS, derived from the two owners and nothing else.
 *
 * Derived rather than stored so it cannot drift from the facts it describes:
 * there is no second variable to forget to update, and every transition site
 * simply calls `emitHostStatus()` after mutating whatever it owns.
 *
 * Precedence is deliberate, and it reads TRANSPORT FIRST. A host that could not
 * bind is broken in a way the user may be able to repair, and saying "locked"
 * over the top of it would hide a real failure behind a state that resolves
 * itself on the next unlock. Once the transport is up, the honest word is the
 * admission one: `locked` while the vault is locked, the barrier's own code
 * while it is still closed, and `running` when a peer would actually be served.
 */
function currentHostStatus(): StudioHostStatus {
  const connectionCount = reservedConnections;
  const base = {
    connectionCount,
    maxConnections: STUDIO_MAX_CONNECTIONS,
    atCapacity: connectionCount >= STUDIO_MAX_CONNECTIONS,
  } as const;
  const phase = studioListenerPhase();
  if (phase === "shutting_down") {
    return { ...base, state: "unavailable", cause: "shutting_down" };
  }
  if (phase === "starting") return { ...base, state: "starting", cause: null };
  if (phase === "stopped") {
    return { ...base, state: "unavailable", cause: studioListenerCause() };
  }
  const admission = studioAdmission();
  if (admission.state === "locked") return { ...base, state: "locked", cause: null };
  if (admission.state === "unready") {
    return { ...base, state: "unavailable", cause: admission.code };
  }
  return { ...base, state: "running", cause: null };
}

/**
 * Publish the current status. Identical consecutive payloads are coalesced by
 * the cache, so calling this from every transition site is cheap and the sites
 * do not have to reason about whether anything visible actually changed.
 */
function emitHostStatus(): void {
  publishStudioHostStatus(currentHostStatus());
}

/**
 * The barrier moves on its own - it has a bounded registration retry that can
 * open it long after any host transition - and admission is DERIVED from it, so
 * the only thing missing is a republication. One listener, for the life of the
 * process, owned by this module scope: there is no window, no timer and no
 * per-call registration behind it, so there is nothing to dispose.
 */
onStudioReadinessChange(emitHostStatus);

/** The admission fence epoch. Exposed for the race tests. */
export function studioMcpAdmissionEpoch(): number {
  return studioAdmissionEpoch();
}

/** Established-connection reservations outstanding. Exposed for the bound tests. */
export function studioMcpReservedConnectionCount(): number {
  return reservedConnections;
}

/** Claim one established-connection slot, or refuse. Release is idempotent. */
function reserveConnectionSlot(): ConnectionSlotOutcome {
  if (reservedConnections >= STUDIO_MAX_CONNECTIONS) {
    // The ESTABLISHED bound. This one really is "Studio is full", so the emit
    // here carries `atCapacity: true` - unlike the handshake-pending refusal in
    // `handleConnection`, which is a different and much smaller queue.
    emitHostStatus();
    return {
      ok: false,
      refusal: atCapacityRefusal(STUDIO_MAX_CONNECTIONS, "MCP connections"),
    };
  }
  reservedConnections += 1;
  emitHostStatus();
  let released = false;
  return {
    ok: true,
    release: (): void => {
      if (released) return;
      released = true;
      reservedConnections -= 1;
      emitHostStatus();
    },
  };
}

/** The bound endpoint, or null. Exposed for diagnostics and tests. */
export function studioMcpHostEndpoint(): string | null {
  return studioListenerEndpoint();
}

/** Established plus handshaking connections. Exposed for the bound tests. */
export function studioMcpConnectionCount(): number {
  return connections.size;
}

export interface StudioHostDeps {
  readonly runCall: StudioRunCall;
  /** NON-AUTHORITATIVE handshake check. Its result is discarded after the ack. */
  readonly projectExists: (projectId: string) => Promise<boolean>;
}

let hostDeps: StudioHostDeps | null = null;

/** Install the host's collaborators. Called once at startup, and by tests. */
export function configureStudioMcpHost(deps: StudioHostDeps): void {
  hostDeps = deps;
}

const listenerDeps: StudioListenerDeps = {
  onConnection: handleConnection,
  onTransition: emitHostStatus,
  precondition: (): {
    readonly reason: string;
    readonly cause: StudioHostUnavailableCause;
  } | null =>
    hostDeps === null
      ? {
          reason: "The Vex Studio MCP host has no executor configured.",
          cause: "not_configured",
        }
      : null,
};

/**
 * Bind the listener. Idempotent and single-flight.
 *
 * It NEVER touches admission: a bound listener on a locked Vex is the designed
 * boot state, and the settlement barrier gates handshakes and calls rather than
 * this bind.
 */
export function startStudioMcpHost(): Promise<StudioHostStart> {
  return startStudioListener(listenerDeps);
}

/**
 * OPEN ADMISSION. The counterpart of `lockStudioMcpHost`, and it touches the
 * transport as little as `startStudioMcpHost` touches the door.
 *
 * The CALLER owns the proof that opening is safe: `secrets/session.ts` calls
 * this only once its dispatch-generation advance has committed, its poison is
 * clear and its pending durable refusal has been written.
 */
export function openStudioMcpAdmission(): void {
  openStudioAdmission();
  emitHostStatus();
}

function handleConnection(socket: Socket): void {
  const deps = hostDeps;
  if (deps === null) {
    // Unreachable while listening (the bind precondition refuses without an
    // executor) and still fail-closed: there is nothing to serve and nothing
    // honest to say about a host that was torn down under its own listener.
    socket.destroy();
    return;
  }

  // The admission epoch this connection belongs to. A lock or a quit advances
  // it, and every establish continuation refuses to publish once it has.
  const epoch = studioAdmissionEpoch();
  // THE ADAPTER BOUNDARY. Past this line nothing in the connection, the
  // outbound queue or the engine's transport knows what carries the bytes: the
  // socket is wrapped into the engine's `StudioDuplexTransport` contract here,
  // where main still owns `node:net`, so the Windows pipe-front can be a second
  // wrapper rather than a second protocol.
  const wire = new NodeSocketTransport(socket);
  const connection = new StudioConnection(`c-${randomUUID().slice(0, 8)}`, wire, {
    runCall: deps.runCall,
    acquireCallSlot,
    // Connection 17 is REFUSED with a typed ack and nobody is evicted: an
    // approval-blocked connection has no traffic and is not idle, so
    // "least recently used" would pick exactly the one a human is deciding.
    reserveConnectionSlot,
    isStale: (): boolean =>
      epoch !== studioAdmissionEpoch() || studioAdmission().state === "locked",
    checkProject: async (projectId: string): Promise<StudioHandshakeRefused | null> => {
      const admission = studioAdmission();
      if (admission.state !== "ready") return lockedRefusal(admission.cause);
      // NON-AUTHORITATIVE, and discarded after the ack: `runStudioCall` loads
      // the real scope atomically on every call.
      const exists = await deps.projectExists(projectId);
      return exists ? null : unknownProjectRefusal();
    },
    serveConnection: (input: ServeConnectionInput) =>
      serveOverSocket(input, {
        epoch,
        currentEpoch: () => studioAdmissionEpoch(),
        version: process.env["VEX_APP_VERSION"] ?? "0.0.0",
      }),
    onClosed: (closed) => {
      connections.delete(closed);
      emitHostStatus();
    },
  });
  connections.add(connection);
  emitHostStatus();

  // A HOST THAT CANNOT SERVE ANSWERS BEFORE IT READS. `refuse` latches the
  // terminal phase, detaches the data listener and pauses the socket
  // synchronously, in this tick, so the refusal is written without a single
  // project byte being parsed and the connection is closed rather than held
  // idle. It claims no established reservation, and it stops counting as
  // handshake-pending immediately, so a flood of refused connects can only
  // consume the raw listener bound and never the bounds a real bridge needs.
  //
  // Both non-ready admission states take this path, and both carry the `locked`
  // code: the closed set the v1 bridge switches on covers "Vex is locked, still
  // starting, or shutting down" with that one member (contract section 2.2),
  // and the MESSAGE carries the honest distinction - the vault sentence or the
  // settlement barrier's own.
  const admission = studioAdmission();
  if (admission.state !== "ready") {
    void connection.refuse(lockedRefusal(admission.cause));
    return;
  }

  // The HANDSHAKE-PENDING bound, checked at accept time because that is when a
  // pending socket appears. Registration happens first so the refusal leaves
  // through the same teardown path as every other close.
  const pending = [...connections].filter((item) => item.isHandshaking()).length;
  if (pending > STUDIO_MAX_HANDSHAKE_PENDING) {
    // A HANDSHAKE-PENDING refusal, which is NOT "Studio is full". It emits so
    // the renderer sees the churn, but `atCapacity` stays derived from the
    // ESTABLISHED reservations alone: telling a user their 16 connection slots
    // are gone because four sockets are mid-handshake would be false.
    emitHostStatus();
    void connection.refuse(
      atCapacityRefusal(STUDIO_MAX_HANDSHAKE_PENDING, "connections waiting to handshake"),
    );
  }
}

/** Claim one place in the global in-flight budget. */
function acquireCallSlot(): CallSlotOutcome {
  if (globalInFlight >= STUDIO_MAX_INFLIGHT_GLOBAL) {
    return {
      ok: false,
      reason:
        `Vex is already running ${String(STUDIO_MAX_INFLIGHT_GLOBAL)} Studio calls, `
        + "so this one was not queued. Nothing was executed. Wait for one to "
        + "finish and call again.",
    };
  }
  globalInFlight += 1;
  let released = false;
  return {
    ok: true,
    release: (): void => {
      if (released) return;
      released = true;
      globalInFlight -= 1;
    },
  };
}

/**
 * THE LOCK TEARDOWN, SYNCHRONOUS BY CONTRACT.
 *
 * Called from `lockSecretSession` immediately after the scrub and before the
 * dispatch-generation advance. Everything here happens in one tick: the
 * admission epoch advances (so no in-progress establish can publish anything),
 * admission closes, and every socket is destroyed with the TRUSTED cause the
 * CALLER named - `lock` for a user relock, `vex_quit` when the quit hooks lock
 * the session. Threading it is what keeps one event from writing two different
 * reasons into the durable audit column. The asynchronous remainder of each
 * connection's teardown (the pinned instance's close, the durable refusal the
 * abort triggers) runs afterwards and is deliberately NOT awaited here - the
 * advance must not wait for a peer to notice its socket is gone.
 *
 * THE LISTENER AND ITS ENDPOINT SURVIVE. A relock closes the door, not the
 * building: the next connect is answered with a typed `locked` refusal rather
 * than a connection error, and an unlock reopens admission on the same bound
 * socket with no rebind and no endpoint change. Only quit closes the listener.
 */
export function lockStudioMcpHost(cause: "lock" | "vex_quit" = "lock"): void {
  // FIRST, and synchronously: every in-progress establish is stale from this
  // line on, so none of them can reach `serving` even though their own awaits
  // have not resumed yet.
  closeStudioAdmission();
  // A quit-caused lock latches the terminal transport phase in the same tick,
  // so the status can never read `locked` (which invites the user to unlock)
  // while the application is leaving. The ordered quit task closes the listener
  // itself, in its own stage.
  if (cause === "vex_quit") markStudioListenerShuttingDown(listenerDeps);
  for (const connection of [...connections]) {
    connection.destroyNow(cause);
  }
  emitHostStatus();
}

/**
 * The ORDERED QUIT teardown: listener first, then connections, then settle.
 *
 * ONE ABSOLUTE DEADLINE for the whole teardown, not one per stage. The two
 * stages used to arm 5 s each, so a listener that took its full budget and a
 * connection that then took its own held the quit for 10 s while advertising a
 * 5 s bound. A deadline that a caller can add up is not a bound. The clock
 * starts here and both waits race the SAME promise, so `STUDIO_HOST_SHUTDOWN_
 * DEADLINE_MS` is the real ceiling on this function.
 *
 * The cause is `vex_quit`, which is what the durable refusal records.
 */
export async function shutdownStudioMcpHost(): Promise<void> {
  closeStudioAdmission();

  let releaseDeadline = (): void => undefined;
  const deadlineTimer = setTimeout(() => {
    releaseDeadline();
  }, STUDIO_HOST_SHUTDOWN_DEADLINE_MS);
  deadlineTimer.unref?.();
  const deadline = new Promise<void>((resolve) => {
    releaseDeadline = resolve;
  });

  try {
    // Emitted BEFORE the drain by the listener's own transition, not after: a
    // quit that takes its full 5 s budget should show as shutting down for
    // those 5 s, not report nothing until the window it would have been
    // rendered in is already gone.
    await closeStudioListener(deadline, listenerDeps);
    const open = [...connections];
    for (const connection of open) connection.destroyNow("vex_quit");
    await Promise.race([
      Promise.allSettled(open.map((connection) => connection.dispose("vex_quit"))),
      deadline,
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    // The deadline promise has one consumer per stage and no other owner; the
    // resolve keeps a late `await` from parking on a timer that is gone.
    releaseDeadline();
    connections.clear();
    globalInFlight = 0;
    reservedConnections = 0;
    emitHostStatus();
  }
}

/** Test seam: forget every host-owned handle between cases. */
export function resetStudioMcpHostForTests(): void {
  resetStudioListenerForTests();
  resetStudioAdmissionForTests();
  connections.clear();
  globalInFlight = 0;
  reservedConnections = 0;
  hostDeps = null;
}
