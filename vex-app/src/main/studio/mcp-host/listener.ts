/**
 * THE STUDIO MCP LISTENER: the one owner of the bound socket, and of nothing
 * else.
 *
 * Its whole vocabulary is transport: `stopped -> starting -> listening ->
 * shutting_down`. It plans an endpoint, proves the directory it lives in,
 * binds, publishes, and closes on quit. It does not know whether Vex is locked,
 * whether the settlement barrier is open, or what a handshake is. Those are
 * ADMISSION's questions (`admission.ts`), and keeping them out of here is what
 * lets the listener come up at app-ready and stay up across a relock.
 *
 * ## Why the listener no longer tracks the vault
 *
 * It used to exist only while Vex was unlocked, so a lock closed it. The cost
 * was paid by the bridge and by the user: a locked Vex was indistinguishable
 * from an absent one (both are `ECONNREFUSED`), so the only honest message a
 * bridge could print covered three unrelated causes at once. Binding once, and
 * refusing with a TYPED `locked` ack that carries no project bytes, tells the
 * peer the truth without opening anything: a locked host reads nothing, serves
 * nothing, and closes the connection it just answered.
 *
 * ## THE LISTENER GENERATION
 *
 * A bind is a chain of awaits (the stale-endpoint probe alone is a network
 * round trip with a 1 s ceiling) and a quit can land in any gap. The generation
 * is captured once before the first await and re-checked before anything is
 * published; a stale attempt closes what it acquired, removes the endpoint file
 * it created, and publishes nothing. A LOCK does not advance it - a lock has no
 * business invalidating a bind any more.
 *
 * ## Windows
 *
 * The endpoint is a NAMED PIPE, served exactly the way VS Code serves its main
 * IPC: a hash-derived predictable name (`\\.\pipe\vex-studio-<hash>`, same
 * discriminator as the unix socket) bound with a plain `server.listen`, with NO
 * custom security descriptor. Verified in the reference checkout:
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
 * AND IT IS RUNTIME-DISABLED. `WINDOWS_TRANSPORT_PROVEN` in `endpoint.ts` is
 * false, so a pipe plan is refused with `windows_pending_platform_proof` before
 * it reaches `server.listen`: libuv creates the pipe with a NULL security
 * descriptor and without `PIPE_REJECT_REMOTE_CLIENTS`, whose default grants
 * Everyone and the anonymous logon READ, and a cross-user read-only connect
 * against a wallet's handshake-pending slots has never been measured. The
 * pattern above stays and stays vector-tested; only opening the transport is
 * refused. The flag flips by EXTENDING the required `bridge-windows` CI job
 * with the contract's section 1.6 proof matrix, not by editing this comment.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import type { StudioHostUnavailableCause } from "@shared/schemas/studio.js";

import { CONFIG_DIR } from "../../paths/config-dir.js";
import { log } from "../../logger/index.js";
import { STUDIO_MAX_LISTENER_SOCKETS } from "./bounds.js";
import { planStudioEndpoint, unprovenWindowsTransport } from "./endpoint.js";
import {
  captureEndpointDirectoryChain,
  clearStaleEndpoint,
  nodeDirectoryProbe,
  prepareEndpointDirectory,
  refuseLiveEndpoint,
  verifyEndpointDirectoryChain,
} from "./bind.js";

export type StudioHostStart =
  | { readonly started: true; readonly endpoint: string }
  | { readonly started: false; readonly reason: string };

/**
 * The transport phases, and nothing about authority.
 *
 *  - `stopped`       - nothing is bound. `studioListenerCause()` says why.
 *  - `starting`      - one attempt is between its first line and its
 *                      publication gate.
 *  - `listening`     - a bound listener is published.
 *  - `shutting_down` - quit has begun. TERMINAL for this process.
 */
export type StudioListenerPhase =
  | "stopped"
  | "starting"
  | "listening"
  | "shutting_down";

