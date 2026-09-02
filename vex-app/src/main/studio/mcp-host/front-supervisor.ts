/**
 * THE WINDOWS PIPE-FRONT'S LIFECYCLE, owned by main.
 *
 * Structure comes from this repository's own `pty-host-starter.ts` - which in
 * turn reproduces VS Code's `PtyHostService` + `ElectronPtyHostStarter` - and
 * the parts that look arbitrary are the parts that were learned there:
 *
 *   - `restartCount <= MAX` from a counter starting at 0 permits SIX restarts,
 *     and it NEVER RESETS. A counter reset on a successful start makes a front
 *     that dies every thirty seconds restart forever, which is the failure the
 *     cap exists to bound. Past it the host reports a typed unavailable state.
 *   - EVERY in-flight thing is settled on exit, before the restart decision. For
 *     the pty host those are pending requests; here they are logical
 *     connections, and each one's `close` edge is what aborts the MCP handlers
 *     waiting on it. A connection left believing in a dead front hangs forever.
 *   - The dispose ORDER is the contract: timers first (they are bare handles),
 *     then the relay's connections, then the planes' listeners, then the child.
 *
 * Normative wire: `pipe-front-protocol.md` sections 4, 5, 6, 8, 9, 10 and 12.
 *
 * The child itself - the seven stdio slots, the minimal environment and the
 * handle shape - belongs to `front-spawn.ts`, which changes when PACKAGING
 * changes rather than when supervision does.
 *
 * ## TWO-PHASE PUBLICATION
 *
 * Nothing is published to the listener or to admission before `BOUND` has been
 * validated. A front that spawned, answered `HELLO_ACK` and then failed its
 * flag readback has never served a byte, and announcing a listener for it would
 * be announcing a security property main cannot demonstrate.
 *
 * ## A RESTARTED FRONT IS LOCKED, ON A NEW GENERATION, AT THE SAME EPOCH
 *
 * The generation is the front's (protocol 4) and main remembers every one it
 * has seen for the life of the app, so a front that reuses one is rejected. The
 * EPOCH is main's and is handed over unchanged (5.2): killing the child does
 * not invalidate the stale continuations living in main, which are precisely
 * what the fence exists to stop, so a front restart is a transport event and
 * never an authority event.
 */

import type { Readable } from "node:stream";

import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";
import {
  pipeFrontErrorCodeName,
  type PipeFrontDecodeEvent,
  type PipeFrontFrame,
  type PipeFrontPlane,
} from "@vex-agent/mcp/pipe-front-frames.js";

import { log } from "../../logger/index.js";
import {
  FRONT_LOCK_ACK_DEADLINE_MS,
  composeFrontHello,
  frontExitFailure,
  frontFailureIsRestartable,
  validateFrontBound,
  validateFrontHelloAck,
  type FrontFailureName,
} from "./front-handshake.js";
import { FrontPlanes } from "./front-planes.js";
import { FrontRelay } from "./front-relay-transport.js";
import {
  spawnStudioPipeFront,
  type FrontChild,
  type FrontSpawn,
} from "./front-spawn.js";

/**
 * VS Code's exact arithmetic: `<=` against 5 from a counter starting at 0 takes
 * the restart branch for counts 0 through 5, so SIX restarts and seven spawned
 * processes. Reproduced rather than rounded, because the number that matters is
 * not six - it is that the counter never resets.
 */
export const FRONT_MAX_RESTARTS = 5;

/**
 * How long a spawn has to reach `BOUND`.
 *
 * It bounds the WHOLE bring-up (spawn, `HELLO`, `HELLO_ACK`, pipe creation,
 * runtime flag readback, `BOUND`), not one step, because a front stuck in any
 * of them is equally unusable and the caller waiting on `startStudioListener`
 * has one question. It is deliberately generous: creating a named pipe on a
 * cold Windows machine under an antivirus scan legitimately takes seconds, and
 * a bring-up timeout that fires on a healthy start would burn the restart
 * budget the crash loop needs.
 */
export const FRONT_BRINGUP_DEADLINE_MS = 10_000;

/**
 * Structural stderr lines retained from the child.
 *
 * The front's stderr is codes and counts only - its logger's `Field` type
 * cannot carry a string value at all - so retaining the tail is safe and
 * useful. It is a RING: the count of dropped lines is reported, never hidden.
 */
export const FRONT_STDERR_RING_LINES = 64;

