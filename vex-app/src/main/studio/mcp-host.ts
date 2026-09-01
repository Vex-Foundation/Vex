/**
 * The Vex Studio MCP HOST: the one owner of the local socket an external
 * coding agent's bridge connects to.
 *
 * ## The listener exists only while Vex is UNLOCKED and READY
 *
 * A listener that is always up would widen the locked attack surface for the
 * sake of a nicer diagnostic. The accepted trade is that a bridge sees one
 * combined "Vex is not running or locked" message; the alternative was an
 * always-open door on a self-custodial wallet. So `startStudioMcpHost` runs
 * after an unlock and after the A3 readiness barrier reports ready, and
 * `lockStudioMcpHost` closes the listener synchronously on a relock.
 *
 * ## The lock order, and why the host sits where it does
 *
 * `secrets/session.ts` performs, in this order:
 *
 *   1. the synchronous scrub and signing revocation, UNCHANGED and FIRST;
 *   2. `lockStudioMcpHost()` - mark locked, close the listener, destroy every
 *      registered socket SYNCHRONOUSLY;
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
 *
 * ## Windows
 *
 * The endpoint is a NAMED PIPE, served exactly the way VS Code serves its main
 * IPC: a hash-derived predictable name (`\\.\pipe\vex-studio-<hash>`, same
 * discriminator as the unix socket) bound with a plain `server.listen`, with
 * NO custom security descriptor. Verified in the reference checkout:
 * `createStaticIPCHandle` does exactly this, and `src/vs/base` plus
 * `src/vs/platform` contain zero security-descriptor handling; the boundary is
 * the documented Windows default pipe SD plus protocol-level validation.
 *
 * Two lifecycle differences follow from the transport, and only two:
 *
 *   - THERE IS NO UNLINK. A pipe exists only while its server does, so there
 *     is no stale file to remove and no directory whose ownership and mode
 *     have to be proven first. The pipe's namespace is the operating system's.
 *   - THE STALE CHECK IS A CONNECT PROBE ONLY. A pipe that answers means
 *     another Vex owns it, and startup refuses rather than racing it.
 *
 * Everything else is identical: the same bounds, the same handshake, the same
 * unlock-bound listener lifecycle, the same approval gating.
 *
 * AND IT IS RUNTIME-DISABLED. `WINDOWS_TRANSPORT_PROVEN` in `mcp-host/
 * endpoint.ts` is false, so `runStart` refuses a pipe plan with
 * `windows_pending_platform_proof` before it reaches `server.listen`: libuv
 * creates the pipe with a NULL security descriptor and without
 * `PIPE_REJECT_REMOTE_CLIENTS`, whose default grants Everyone and the
 * anonymous logon READ, and a cross-user read-only connect against a wallet's
 * handshake-pending slots has never been measured. The pattern above stays and
 * stays vector-tested; only opening the transport is refused. The flag flips by
 * EXTENDING the required `bridge-windows` CI job with the contract's section
 * 1.6 proof matrix, not by editing this comment.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type {
  StudioHostStatus,
  StudioHostUnavailableCause,
} from "@shared/schemas/studio.js";

import { CONFIG_DIR } from "../paths/config-dir.js";
import { log } from "../logger/index.js";
import { publishStudioHostStatus } from "./host-status.js";
import { studioReadiness } from "./readiness.js";
import { planStudioEndpoint, unprovenWindowsTransport } from "./mcp-host/endpoint.js";
import {
  captureEndpointDirectoryChain,
  clearStaleEndpoint,
  nodeDirectoryProbe,
  prepareEndpointDirectory,
  refuseLiveEndpoint,
  verifyEndpointDirectoryChain,
} from "./mcp-host/bind.js";
import {
  atCapacityRefusal,
  lockedRefusal,
  unknownProjectRefusal,
  type StudioHandshakeRefused,
} from "./mcp-host/handshake.js";
import { serveOverSocket } from "./mcp-host/serve.js";
import {
  StudioConnection,
  type CallSlotOutcome,
  type ConnectionSlotOutcome,
  type ServeConnectionInput,
  type StudioRunCall,
} from "./mcp-host/connection.js";

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

export type StudioHostStart =
  | { readonly started: true; readonly endpoint: string }
  | { readonly started: false; readonly reason: string };

interface StartAttempt {
  readonly epoch: number;
  readonly promise: Promise<StudioHostStart>;
}

interface HostState {
  server: Server | null;
  endpoint: string | null;
  locked: boolean;
  starting: StartAttempt | null;
  /** The ONE follow-up start queued behind a stale attempt. */
  queued: StartAttempt | null;
}