export interface StudioListenerDeps {
  /** Called for every accepted socket. The registry decides what happens next. */
  readonly onConnection: (socket: Socket) => void;
  /** Called after every phase change, so the status owner can republish. */
  readonly onTransition: () => void;
  /**
   * The HOST's own precondition, checked INSIDE the attempt.
   *
   * The listener owns transport, not the question of whether anything can be
   * served over it, so "no executor is installed" is the host's refusal to
   * make. It is evaluated after the `starting` window opens so the refusal is
   * published like any other; a refusal that returned before that window left
   * the status cache holding whatever it said last.
   */
  readonly precondition: () => {
    readonly reason: string;
    readonly cause: StudioHostUnavailableCause;
  } | null;
}

interface ListenerState {
  server: Server | null;
  endpoint: string | null;
  phase: StudioListenerPhase;
  /** The ONE bind attempt in flight, or null. */
  attempt: Promise<StudioHostStart> | null;
  cause: StudioHostUnavailableCause;
}

const state: ListenerState = {
  server: null,
  endpoint: null,
  phase: "stopped",
  attempt: null,
  cause: "starting",
};

/** Advanced by QUIT and by the test reset. Never by a lock. */
let generation = 0;

/** The transport phase right now. */
export function studioListenerPhase(): StudioListenerPhase {
  return state.phase;
}

/** The bound endpoint, or null. It never leaves the main process. */
export function studioListenerEndpoint(): string | null {
  return state.endpoint;
}