/**
 * The supervisor's own state, and it is what the host status is derived from.
 *
 *  - `idle`      - nothing spawned yet.
 *  - `starting`  - a child exists and has not reached `BOUND`.
 *  - `serving`   - `BOUND` validated with every required flag confirmed.
 *  - `locking`   - `LOCK` sent, `LOCK_ACK` outstanding.
 *  - `quitting`  - `QUIT` sent under main's absolute budget.
 *  - `stopped`   - deliberately shut down. TERMINAL.
 *  - `failed`    - not serving, and `failure()` says why. TERMINAL only when
 *                  the failure is one a restart cannot fix.
 */
export type FrontSupervisorState =
  | "idle"
  | "starting"
  | "serving"
  | "locking"
  | "quitting"
  | "stopped"
  | "failed";

export interface FrontSupervisorDeps {
  /** The pipe name MAIN derived. The front serves it and never derives one. */
  readonly pipeName: string;
  /** The absolute path the resolver produced. Never a bare name, never `PATH`. */
  readonly command: string;
  /** Main's current app-lifetime admission epoch (protocol 5.2). */
  readonly admissionEpoch: () => number;
  /** The exact bytes the front writes when its handshake deadline expires. */
  readonly timeoutRefusalBytes: string;
  /** Main's pre-read refusal for one connection, or `null` to admit. */
  readonly refuseBeforeRead: () => string | null;
  /** An admitted connection, as the contract every consumer already speaks. */
  readonly onConnection: (wire: StudioDuplexTransport) => void;
  /** Called after every state change so the status owner can republish. */
  readonly onTransition: () => void;
  /** Test seam. Production passes nothing. */
  readonly spawnFront?: FrontSpawn;
}

export type FrontStartOutcome =
  | { readonly started: true }
  | { readonly started: false; readonly failure: FrontFailureName; readonly detail: string };

interface LiveChild {
  /**
   * WHICH SPAWN THIS IS.
   *
   * Every listener a spawn attaches carries its own token and every failure
   * path checks it, because the signals of a DEAD child keep arriving after it
   * has been replaced: a plane EOF and the process exit are two edges of one
   * death, and the exit handler of the first child would otherwise account a
   * failure against the second - spending two units of a budget one death is
   * worth.
   */
  readonly token: number;
  readonly child: FrontChild;
  readonly planes: FrontPlanes;
  /** `HELLO_ACK` validated and the generation adopted. */
  acked: boolean;
  /** `BOUND` validated. */
  bound: boolean;
  /** Set once this child's failure has been accounted, so it counts once. */
  settled: boolean;
}

export class FrontSupervisor {
  private readonly deps: FrontSupervisorDeps;
  private readonly spawnFront: FrontSpawn;

  private state: FrontSupervisorState = "idle";
  private failureName: FrontFailureName | null = null;

  private live: LiveChild | null = null;
  private relay: FrontRelay | null = null;

  /**
   * EVERY generation this main has seen, for the life of the app.
   *
   * Only main survives a restart, so only main can reject a generation a dead
   * front already used - which is the bookkeeping protocol section 4 assigns to
   * it by name. It is bounded by the restart budget: seven starts, seven
   * entries.
   */
  private readonly seenGenerations = new Set<number>();

  private restartCount = 0;
  private spawnToken = 0;
  private quitRequested = false;

  private bringupTimer: NodeJS.Timeout | null = null;
  private lockTimer: NodeJS.Timeout | null = null;

  /** Resolves the caller waiting on the FIRST bring-up. Later ones are silent. */
  private startSettle: ((outcome: FrontStartOutcome) => void) | null = null;
  /** Resolved by `QUIT_ACK`. The quit races it against main's absolute deadline. */
  private quitAck: (() => void) | null = null;

  private readonly stderrRing: string[] = [];
  private stderrDropped = 0;
  private stderrPartial = "";

  constructor(deps: FrontSupervisorDeps) {
    this.deps = deps;
    this.spawnFront = deps.spawnFront ?? spawnStudioPipeFront;
  }

  currentState(): FrontSupervisorState {
    return this.state;
  }

  /** The failure that stopped the front, or `null`. */
  failure(): FrontFailureName | null {
    return this.failureName;
  }

  /** Restarts consumed. Exposed for the budget test. */
  restartsUsed(): number {
    return this.restartCount;
  }

  /** Structural stderr lines retained, and how many were dropped. */
  stderrTail(): { readonly lines: readonly string[]; readonly dropped: number } {
    return { lines: [...this.stderrRing], dropped: this.stderrDropped };
  }

