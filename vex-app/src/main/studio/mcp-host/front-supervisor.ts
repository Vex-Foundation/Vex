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
 * How long main waits for a killed front to actually EXIT before it spawns the
 * replacement, or before a quit reports itself finished.
 *
 * THE PIPE NAME IS A SINGLETON THE OPERATING SYSTEM RELEASES AT PROCESS EXIT.
 * The front binds it with first-instance protection, and the name is derived
 * from the config directory, so it is the SAME name every launch. `kill()`
 * requests the exit; it does not prove it. A replacement spawned in the same
 * tick binds a name the corpse still owns, reports `listener_bind_failed`, and
 * dies - and six of those spend the whole restart budget in under a second
 * against a machine that was never broken. That is the exact cascade CI run
 * 33751109754 recorded on the Windows lane.
 *
 * go-winio's own suite is the reference for the shape: `TestListenConnectRace`
 * closes the listener and only then binds the name again, fifty times, because
 * the handle - not the intention to close it - is what the name belongs to.
 * VS Code's `PtyHostService` gets away with disposing and restarting in one
 * tick precisely because `createRandomIPCHandle()` gives every pty host a NEW
 * name; main cannot, so main waits.
 *
 * 2000 ms is generous for a process whose whole job is a pipe and is well
 * inside the 10 s bring-up deadline. When it expires the wait ends anyway and
 * the unobserved exit is NAMED, so the bind failure that may follow says why.
 */