/** Why the listener is not up, as a bounded code the renderer may see. */
export function studioListenerCause(): StudioHostUnavailableCause {
  return state.cause;
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

/**
 * Bind the listener. Idempotent, single-flight, and it refuses with a NAMED
 * cause rather than falling back to anything less verified.
 *
 * It NEVER touches admission: a listener that comes up on a locked Vex is the
 * designed boot state.
 */
export function startStudioListener(
  deps: StudioListenerDeps,
): Promise<StudioHostStart> {
  if (state.phase === "listening" && state.endpoint !== null) {
    return Promise.resolve({ started: true, endpoint: state.endpoint });
  }
  if (state.phase === "shutting_down") {
    return Promise.resolve(
      refuse(
        "Vex is shutting down, so the Vex Studio MCP host will not bind.",
        "shutting_down",
      ),
    );
  }
  const inFlight = state.attempt;
  if (inFlight !== null) return inFlight;
  const promise = runBind(generation, deps).finally(() => {
    if (state.attempt === promise) state.attempt = null;
  });
  state.attempt = promise;
  return promise;
}

async function runBind(
  captured: number,
  deps: StudioListenerDeps,
): Promise<StudioHostStart> {
  // THE `starting` WINDOW OPENS HERE and closes on every path out, which is
  // what makes the phase observable for exactly as long as an attempt is
  // between this line and its publication gate.
  state.phase = "starting";
  deps.onTransition();
  try {
    const result = await bindOnce(captured, deps);
    if (!result.started && state.phase === "starting") state.phase = "stopped";
    return result;
  } catch (cause) {
    if (state.phase === "starting") state.phase = "stopped";
    return refuse(
      `The Vex Studio MCP host failed to bind: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      "endpoint_unavailable",
    );
  } finally {
    deps.onTransition();
  }
}

async function bindOnce(
  captured: number,
  deps: StudioListenerDeps,
): Promise<StudioHostStart> {
  const blocked = deps.precondition();
  if (blocked !== null) return refuse(blocked.reason, blocked.cause);

  const plan = planStudioEndpoint({
    platform: process.platform,
    configDirRealPath: studioConfigDirHashInput(),
    env: process.env,
    tmpdir: tmpdir(),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    probeDirectory: nodeDirectoryProbe,
  });
  if (plan.kind === "refused") {
    return refuse(plan.message, "endpoint_unavailable");
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
    return refuse(gated.message, "windows_transport_disabled");
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
      return refuse(
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
      return refuse(liveFailure, "endpoint_unavailable");
    }
  } else {
    // Two steps, in this order: the parent must be proven private BEFORE any
    // decision about an entry inside it, because "is this stale socket safe to
    // remove" is only answerable in a directory nobody else can write.
    const prepared = prepareEndpointDirectory(plan);
    if (prepared !== null) return refuse(prepared, "endpoint_unavailable");
    const capturedChain = captureEndpointDirectoryChain(plan.parentDir);
    if (capturedChain.kind === "refused") {
      return refuse(capturedChain.reason, "endpoint_unavailable");
    }
    verifyDirectoryIdentity = () =>
      verifyEndpointDirectoryChain(capturedChain.identity);
    const staleFailure = await clearStaleEndpoint(plan.path, verifyDirectoryIdentity);
    if (staleFailure !== null) {
      return refuse(staleFailure, "endpoint_unavailable");
    }
  }
  // The stale probe is a network round trip with a 1 s ceiling. A quit inside
  // it must not be overtaken into a listener.
  if (captured !== generation) return refuse(quitSentence(), "shutting_down");

  const preBindIdentityFailure = verifyDirectoryIdentity();
  if (preBindIdentityFailure !== null) {
    return refuse(preBindIdentityFailure, "endpoint_unavailable");
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
  server.on("connection", deps.onConnection);
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
    return refuse(
      `The Vex Studio MCP host could not bind ${plan.path}: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      "endpoint_unavailable",
    );
  }

  const postBindIdentityFailure = verifyDirectoryIdentity();
  if (postBindIdentityFailure !== null) {
    server.close();
    return refuse(postBindIdentityFailure, "endpoint_unavailable");
  }

  // THE PUBLICATION GATE. The listener now exists and is bound, so a stale
  // generation here means a quit ran during `listen`: close the listener,
  // remove the endpoint file this attempt created, and publish nothing.
  // Anything less leaves a listening socket that no teardown owns.
  if (captured !== generation) {
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
    return refuse(quitSentence(), "shutting_down");
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
  state.phase = "listening";
  log.info(`[studio:mcp] listening at ${plan.path}`);
  return { started: true, endpoint: plan.path };
}

/**
 * Record a refusal: the CODE the renderer will see beside the sentence the
 * caller will read.
 *
 * The two are deliberately different vocabularies. `reason` is prose for an
 * operator's log and frequently embeds the endpoint path or a provider error;
 * `cause` is a bounded code. Only the code is ever published.
 */
function refuse(
  reason: string,
  cause: StudioHostUnavailableCause,
): StudioHostStart {
  state.cause = cause;
  log.warn(`[studio:mcp] host not started: ${reason}`);
  return { started: false, reason };
}

function quitSentence(): string {
  return "Vex is shutting down, so the Vex Studio MCP host did not publish a listener.";
}

/**
 * Mark the transport terminal for this process, SYNCHRONOUSLY, and invalidate
 * every bind attempt in flight. The listener itself is still up: only
 * `closeStudioListener` takes it down.
 */
export function markStudioListenerShuttingDown(deps: StudioListenerDeps): void {
  generation += 1;
  state.phase = "shutting_down";
  state.cause = "shutting_down";
  deps.onTransition();
}

/**
 * QUIT ONLY: stop accepting and close the bound socket, bounded by the caller's
 * deadline. Nothing else in the process closes the listener.
 */
export async function closeStudioListener(
  deadline: Promise<void>,
  deps: StudioListenerDeps,
): Promise<void> {
  markStudioListenerShuttingDown(deps);
  const server = state.server;
  state.server = null;
  state.endpoint = null;
  if (server === null) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    }),
    deadline,
  ]);
}

/** Test seam: forget the bound handle and start from `stopped`. */
export function resetStudioListenerForTests(): void {
  generation += 1;
  state.server = null;
  state.endpoint = null;
  state.phase = "stopped";
  state.attempt = null;
  state.cause = "starting";
}