  /**
   * Bring the front up and wait for `BOUND`.
   *
   * Single-flight by construction: the listener calls it once inside its own
   * single-flight bind attempt, and every later start is a RESTART driven from
   * this module.
   */
  start(): Promise<FrontStartOutcome> {
    if (this.state === "serving") return Promise.resolve({ started: true });
    return new Promise<FrontStartOutcome>((resolve) => {
      this.startSettle = resolve;
      this.spawnOnce();
    });
  }

  /**
   * THE PRIORITY LOCK (endpoint contract 4.1.1).
   *
   * Synchronous in main - the caller has already closed admission and advanced
   * the epoch - and the frame carries the NEW epoch, so every `ADMIT` still
   * queued behind it at the front names the old one and is PURGED rather than
   * executed. Every logical connection is torn down here as well, so main stops
   * believing in handles it can no longer command.
   *
   * If the acknowledgement does not arrive within 1000 ms main KILLS the front
   * and restarts it LOCKED: "a front that cannot be commanded is never left
   * holding live handles."
   */
  lock(): void {
    const live = this.live;
    this.relay?.closeAll("lock");
    if (live === null || this.state === "stopped" || this.state === "failed") return;
    this.state = "locking";
    this.deps.onTransition();
    live.planes.writeControl({
      connection: 0,
      body: { type: "LOCK", admissionEpoch: this.deps.admissionEpoch() },
    });
    this.clearLockTimer();
    this.lockTimer = setTimeout(() => {
      this.lockTimer = null;
      log.error("[studio:front] LOCK_ACK deadline; killing the front");
      this.failCurrent("lock_ack_timeout", "no LOCK_ACK within the deadline");
    }, FRONT_LOCK_ACK_DEADLINE_MS);
    this.lockTimer.unref?.();
  }

  /**
   * QUIT, under MAIN'S ONE ABSOLUTE BUDGET.
   *
   * `deadline` is the SAME promise `shutdownStudioMcpHost` races its other
   * stages against, and `remainingMs` is what is left of it at this moment -
   * protocol 8's "never 5000 ms per layer". Two independent five-second
   * deadlines is a ten-second quit, and the endpoint contract promises one.
   */
  async quit(remainingMs: number, deadline: Promise<void>): Promise<void> {
    this.quitRequested = true;
    const live = this.live;
    if (live === null) {
      this.state = "stopped";
      this.deps.onTransition();
      return;
    }
    this.state = "quitting";
    this.deps.onTransition();
    const acked = new Promise<void>((resolve) => {
      this.quitAck = resolve;
    });
    live.planes.writeControl({
      connection: 0,
      body: { type: "QUIT", deadlineMs: Math.max(0, Math.trunc(remainingMs)) },
    });
    await Promise.race([acked, deadline]);
    this.dispose();
  }

  /**
   * Release every handle this supervisor owns. IDEMPOTENT.
   *
   * ORDER: timers (bare handles, not owned by anything else), then the relay so
   * every connection's `close` edge is raised while main still knows about it,
   * then the planes' listeners, then the child. Killing first would let a plane
   * EOF race the teardown and report a second, meaningless failure.
   */
  dispose(): void {
    this.clearBringupTimer();
    this.clearLockTimer();
    this.quitAck = null;
    this.relay?.closeAll("dispose");
    this.relay = null;
    const live = this.live;
    this.live = null;
    if (live !== null) {
      live.planes.dispose();
      live.child.kill();
    }
    if (this.state !== "failed") this.state = "stopped";
    this.deps.onTransition();
  }

  /* ------------------------------------------------------------------ *
   * bring-up
   * ------------------------------------------------------------------ */