const state: HostState = {
  server: null,
  endpoint: null,
  locked: false,
  starting: null,
  queued: null,
};
const connections = new Set<StudioConnection>();
let globalInFlight = 0;

/**
 * THE LIFECYCLE EPOCH: a monotonic counter every teardown advances.
 *
 * A start and a connection establish are both chains of awaits, and a lock or
 * a quit can land in any gap between them. Re-reading `state.locked` is not
 * enough on its own: an unlock that follows the lock closely enough would clear
 * it, and a stale continuation would then publish a listener or a serving
 * connection that belongs to a lifecycle nobody asked for. A captured epoch
 * cannot be cleared, so "is the world I started in still the current one" has
 * exactly one answer and it never becomes true again.
 *
 * Every async continuation captures it once, before its first await, and
 * re-checks before it publishes ANYTHING: the listener, the endpoint, a
 * serving phase. On a stale check the continuation closes what it acquired and
 * publishes nothing.
 */
let lifecycleEpoch = 0;

/**
 * Established-connection RESERVATIONS, claimed synchronously.
 *
 * Not derived from `connections` any more: counting serving connections after
 * the asynchronous project check let two handshakes at 15 both proceed and
 * yield 17. This number is incremented in the same tick the handshake line
 * parses, so the second of two concurrent handshakes sees the first one's
 * claim.
 */
let reservedConnections = 0;

/**
 * THE RENDERER-VISIBLE STATUS, derived from the state above and nothing else.
 *
 * Derived rather than stored so it cannot drift from the facts it describes:
 * there is no second variable to forget to update, and every transition site
 * simply calls `emitHostStatus()` after mutating whatever it owns.
 *
 * Precedence is deliberate. `shuttingDown` outranks everything because a quit
 * is terminal and a listener that is closing is not "locked" in the sense a
 * user means it. `locked` outranks `running` because the lock teardown clears
 * the server in the same tick it sets the flag. `starting` is only reachable
 * while an attempt is between its first line and its publication gate.
 */
let startsInFlight = 0;
let shuttingDown = false;
let lastUnavailableCause: StudioHostUnavailableCause = "starting";

function currentHostStatus(): StudioHostStatus {
  const connectionCount = reservedConnections;
  const atCapacity = connectionCount >= STUDIO_MAX_CONNECTIONS;
  const base = {
    connectionCount,
    maxConnections: STUDIO_MAX_CONNECTIONS,
    atCapacity,
  } as const;
  if (shuttingDown) {
    return { ...base, state: "unavailable", cause: "shutting_down" };
  }
  if (state.locked) return { ...base, state: "locked", cause: null };
  if (state.server !== null && state.endpoint !== null) {
    return { ...base, state: "running", cause: null };
  }
  if (startsInFlight > 0) return { ...base, state: "starting", cause: null };
  return { ...base, state: "unavailable", cause: lastUnavailableCause };
}

/**
 * Publish the current status. Identical consecutive payloads are coalesced by
 * the cache, so calling this from every transition site is cheap and the sites
 * do not have to reason about whether anything visible actually changed.
 */
function emitHostStatus(): void {
  publishStudioHostStatus(currentHostStatus());
}

/** The current lifecycle epoch. Exposed for the race tests. */
export function studioMcpLifecycleEpoch(): number {
  return lifecycleEpoch;
}

/** Established-connection reservations outstanding. Exposed for the bound tests. */
export function studioMcpReservedConnectionCount(): number {
  return reservedConnections;
}