export const FRONT_EXIT_WAIT_MS = 2_000;

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
  /** Set by the child's own `exit` event, whatever main was doing at the time. */
  exited: boolean;
  /** Waiters parked on that event. Settled exactly once, by the event or a timeout. */
  exitWaiters: (() => void)[];
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

  /**
   * The PREVIOUS child whose exit main asked for and did not see within
   * `FRONT_EXIT_WAIT_MS`, or `null`.
   *
   * It is carried into the next failure's detail because it is the one fact
   * that explains a `listener_bind_failed` on a machine where nothing is wrong:
   * the name is still held by a process main told to die.
   */
  private unobservedExitPid: number | undefined | null = null;

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
    // A CHILD THAT HAS NOT ANSWERED `HELLO_ACK` CANNOT BE COMMANDED - the same
    // rule `quit` applies. Its planes still carry generation 0 and the encoder
    // refuses a `LOCK` there by name; the throw would escape into
    // `lockStudioMcpHost` and leave a front alive with the lock never sent.
    // Kill it and come back LOCKED, which is what the deadline path does too.
    if (!live.acked) {
      this.failCurrent(
        "lock_before_hello_ack",
        "LOCK requested before HELLO_ACK; the front is restarted locked",
      );
      return;
    }
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

    // A CHILD THAT HAS NOT ANSWERED `HELLO_ACK` CANNOT BE COMMANDED.
    //
    // Its planes still carry the bootstrap generation 0, and the encoder
    // refuses every non-bootstrap frame at generation 0 by name
    // (`bad_generation`) - correctly, because a `QUIT` at generation 0 is a
    // frame no front would accept either. Sending it threw out of `quit`, past
    // the `dispose()` on the line below, and left the child ALIVE holding the
    // pipe name for the next bind to fail on. That is what the Windows lane
    // logged as `quit failed: PipeFrontEncodeError` immediately before six
    // `listener_bind_failed` restarts. A front still in bring-up is killed
    // instead, which is what `dispose` does and what it has always meant.
    if (live.acked) {
      const acked = new Promise<void>((resolve) => {
        this.quitAck = resolve;
      });
      try {
        live.planes.writeControl({
          connection: 0,
          body: { type: "QUIT", deadlineMs: Math.max(0, Math.trunc(remainingMs)) },
        });
        await Promise.race([acked, deadline]);
      } catch (cause: unknown) {
        // NOTHING MAY SKIP THE TEARDOWN BELOW. An encoder refusal is a bug in
        // this process worth seeing loudly, and it is never a reason to leave a
        // child process alive.
        this.quitAck = null;
        log.error(
          `[studio:front] QUIT refused by the encoder: `
            + `${cause instanceof Error ? cause.name : "unknown"}`,
        );
      }
    }

    await this.disposeAwaitingExit(deadline);
  }

  /**
   * `dispose()`, and then WAIT FOR THE PROCESS TO BE GONE.
   *
   * `kill()` requests an exit; only the `exit` event proves one, and until it
   * arrives the front still owns the pipe name. `shutdownStudioMcpHost` resolves
   * through here, so "the host has shut down" means the name is free - which is
   * what a quit-and-relaunch, and the conformance suite's `afterEach`, depend
   * on. The wait is bounded by the caller's ONE absolute quit budget, never by
   * a second deadline of its own (protocol 8).
   */
  private async disposeAwaitingExit(deadline: Promise<void>): Promise<void> {
    const live = this.live;
    this.dispose();
    if (live === null) return;
    const observed = await Promise.race([
      this.awaitChildExit(live, FRONT_EXIT_WAIT_MS),
      deadline.then(() => false),
    ]);
    if (observed) return;
    this.unobservedExitPid = live.child.pid;
    log.warn(
      `[studio:front] the front (pid ${String(live.child.pid ?? "unknown")}) was killed `
        + "but its exit was not observed within the quit budget; "
        + "the pipe name may still be held",
    );
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
      exited: false,
      exitWaiters: [],
    };
    this.live = live;

    child.onError((error) => {
      this.fail(token, "spawn_failed", error.name, { alreadyDead: true });
    });
    child.onExit((code) => {
      // THE LATCH IS SET FIRST, AND UNCONDITIONALLY. Every guard below is about
      // whether this death is a NEW FAILURE; none of them is about whether the
      // process is gone, and the waiter that holds the pipe name's release is
      // interested only in the second question.
      live.exited = true;
      for (const wake of live.exitWaiters.splice(0)) wake();
      // A child main has already accounted must not spend a second unit of the
      // restart budget: its failure was settled when the plane EOF or the kill
      // that produced this exit was handled.
      if (live.settled) return;
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
        // The name was bindable after all, so the previous corpse is no longer
        // an explanation for anything.
        this.unobservedExitPid = null;
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

    if (this.unobservedExitPid !== null) {
      // THE ONE FACT THAT EXPLAINS A BIND FAILURE ON A HEALTHY MACHINE. It is
      // appended rather than substituted: the structural failure name is still
      // the front's own.
      detail = `${detail} (the previous front, pid `
        + `${String(this.unobservedExitPid ?? "unknown")}, was never seen to exit)`;
      this.unobservedExitPid = null;
    }
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
      this.scheduleRestart(live);
      return;
    }
    this.finishFailed("restart_budget_exhausted", detail);
  }

  /**
   * Wait for one child to be GONE, bounded.
   *
   * Resolves `true` when the exit was observed and `false` when the bound
   * expired first. It never rejects and never leaves a timer armed: the caller
   * is on a teardown path where an extra handle is the failure mode.
   */
  private awaitChildExit(live: LiveChild, budgetMs: number): Promise<boolean> {
    if (live.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, budgetMs);
      timer.unref?.();
      live.exitWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Spawn the replacement ONLY ONCE THE CORPSE HAS LET GO OF THE PIPE NAME.
   *
   * The restart is therefore asynchronous, which the callers of `fail` already
   * tolerate: none of them reads a result, and the caller waiting on the first
   * bring-up is settled by `BOUND` or by the exhausted budget, not by the
   * spawn. What changes is that the budget is now spent on real attempts.
   */
  private scheduleRestart(live: LiveChild | null): void {
    this.state = "starting";
    this.deps.onTransition();
    const resume = (observed: boolean): void => {
      // Quit, dispose or a newer spawn overtook this restart while it waited.
      if (this.quitRequested || this.state === "stopped" || this.live !== null) return;
      if (!observed && live !== null) {
        this.unobservedExitPid = live.child.pid;
        log.error(
          `[studio:front] the previous front (pid ${String(live.child.pid ?? "unknown")}) `
            + `did not exit within ${String(FRONT_EXIT_WAIT_MS)} ms; `
            + "it may still hold the pipe name",
        );
      }
      this.spawnOnce();
    };
    if (live === null) {
      resume(true);
      return;
    }
    void this.awaitChildExit(live, FRONT_EXIT_WAIT_MS).then(resume);
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