  private spawnOnce(): void {
    this.state = "starting";
    this.failureName = null;
    this.deps.onTransition();

    const token = this.spawnToken + 1;
    this.spawnToken = token;

    let child: FrontChild;
    try {
      child = this.spawnFront(this.deps.command);
    } catch (cause: unknown) {
      this.fail(
        token,
        "spawn_failed",
        cause instanceof Error ? cause.name : "unknown",
        { alreadyDead: true },
      );
      return;
    }

    const planes = new FrontPlanes(child.planes, {
      onControlUp: (batch) => {
        if (this.live?.token === token) this.handleControlBatch(batch);
      },
      onDataUp: (batch) => {
        if (this.live?.token === token) this.handleDataBatch(batch);
      },
      onPlaneEof: (plane) => {
        this.fail(token, "plane_eof", `plane ${String(plane)} reached EOF`);
      },
      onPlaneError: (plane) => {
        this.fail(token, "plane_io_error", `plane ${String(plane)} failed`);
      },
    });
    const live: LiveChild = {
      token,
      child,
      planes,
      acked: false,
      bound: false,
      settled: false,
    };
    this.live = live;

    child.onError((error) => {
      this.fail(token, "spawn_failed", error.name, { alreadyDead: true });
    });
    child.onExit((code) => {
      this.handleExit(token, code);
    });
    this.attachStderr(child.stderr);

    this.clearBringupTimer();
    this.bringupTimer = setTimeout(() => {
      this.bringupTimer = null;
      this.fail(token, "child_exit", "the front did not reach BOUND before its deadline");
    }, FRONT_BRINGUP_DEADLINE_MS);
    this.bringupTimer.unref?.();

    try {
      planes.writeControl({
        connection: 0,
        body: composeFrontHello({
          pipeName: this.deps.pipeName,
          initialAdmissionEpoch: this.deps.admissionEpoch(),
          timeoutRefusalBytes: this.deps.timeoutRefusalBytes,
        }),
      });
    } catch (cause: unknown) {
      // THE HOST ENCODER ENFORCES THE 4096 BOUND (protocol 9): a refusal line
      // that would not fit is a HOST bug, reported loudly and never truncated.
      log.error(
        `[studio:front] HELLO refused by the encoder: `
          + `${cause instanceof Error ? cause.name : "unknown"}`,
      );
      this.fail(token, "spawn_failed", "HELLO could not be encoded");
    }
  }

  /* ------------------------------------------------------------------ *
   * plane 4
   * ------------------------------------------------------------------ */

  /**
   * ONE BATCH, IN ORDER, WITH THE TAIL DISCARDED ON A FAILED `HELLO_ACK`.
   *
   * Protocol 6.1 makes this normative. The codec ADOPTS the announced
   * generation while decoding - it must, or every frame behind the ack in the
   * same OS read would be `bad_generation` - and adoption is a FRAMING decision
   * that proves nothing semantic. Without the discard a front could attach a
   * `BOUND` and an `OPEN` behind an ack main is about to reject, and main would
   * announce a listener for a process it has already decided is not its child.
   */
  private handleControlBatch(batch: readonly PipeFrontDecodeEvent[]): void {
    for (const event of batch) {
      if (event.kind === "malformed") {
        this.reportMalformed(event.malformed.reason, event.malformed.plane);
        return;
      }
      if (!this.handleControlFrame(event.frame)) return;
    }
  }