/** Advance the epoch. Called by EVERY teardown, before it closes anything. */
function advanceLifecycleEpoch(): number {
  lifecycleEpoch += 1;
  return lifecycleEpoch;
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

/** Is the listener up right now? Exposed for diagnostics and tests. */
export function studioMcpHostEndpoint(): string | null {
  return state.endpoint;
}

/** Established plus handshaking connections. Exposed for the bound tests. */
export function studioMcpConnectionCount(): number {
  return connections.size;
}

/**
 * The config directory as the hash input: its REALPATH, with the LITERAL path
 * as the frozen fallback.
 *
 * Both sides of the wire hash the realpath so a symlinked config directory
 * cannot make the app and the bridge derive two different endpoints.
 *
 * The fallback is part of the CONTRACT (`bridge-endpoint-contract.md` section
 * 1.1, vector `realpathFallback`), not a local convenience: `realpath` fails
 * when the directory does not exist yet, which is every first run, and both
 * sides must answer that case the same way or the bridge would connect to a
 * path the app never bound. Refusing startup instead was rejected - it would
 * turn "Vex has not created its config directory yet" into "Studio does not
 * work", for a case with an answer both sides can derive with no shared code.
 *
 * The fallback is NOT a trust decision: the endpoint's own directory ownership
 * and mode are verified at bind time regardless of which string was hashed.
 */
export function studioConfigDirHashInput(): string {
  try {
    return realpathSync(CONFIG_DIR);
  } catch {
    return CONFIG_DIR;
  }
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

/**
 * Start the listener. Idempotent, single-flight, and refuses with a NAMED
 * cause rather than falling back to anything less verified.
 */
export function startStudioMcpHost(): Promise<StudioHostStart> {
  const inFlight = state.starting;
  if (inFlight === null) return beginStart();
  // SINGLE-FLIGHT PER EPOCH, not per process. An attempt whose epoch a lock has
  // invalidated can only refuse, so handing it to a caller who asked AFTER the
  // unlock told them "the host did not start" and left nothing running. The
  // current epoch gets a FRESH attempt, queued behind the stale one.
  if (inFlight.epoch === lifecycleEpoch) return inFlight.promise;
  return queueStartAfter(inFlight.promise);
}

/** Begin one attempt for the CURRENT epoch and publish it as in-flight. */
function beginStart(): Promise<StudioHostStart> {
  const epoch = lifecycleEpoch;
  const promise = runStart(epoch).finally(() => {
    if (state.starting?.promise === promise) state.starting = null;
  });
  state.starting = { epoch, promise };
  return promise;
}

/**
 * Queue exactly ONE fresh start behind a stale attempt. Bounded: the entry is
 * keyed by the epoch that asked for it, so callers in that epoch join the same
 * follow-up rather than chaining another one.
 */
function queueStartAfter(stale: Promise<StudioHostStart>): Promise<StudioHostStart> {
  const epoch = lifecycleEpoch;
  const queued = state.queued;
  if (queued !== null && queued.epoch === epoch) return queued.promise;
  const promise = runQueuedStart(stale, epoch);
  state.queued = { epoch, promise };
  return promise;
}

async function runQueuedStart(
  stale: Promise<StudioHostStart>,
  epoch: number,
): Promise<StudioHostStart> {
  // The stale attempt owns the endpoint path until it settles, however it
  // settles. Its rejection is not this caller's failure.
  await stale.catch(() => undefined);
  if (state.queued?.epoch === epoch) state.queued = null;
  // A teardown may have landed while this waited: that epoch queues its own
  // start, and this one refuses rather than binding for a dead lifecycle.
  if (epoch !== lifecycleEpoch) {
    return refusedStart(lockedSentence(), "endpoint_unavailable");
  }
  return startStudioMcpHost();
}

/**
 * One start attempt, under the epoch its caller captured BEFORE the first
 * await. Every gate below re-checks that epoch rather than `state.locked`,
 * which a later unlock could clear underneath a stale continuation.
 */
async function runStart(epoch: number): Promise<StudioHostStart> {
  if (state.server !== null && state.endpoint !== null) {
    return { started: true, endpoint: state.endpoint };
  }
  state.locked = false;
  // THE `starting` WINDOW OPENS HERE and closes in `finally` below, which is
  // what makes the state observable for exactly as long as an attempt is
  // between this line and its publication gate. It is a COUNTER rather than a
  // flag because a queued follow-up attempt can overlap a stale one.
  startsInFlight += 1;
  shuttingDown = false;
  emitHostStatus();
  try {
    return await runStartAttempt(epoch);
  } finally {
    startsInFlight -= 1;
    emitHostStatus();
  }
}

async function runStartAttempt(epoch: number): Promise<StudioHostStart> {
  // Inside the attempt, not before it, so that the `finally` above publishes
  // this refusal too. A refusal that returned before the `starting` window
  // opened left the cache holding whatever it said last, and the renderer was
  // never told the host had refused.
  if (hostDeps === null) {
    return refusedStart(
      "The Vex Studio MCP host has no executor configured.",
      "not_configured",
    );
  }

  const readiness = studioReadiness();
  if (!readiness.ready) return refusedStart(readiness.cause, readiness.code);

  const plan = planStudioEndpoint({
    platform: process.platform,
    configDirRealPath: studioConfigDirHashInput(),
    env: process.env,
    tmpdir: tmpdir(),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    probeDirectory: nodeDirectoryProbe,
  });
  if (plan.kind === "refused") {
    return refusedStart(plan.message, "endpoint_unavailable");
  }

  // THE WINDOWS RUNTIME GATE (contract 1.6). The pipe was PLANNED - derivation
  // and syntax are unchanged and still vector-tested - and the transport is
  // refused until a Windows runner has measured its security descriptor.
  const gated = unprovenWindowsTransport(plan);
  if (gated !== null && gated.kind === "refused") {
    // Its OWN cause, not `endpoint_unavailable`: nothing failed here. The pipe
    // was planned correctly and Vex declined to open it, so the renderer must
    // be able to say that instead of sending a Windows user to debug an
    // endpoint that is working exactly as designed.
    return refusedStart(gated.message, "windows_transport_disabled");
  }

  let verifyDirectoryIdentity = (): string | null => null;
  if (plan.kind === "pipe") {
    // DEFENSIVE, at the listen site itself. `planOverride` refuses pipe syntax
    // off win32 by name, and this is the second copy of that decision: a pipe
    // path handed to `server.listen` on Linux binds an ordinary FILE relative
    // to the process's working directory, which is a privileged listener in an
    // unverified location - the exact P4 failure this module exists to
    // prevent.
    if (process.platform !== "win32") {
      return refusedStart(
        `The Vex Studio MCP host will not bind the named pipe ${plan.path} on `
          + `${process.platform}: named pipes exist on Windows only, and binding `
          + "that name here would create an ordinary file, not an endpoint.",
        "endpoint_unavailable",
      );
    }
    // A pipe has no parent directory and no stale file: the ONLY question is
    // whether another Vex is already serving this name.
    const liveFailure = await refuseLiveEndpoint(plan.path);
    if (liveFailure !== null) {
      return refusedStart(liveFailure, "endpoint_unavailable");
    }
  } else {
    // Two steps, in this order: the parent must be proven private BEFORE any
    // decision about an entry inside it, because "is this stale socket safe to
    // remove" is only answerable in a directory nobody else can write.
    const prepared = prepareEndpointDirectory(plan);
    if (prepared !== null) return refusedStart(prepared, "endpoint_unavailable");
    const captured = captureEndpointDirectoryChain(plan.parentDir);
    if (captured.kind === "refused") {
      return refusedStart(captured.reason, "endpoint_unavailable");
    }
    verifyDirectoryIdentity = () => verifyEndpointDirectoryChain(captured.identity);
    const staleFailure = await clearStaleEndpoint(plan.path, verifyDirectoryIdentity);
    if (staleFailure !== null) {
      return refusedStart(staleFailure, "endpoint_unavailable");
    }
  }
  // The stale probe is a network round trip with a 1 s ceiling. A lock inside
  // it must not be overtaken into a listener.
  if (epoch !== lifecycleEpoch) {
    return refusedStart(lockedSentence(), "endpoint_unavailable");
  }
  const preBindIdentityFailure = verifyDirectoryIdentity();
  if (preBindIdentityFailure !== null) {
    return refusedStart(preBindIdentityFailure, "endpoint_unavailable");
  }

  // `allowHalfOpen` IS THE CONTRACT, not a tuning knob. Without it Node ends
  // the writable side the moment the peer's FIN arrives, so a bridge that
  // half-closes after sending its last request (which is exactly what
  // `bridge/internal/relay/relay.go` does when its own stdin reaches EOF)
  // could never receive that request's answer. With it, the socket transport
  // owns the shutdown: it drains the frames already delivered under one
  // absolute deadline, then ends the writable side itself.
  const server = createServer({ allowHalfOpen: true });
  server.maxConnections = STUDIO_MAX_LISTENER_SOCKETS;
  server.on("connection", handleConnection);
  server.on("error", (error: Error) => {
    log.error("[studio:mcp] listener error", error);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(plan.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (cause) {
    server.close();
    return refusedStart(
      `The Vex Studio MCP host could not bind ${plan.path}: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      "endpoint_unavailable",
    );
  }

  const postBindIdentityFailure = verifyDirectoryIdentity();
  if (postBindIdentityFailure !== null) {
    server.close();
    return refusedStart(postBindIdentityFailure, "endpoint_unavailable");
  }

  // THE PUBLICATION GATE. The listener now exists and is bound, so a stale
  // epoch here means a lock ran during `listen`: close the listener, remove the
  // endpoint file this attempt created, and publish nothing. Anything less
  // leaves a listening socket that no teardown owns.
  if (epoch !== lifecycleEpoch) {
    server.close();
    if (plan.kind === "unix") {
      // A unix socket leaves a FILE behind that this attempt created. A named
      // pipe does not exist independently of its server, so `server.close()`
      // is the whole rollback there and an unlink would target nothing.
      try {
        unlinkSync(plan.path);
      } catch {
        // The path may already be gone. Not a second failure path.
      }
    }
    return refusedStart(lockedSentence(), "endpoint_unavailable");
  }

  // 0600 on the socket itself, in addition to the 0700 directory. Belt and
  // braces: on Linux the socket's own mode is enforced on connect. A named
  // pipe has no filesystem mode; its access control is the security
  // descriptor Windows applied at creation.
  if (plan.kind === "unix") {
    try {
      chmodSync(plan.path, 0o600);
    } catch (cause) {
      log.warn("[studio:mcp] could not tighten socket mode", cause);
    }
  }

  state.server = server;
  state.endpoint = plan.path;
  // THE PUBLICATION GATE HAS PASSED. Emitted here, after the listener is
  // published, so a renderer that sees `running` can rely on there being a
  // bound listener behind it. The endpoint itself never leaves this module.
  emitHostStatus();
  log.info(`[studio:mcp] listening at ${plan.path}`);
  return { started: true, endpoint: plan.path };
}

/**
 * Refuse a start, recording the CODE the renderer will see beside the sentence
 * the caller will read.
 *
 * The two are deliberately different vocabularies. `reason` is prose for an
 * operator's log and frequently embeds the endpoint path or a provider error;
 * `cause` is a bounded code. Only the code is ever published.
 */
function refusedStart(
  reason: string,
  cause: StudioHostUnavailableCause,
): StudioHostStart {
  lastUnavailableCause = cause;
  log.warn(`[studio:mcp] host not started: ${reason}`);
  return { started: false, reason };
}

function handleConnection(socket: Socket): void {
  const deps = hostDeps;
  if (deps === null || state.locked) {
    socket.destroy();
    return;
  }

  // The epoch this connection belongs to. A lock or a quit advances it, and
  // every establish continuation refuses to publish once it has.
  const epoch = lifecycleEpoch;
  const connection = new StudioConnection(`c-${randomUUID().slice(0, 8)}`, socket, {
    runCall: deps.runCall,
    acquireCallSlot,
    // Connection 17 is REFUSED with a typed ack and nobody is evicted: an
    // approval-blocked connection has no traffic and is not idle, so
    // "least recently used" would pick exactly the one a human is deciding.
    reserveConnectionSlot,
    isStale: (): boolean => epoch !== lifecycleEpoch || state.locked,
    checkProject: async (projectId: string): Promise<StudioHandshakeRefused | null> => {
      if (state.locked) return lockedRefusal(lockedSentence());
      const readiness = studioReadiness();
      if (!readiness.ready) return lockedRefusal(readiness.cause);
      // NON-AUTHORITATIVE, and discarded after the ack: `runStudioCall` loads
      // the real scope atomically on every call.
      const exists = await deps.projectExists(projectId);
      return exists ? null : unknownProjectRefusal();
    },
    serveConnection: (input: ServeConnectionInput) =>
      serveOverSocket(input, {
        epoch,
        currentEpoch: () => lifecycleEpoch,
        version: process.env["VEX_APP_VERSION"] ?? "0.0.0",
      }),
    onClosed: (closed) => {
      connections.delete(closed);
      emitHostStatus();
    },
  });
  connections.add(connection);
  emitHostStatus();

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

function lockedSentence(): string {
  return (
    "Vex is locked, so it will not serve MCP calls. Nothing was executed and no "
    + "funds moved. Unlock Vex and connect again."
  );
}

/**
 * THE LOCK TEARDOWN, SYNCHRONOUS BY CONTRACT.
 *
 * Called from `lockSecretSession` immediately after the scrub and before the
 * dispatch-generation advance. Everything here happens in one tick: the
 * lifecycle epoch advances (so no in-progress start or establish can publish
 * anything), admission closes, the listener stops, and every socket is
 * destroyed with the TRUSTED cause the CALLER named - `lock` for a user relock,
 * `vex_quit` when the quit hooks lock the session. Threading it is what keeps
 * one event from writing two different reasons into the durable audit column. The asynchronous remainder of each connection's teardown
 * (the pinned instance's close, the durable refusal the abort triggers) runs
 * afterwards and is deliberately NOT awaited here - the advance must not wait
 * for a peer to notice its socket is gone.
 */
export function lockStudioMcpHost(cause: "lock" | "vex_quit" = "lock"): void {
  // FIRST, and synchronously: every in-progress start and establish is stale
  // from this line on, so none of them can publish a listener or reach
  // `serving` even though their own awaits have not resumed yet.
  advanceLifecycleEpoch();
  state.locked = true;
  const server = state.server;
  state.server = null;
  state.endpoint = null;
  if (server !== null) server.close();
  for (const connection of [...connections]) {
    connection.destroyNow(cause);
  }
  // FIRE AND FORGET, and never awaited: this function is synchronous by
  // contract, and the dispatch-generation advance that follows it must not wait
  // behind window enumeration. The publisher contains listener failures for the
  // same reason.
  if (cause === "vex_quit") shuttingDown = true;
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
  advanceLifecycleEpoch();
  state.locked = true;
  shuttingDown = true;
  const server = state.server;
  state.server = null;
  state.endpoint = null;
  // Emitted BEFORE the drain, not after: a quit that takes its full 5 s budget
  // should show as shutting down for those 5 s, not report nothing until the
  // window it would have been rendered in is already gone.
  emitHostStatus();

  let releaseDeadline = (): void => undefined;
  const deadlineTimer = setTimeout(() => {
    releaseDeadline();
  }, STUDIO_HOST_SHUTDOWN_DEADLINE_MS);
  deadlineTimer.unref?.();
  const deadline = new Promise<void>((resolve) => {
    releaseDeadline = resolve;
  });

  try {
    if (server !== null) {
      await Promise.race([
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
        deadline,
      ]);
    }
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
  advanceLifecycleEpoch();
  state.server = null;
  state.endpoint = null;
  state.locked = false;
  state.starting = null;
  state.queued = null;
  connections.clear();
  globalInFlight = 0;
  reservedConnections = 0;
  startsInFlight = 0;
  shuttingDown = false;
  lastUnavailableCause = "starting";
  hostDeps = null;
}