  /** `false` means: stop, the rest of this batch is discarded. */
  private handleControlFrame(frame: PipeFrontFrame): boolean {
    const live = this.live;
    if (live === null) return false;

    switch (frame.type) {
      case "HELLO_ACK": {
        if (live.acked) {
          this.failCurrent("unexpected_frame", "a second HELLO_ACK");
          return false;
        }
        const check = validateFrontHelloAck(frame, {
          childPid: live.child.pid,
          seenGenerations: this.seenGenerations,
        });
        if (!check.ok) {
          this.failCurrent(check.failure, check.detail);
          return false;
        }
        live.acked = true;
        this.seenGenerations.add(frame.announcedGeneration);
        // Planes 3, 5 and 6 are TOLD; plane 4 learned it inside its own push.
        live.planes.adoptGeneration(frame.announcedGeneration);
        // frontVersion and buildHash are RECORDED, never validated: they are
        // what a support bundle needs to say which front produced a session.
        log.info(
          `[studio:front] front ${frame.frontVersion} build ${frame.buildHash} `
            + `generation ${String(frame.announcedGeneration)}`,
        );
        return true;
      }
      case "BOUND": {
        if (!live.acked || live.bound) {
          this.failCurrent("unexpected_frame", "BOUND outside the bootstrap");
          return false;
        }
        const check = validateFrontBound(frame, { pipeName: this.deps.pipeName });
        if (!check.ok) {
          this.failCurrent(check.failure, check.detail);
          return false;
        }
        live.bound = true;
        this.clearBringupTimer();
        // TWO-PHASE PUBLICATION: the relay exists only from here, so nothing
        // could have been served before the flags were confirmed.
        this.relay = new FrontRelay({
          planes: live.planes,
          admissionEpoch: this.deps.admissionEpoch,
          refuseBeforeRead: this.deps.refuseBeforeRead,
          onConnection: this.deps.onConnection,
          onFatal: (failure, detail) => {
            this.failCurrent(failure, detail);
          },
        });
        this.state = "serving";
        this.deps.onTransition();
        this.settleStart({ started: true });
        return true;
      }
      case "LOCK_ACK": {
        this.clearLockTimer();
        // `closedCount` is what the front actually closed. A divergence from
        // what main believed is a structural defect worth seeing, and never a
        // reason to hold the lock.
        log.info(
          `[studio:front] locked epoch=${String(frame.admissionEpoch)} `
            + `closed=${String(frame.closedCount)}`,
        );
        // BACK TO SERVING, because a locked front is still a serving front:
        // "the accept loop STAYS ARMED" (protocol 8.1), and the next `ADMIT`
        // main sends after an unlock carries the epoch the LOCK just set, so it
        // matches and reading resumes with no unlock frame and no rebind.
        // `locking` names the window between the frame and its acknowledgement,
        // and leaving the supervisor parked in it would make a state that
        // exists for at most a second look permanent.
        if (this.state === "locking") {
          this.state = "serving";
          this.deps.onTransition();
        }
        return true;
      }
      case "QUIT_ACK":
        this.quitAck?.();
        this.quitAck = null;
        return true;
      case "PONG":
        return true;
      case "ERROR":
        return this.handleErrorFrame(frame.code, frame.count);
      case "OPEN":
      case "WRITE_DONE":
      case "PEER_CLOSED": {
        const relay = this.relay;
        if (relay === null) {
          this.failCurrent("unexpected_frame", `${frame.type} before BOUND`);
          return false;
        }
        relay.handleControlFrame(frame);
        return this.state === "serving" || this.state === "locking";
      }
      default:
        this.failCurrent("unexpected_frame", `${frame.type} on plane 4`);
        return false;
    }
  }

  /**
   * The front's `ERROR` codes are a LOG vocabulary, never a teardown cause
   * (protocol 6.5). Two of them are nevertheless decisions main must take.
   */
  private handleErrorFrame(code: number, count: number): boolean {
    const name = pipeFrontErrorCodeName(code);
    if (name === null) {
      // The codec already rejects an undefined code as `error_code`, so this is
      // unreachable through it and is checked anyway: a number no reader can
      // resolve must never reach main's log as if it meant something.
      this.failCurrent("front_error", "an undefined ERROR code");
      return false;
    }
    log.warn(
      `[studio:front] front error ${name} count=${String(count)}`,
    );
    if (name === "sddl_readback_mismatch") {
      // The descriptor read back from the handle is not the one requested. FAIL
      // CLOSED and do not restart: the next front will read back the same
      // descriptor, and a listener whose protection Windows will not confirm is
      // exactly the unknown this platform's gate exists for.
      this.failCurrent("sddl_readback_mismatch", `count=${String(count)}`);
      return false;
    }
    if (name === "admission_epoch_exhausted") {
      // The remedy is a full APPLICATION restart, never a front restart, which
      // would come up at the same exhausted value (protocol 5.2).
      this.failCurrent("admission_epoch_exhausted", `count=${String(count)}`);
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * plane 6
   * ------------------------------------------------------------------ */

  private handleDataBatch(batch: readonly PipeFrontDecodeEvent[]): void {
    const relay = this.relay;
    for (const event of batch) {
      if (event.kind === "malformed") {
        this.reportMalformed(event.malformed.reason, event.malformed.plane);
        return;
      }
      if (relay === null) {
        this.failCurrent("unexpected_frame", "a data frame before BOUND");
        return;
      }
      relay.handleDataFrame(event.frame);
    }
    relay?.afterDataBatch();
  }

  private reportMalformed(reason: string, plane: PipeFrontPlane): void {
    // The PLANE and the REASON, and never the payload, which is peer content
    // (protocol 10). The type, length and sequence live in the decoder's own
    // record and are logged by the same rule; the reason is what an operator
    // reads.
    log.error(`[studio:front] malformed frame plane=${String(plane)} reason=${reason}`);
    this.failCurrent("malformed_frame", reason);
  }

  /* ------------------------------------------------------------------ *
   * failure, exit and the restart budget
   * ------------------------------------------------------------------ */

  /**
   * ONE FAILURE PATH, and it settles everything before it decides anything.
   *
   * Every exit - child death, plane EOF, a malformed frame, an `ERROR` main
   * must act on, an acknowledgement deadline - lands here. It settles every
   * logical connection with its `close` edge, consumes ONE unit of the restart
   * budget, and either restarts the front LOCKED under a new generation or
   * reports a durable typed unavailable state.
   */
  private fail(
    token: number,
    failure: FrontFailureName,
    detail: string,
    options: { readonly alreadyDead?: boolean } = {},
  ): void {
    const live = this.live;
    // A SIGNAL FROM A CHILD MAIN HAS ALREADY REPLACED IS NOT A NEW FAILURE.
    // The exit and the plane EOF of one death arrive in either order, and the
    // second must not spend a second unit of the restart budget.
    if (live !== null && live.token !== token) return;
    if (live === null && token !== this.spawnToken) return;
    if (live !== null && live.settled) return;
    if (live !== null) live.settled = true;
    if (this.state === "stopped" || this.quitRequested) return;

    log.error(`[studio:front] ${failure}: ${detail}`);
    this.clearBringupTimer();
    this.clearLockTimer();

    // EVERY logical connection is settled BEFORE the restart decision, because
    // the handles are gone either way and a restarted front comes up empty. A
    // connection left believing in it would hold an MCP handler on a peer that
    // can never answer.
    this.relay?.closeAll(failure);
    this.relay = null;
    this.live = null;
    if (live !== null) {
      live.planes.dispose();
      if (options.alreadyDead !== true) live.child.kill();
    }

    if (!frontFailureIsRestartable(failure)) {
      this.finishFailed(failure, detail);
      return;
    }
    if (this.restartCount <= FRONT_MAX_RESTARTS) {
      this.restartCount += 1;
      log.error(
        `[studio:front] restarting LOCKED (attempt ${String(this.restartCount)})`,
      );
      this.spawnOnce();
      return;
    }
    this.finishFailed("restart_budget_exhausted", detail);
  }

  private finishFailed(failure: FrontFailureName, detail: string): void {
    this.state = "failed";
    this.failureName = failure;
    this.deps.onTransition();
    this.settleStart({ started: false, failure, detail });
  }

  /** A failure the CURRENT child produced, from a frame or a timer it owns. */
  private failCurrent(failure: FrontFailureName, detail: string): void {
    const token = this.live?.token;
    if (token === undefined) return;
    this.fail(token, failure, detail);
  }

  private handleExit(token: number, code: number | null): void {
    if (this.quitRequested || this.state === "stopped") return;
    if (this.live !== null && this.live.token !== token) return;
    // EXIT 9 IS PARENT DEATH and is not a failure: the front outlived its
    // reason to exist by a few milliseconds. It can only be seen here when main
    // is on its way out, so it is reported and not restarted.
    if (code === 9) {
      this.state = "stopped";
      this.deps.onTransition();
      return;
    }
    this.fail(token, frontExitFailure(code), `front exited with code ${String(code)}`, {
      alreadyDead: true,
    });
  }

  private settleStart(outcome: FrontStartOutcome): void {
    const settle = this.startSettle;
    this.startSettle = null;
    settle?.(outcome);
  }

  /* ------------------------------------------------------------------ *
   * stderr, timers
   * ------------------------------------------------------------------ */

  private attachStderr(stderr: Readable | null): void {
    if (stderr === null) return;
    stderr.on("data", (chunk: Buffer) => {
      this.stderrPartial += chunk.toString("utf8");
      const lines = this.stderrPartial.split("\n");
      this.stderrPartial = lines.pop() ?? "";
      if (this.stderrPartial.length > 4096) {
        // A structural line is `vex-pipe-front <code> name=value ...`; one this
        // long is not that. Dropped, COUNTED, and visible in the tail report.
        this.stderrDropped += 1;
        this.stderrPartial = "";
      }
      for (const line of lines) {
        if (line.trim() === "") continue;
        this.stderrRing.push(line);
        while (this.stderrRing.length > FRONT_STDERR_RING_LINES) {
          this.stderrRing.shift();
          this.stderrDropped += 1;
        }
        log.info(`[studio:front] ${line}`);
      }
    });
  }

  private clearBringupTimer(): void {
    if (this.bringupTimer !== null) clearTimeout(this.bringupTimer);
    this.bringupTimer = null;
  }

  private clearLockTimer(): void {
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);
    this.lockTimer = null;
  }
}
