/**
 * THE PTY HOST'S LIFECYCLE, owned by main.
 *
 * Structure and every constant come from VS Code's `PtyHostService` +
 * `ElectronPtyHostStarter`, which is the reference this repository names for
 * embedded process transport. The parts that look arbitrary are the parts that
 * were learned from production:
 *
 * ## Lazy start
 *
 * The host is forked on the FIRST terminal request, not at app start. A user
 * who never opens Studio never pays for a second process, and a node-pty that
 * fails to load becomes an error on a button they pressed rather than a startup
 * failure of the whole app.
 *
 * ## `restartCount <= MAX` permits SIX restarts, and never resets
 *
 * MEASURED, not assumed: the comparison is `<=` against a maximum of 5 from a
 * counter starting at 0, so the restart branch is taken for counts 0 through 5
 * - six restarts, and therefore SEVEN forked processes counting the original
 * start. That is VS Code's exact arithmetic and it is reproduced rather than
 * rounded to a nicer number, because the counter's job is to bound a CRASH LOOP
 * and the precise total matters far less than the fact that it NEVER RESETS. A counter reset on a successful start makes a host that
 * crashes every thirty seconds restart forever, which is the failure mode the
 * cap exists to stop. Past the cap the subsystem reports `unavailable` and
 * every terminal request is refused `host_unavailable` - a durable, honest
 * state rather than an endless spinner.
 *
 * ## The dispose ORDER
 *
 *   1. clear the heartbeat timers  (they are bare handles, not disposables)
 *   2. fire-and-forget `shutdownAll()` on the STILL-LIVE channel, catching
 *      rejections - the host needs a live channel to receive the request that
 *      makes it commit its snapshots
 *   3. drop the process reference
 *   4. clear the listener store LAST, so the exit listener still has something
 *      to read when the process actually goes
 *
 * Reversing 2 and 3 is the mistake this comment exists to prevent: it asks a
 * disposed channel to deliver the one message that saves the user's terminals.
 *
 * ## The heartbeat ladder
 *
 * Two stages, not one. The first timeout WARNS; only the second declares the
 * host unresponsive. The second stage exists because a laptop waking from
 * sleep misses beats for reasons that have nothing to do with the host, and a
 * single-stage ladder tells the user their terminals are broken every time they
 * open the lid.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, utilityProcess, MessageChannelMain, type MessagePortMain, type UtilityProcess } from "electron";
import {
  TERMINAL_CREATE_TIMEOUT_MS,
  TERMINAL_HOST_BEAT_INTERVAL_MS,
  TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS,
  TERMINAL_HOST_FIRST_WAIT_MULTIPLIER,
  TERMINAL_HOST_MAX_RESTARTS,
  TERMINAL_HOST_SECOND_WAIT_MULTIPLIER,
  TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS,
  TERMINAL_PERSIST_TIMEOUT_MS,
  TERMINAL_REVIVE_PER_TERMINAL_TIMEOUT_MS,
  ptyHostEnvironment,
  terminalSnapshotFileName,
  terminalHostMessageSchema,
  type TerminalHostAvailability,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalOutcome,
} from "@shared/schemas/terminal.js";
import { log } from "../logger/index.js";

/** Where the host writes revive snapshots. Created by the host, 0700. */
export function terminalSnapshotDirectory(): string {
  return path.join(app.getPath("userData"), "studio", "terminal-snapshots");
}

/**
 * Delete one project's revive snapshot. `true` when the file is gone.
 *
 * MAIN'S JOB, not the host's, and deliberately so: a project delete must remove
 * this file whether or not a pty host happens to be running, and routing it
 * through a lazily-started utility process would mean forking one in order to
 * delete a file - or, worse, skipping the deletion when the fork failed.
 *
 * `force` makes a missing file a success, which is the common case: a project
 * whose terminals were never opened has no snapshot.
 */
export async function removeTerminalSnapshot(projectId: string): Promise<boolean> {
  const name = terminalSnapshotFileName(projectId);
  // An id that cannot name a file never had one written for it, so there is
  // nothing to remove and nothing to report.
  if (name === null) return true;
  try {
    await fs.rm(path.join(terminalSnapshotDirectory(), name), { force: true });
    return true;
  } catch (cause: unknown) {
    log.error(
      `[studio:pty-host] snapshot removal failed projectId=${projectId}: `
        + `${cause instanceof Error ? cause.name : "unknown"}`,
    );
    return false;
  }
}

/** The built pty-host entry, next to the built main bundle. */
function ptyHostEntry(): string {
  return path.join(app.getAppPath(), "dist", "pty-host", "index.js");
}

export interface PtyHostObserver {
  /** A terminal's pty exited. Main releases its lease and its count here. */
  readonly onTerminalExit: (
    terminalId: string,
    exitCode: number,
    signal: number | null,
  ) => void;
  /** A bounded event a human may need to hear about. Codes only. */
  readonly onNotice: (message: Extract<TerminalHostMessage, { kind: "notice" }>) => void;
  /** Availability changed. The renderer reads this through its own channel. */
  readonly onAvailabilityChanged: (availability: TerminalHostAvailability) => void;
  /**
   * The host process TERMINATED UNEXPECTEDLY. Every pty it owned died with it.
   *
   * Fired before any restart is attempted, and never on the ordered shutdown -
   * a quit is not a loss, and reporting one would make every clean exit look
   * like a crash. Main's records survived the process that made them true, so
   * this is the signal to stop believing them: drop the terminal entries,
   * release their leases, invalidate the window ports, and tell the renderer.
   */
  readonly onHostTerminated: () => void;
}

/**
 * The seam the terminal domain depends on: everything a caller may ask of the
 * pty host, and nothing about how it is hosted. `PtyHostStarter` is the one
 * production implementation; the contract is named separately so a stand-in can
 * be CHECKED against it rather than asserted past it - the class's private
 * lifecycle state can never be satisfied structurally.
 */
export interface PtyHost {
  readonly availability: TerminalHostAvailability;
  ensureStarted(): boolean;
  send(
    request: TerminalHostRequest,
    transfer?: MessagePortMain[],
  ): Promise<TerminalOutcome<unknown>>;
  mintPort(
    windowId: string,
    nonce: string,
  ): Promise<{ outcome: TerminalOutcome<unknown>; rendererPort: MessagePortMain | null }>;
  dispose(): Promise<void>;
}

interface Pending {
  readonly resolve: (outcome: TerminalOutcome<unknown>) => void;
  readonly timer: NodeJS.Timeout;
}

export class PtyHostStarter implements PtyHost {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private restartCount = 0;
  private responsive = true;
  private quitRequested = false;
  private state: TerminalHostAvailability["state"] = "stopped";
  private firstBeatTimer: NodeJS.Timeout | null = null;
  private secondBeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly observer: PtyHostObserver,
    private readonly fork: (entry: string, env: Record<string, string>) => UtilityProcess =
      defaultFork,
  ) {}

  get availability(): TerminalHostAvailability {
    return {
      state: this.state,
      restartCount: this.restartCount,
      responsive: this.responsive,
    };
  }

  private publishAvailability(): void {
    this.observer.onAvailabilityChanged(this.availability);
  }

  /**
   * Ensure a host is running.
   *
   * Returns `false` once the restart cap is spent: that is a DURABLE state, not
   * a transient failure, and the caller turns it into a typed
   * `host_unavailable` refusal rather than retrying.
   */
  ensureStarted(): boolean {
    if (this.state === "unavailable") return false;
    if (this.child !== null) return true;
    this.start();
    return this.child !== null;
  }

  private start(): void {
    this.state = "starting";
    this.publishAvailability();
    let child: UtilityProcess;
    try {
      child = this.fork(ptyHostEntry(), ptyHostEnvironment(terminalSnapshotDirectory()));
    } catch (cause: unknown) {
      log.error(
        `[studio:pty-host] fork failed: ${cause instanceof Error ? cause.name : "unknown"}`,
      );
      this.state = "unavailable";
      this.publishAvailability();
      return;
    }
    this.child = child;

    child.on("message", (raw: unknown) => this.handleHostMessage(raw));
    child.on("exit", (code: number) => this.handleExit(code));

    // The FIRST beat window is the long one: a cold start on a slow machine
    // legitimately takes seconds, and warning about it teaches users to ignore
    // the warning.
    this.handleHeartbeat(true);
    this.state = "running";
    this.publishAvailability();
  }

  private handleExit(code: number): void {
    this.clearHeartbeatTimers();
    this.child = null;
    // Every in-flight request dies with the process. Answering them
    // `host_unavailable` is what stops a create from hanging forever on a
    // reply that can no longer arrive.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: "host_unavailable" });
    }
    this.pending.clear();

    if (this.quitRequested) {
      this.state = "stopped";
      this.publishAvailability();
      return;
    }

    // UNEXPECTED. Reported BEFORE the restart decision, because the terminals
    // are gone either way and a restarted host does not bring them back - it
    // comes up empty, and would answer `unknown_terminal` to every id main
    // still believes in.
    this.observer.onHostTerminated();

    if (this.restartCount <= TERMINAL_HOST_MAX_RESTARTS) {
      log.error(
        `[studio:pty-host] terminated unexpectedly code=${String(code)}; restarting `
          + `(attempt ${String(this.restartCount + 1)})`,
      );
      this.restartCount += 1;
      this.responsive = true;
      this.start();
      return;
    }

    log.error(
      `[studio:pty-host] terminated unexpectedly code=${String(code)}; giving up after `
        + `${String(this.restartCount)} restarts`,
    );
    this.state = "unavailable";
    this.publishAvailability();
  }

  /* ---------------------------------------------------------------- *
   * Messages
   * ---------------------------------------------------------------- */

  private handleHostMessage(raw: unknown): void {
    const parsed = terminalHostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("[studio:pty-host] dropped an off-contract message from the host");
      return;
    }
    const message = parsed.data;
    switch (message.kind) {
      case "heartbeat":
        this.handleHeartbeat(false);
        return;
      case "reply": {
        const entry = this.pending.get(message.requestId);
        if (entry === undefined) return;
        this.pending.delete(message.requestId);
        clearTimeout(entry.timer);
        entry.resolve(message.outcome);
        return;
      }
      case "terminalExit":
        this.observer.onTerminalExit(
          message.terminalId,
          message.exitCode,
          message.signal,
        );
        return;
      case "notice":
        this.observer.onNotice(message);
        return;
    }
  }

  /**
   * Send a request and await its reply.
   *
   * `TERMINAL_CREATE_TIMEOUT_MS` bounds EVERY request, not only `create`: a
   * host that stopped answering must not leave an IPC handler awaiting
   * forever, and a caller that gets `create_timeout` can tell the user
   * something true.
   *
   * ## A DEADLINE IS AN ABANDONMENT, NOT A SILENCE
   *
   * Deleting the pending entry and answering the caller used to be the whole
   * timeout path, and it left the host running the request. Main had by then
   * released the capacity reservation and the `terminalCreate` lease it took
   * for it; the host went on to register a live pty against ids main no longer
   * believed in, no window would ever attach to it, and nothing in the system
   * could name it in order to close it. So the host is TOLD, and it kills what
   * the abandoned request created.
   *
   * ## The deadline is proportional to the work
   *
   * A `revive` spawns one shell per assignment, sequentially. Holding twelve of
   * them to the single-request budget made an ordinary restore look exactly
   * like an unresponsive host - which is the failure this timeout exists to
   * detect, reported for a host that was doing precisely what it was asked.
   */
  async send(
    request: TerminalHostRequest,
    transfer: MessagePortMain[] = [],
  ): Promise<TerminalOutcome<unknown>> {
    if (!this.ensureStarted()) return { ok: false, code: "host_unavailable" };
    const child = this.child;
    if (child === null) return { ok: false, code: "host_unavailable" };

    const requestId = randomUUID();
    return await new Promise<TerminalOutcome<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.handleUnresponsive();
        this.abandon(requestId, request);
        resolve({ ok: false, code: "create_timeout" });
      }, deadlineFor(request));
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      child.postMessage({ requestId, request }, transfer);
    });
  }

  /**
   * Tell the host that main has stopped waiting for `requestId`.
   *
   * Best effort by construction: the reason the deadline fired may well be that
   * the host is gone, in which case there is nothing to compensate because the
   * ptys died with it. A live host answers by killing whatever the abandoned
   * request created.
   */
  private abandon(requestId: string, request: TerminalHostRequest): void {
    if (deriveCreates(request) === false) return;
    const child = this.child;
    if (child === null) return;
    try {
      child.postMessage({
        requestId: randomUUID(),
        request: { kind: "abandonRequest", requestId },
      });
      log.warn(
        `[studio:pty-host] ${request.kind} exceeded its deadline; abandoning it at the `
          + "host so the terminals it may have created are killed",
      );
    } catch (cause: unknown) {
      log.error(
        "[studio:pty-host] could not abandon a timed-out request: "
          + `${cause instanceof Error ? cause.name : "unknown"}`,
      );
    }
  }

  /**
   * Mint a data-plane port for one window.
   *
   * The child end is handed over WITH the `attachWindow` request that labels
   * it, so the host never holds a port it cannot attribute to a window - which
   * is what makes its per-packet ownership check possible at all.
   */
  async mintPort(
    windowId: string,
    nonce: string,
  ): Promise<{ outcome: TerminalOutcome<unknown>; rendererPort: MessagePortMain | null }> {
    if (!this.ensureStarted()) {
      return { outcome: { ok: false, code: "host_unavailable" }, rendererPort: null };
    }
    const channel = new MessageChannelMain();
    const outcome = await this.send({ kind: "attachWindow", windowId, nonce }, [
      channel.port1,
    ]);
    if (!outcome.ok) {
      channel.port2.close();
      return { outcome, rendererPort: null };
    }
    return { outcome, rendererPort: channel.port2 };
  }

  /* ---------------------------------------------------------------- *
   * Heartbeat ladder
   * ---------------------------------------------------------------- */

  private handleHeartbeat(isConnecting: boolean): void {
    this.clearHeartbeatTimers();
    const wait = isConnecting
      ? TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS
      : TERMINAL_HOST_BEAT_INTERVAL_MS * TERMINAL_HOST_FIRST_WAIT_MULTIPLIER;
    this.firstBeatTimer = setTimeout(() => this.handleFirstTimeout(), wait);
    this.firstBeatTimer.unref?.();
    if (!this.responsive) {
      this.responsive = true;
      this.publishAvailability();
    }
  }

  private handleFirstTimeout(): void {
    this.firstBeatTimer = null;
    log.warn(
      `[studio:pty-host] no heartbeat after `
        + `${String(TERMINAL_HOST_BEAT_INTERVAL_MS * TERMINAL_HOST_FIRST_WAIT_MULTIPLIER)}ms`,
    );
    this.secondBeatTimer = setTimeout(
      () => this.handleSecondTimeout(),
      TERMINAL_HOST_BEAT_INTERVAL_MS * TERMINAL_HOST_SECOND_WAIT_MULTIPLIER,
    );
    this.secondBeatTimer.unref?.();
  }

  private handleSecondTimeout(): void {
    this.secondBeatTimer = null;
    log.error("[studio:pty-host] host is unresponsive");
    this.handleUnresponsive();
  }

  private handleUnresponsive(): void {
    if (!this.responsive) return;
    this.responsive = false;
    this.publishAvailability();
  }

  private clearHeartbeatTimers(): void {
    if (this.firstBeatTimer !== null) clearTimeout(this.firstBeatTimer);
    if (this.secondBeatTimer !== null) clearTimeout(this.secondBeatTimer);
    this.firstBeatTimer = null;
    this.secondBeatTimer = null;
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  /**
   * Quit the host. ORDER IS THE CONTRACT - see the module doc.
   *
   * `shutdownAll` is awaited rather than fired blind, because it is the request
   * that makes the host commit every snapshot; a fire-and-forget here would
   * make snapshot durability depend on process-exit timing.
   *
   * ## THE CHILD IS NOT KILLED WHILE THE SHUTDOWN IS STILL INSIDE ITS DEADLINE
   *
   * `kill()` below is reached only after the awaited `send` has settled, and
   * that send is bounded by `TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS` - a deadline
   * DERIVED from the host's own commit, pty-wait and dispose bounds rather than
   * the flat control-request budget. With the flat budget the two disagreed by
   * an order of magnitude at the global terminal bound, and the disagreement
   * resolved as a `kill()` in the middle of a commit.
   */
  async dispose(): Promise<void> {
    this.quitRequested = true;
    this.clearHeartbeatTimers();
    const child = this.child;
    if (child === null) {
      this.state = "stopped";
      return;
    }
    await this.send({ kind: "shutdownAll" }).catch(() => undefined);
    this.child = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: "host_unavailable" });
    }
    this.pending.clear();
    child.kill();
    this.state = "stopped";
  }
}

/**
 * Whether this request kind can bring a terminal into existence, and therefore
 * whether abandoning it is worth a message.
 */
function deriveCreates(request: TerminalHostRequest): boolean {
  return request.kind === "create" || request.kind === "revive";
}

/**
 * The deadline for one request, DERIVED FROM WHAT THE HOST ACTUALLY DOES.
 *
 * The flat control-request budget is right only for requests that do one
 * bounded thing. Three kinds do not, and giving them the flat budget was not a
 * tuning miss - a deadline shorter than a request's real bound makes main
 * declare a healthy host unresponsive, abandon the request, and (on quit) KILL
 * the child mid-commit, which costs the user the snapshot the request existed
 * to write.
 *
 *  - `revive` spawns one shell per assignment, sequentially. The assignment
 *    list is capped by the shared schema, so the proportional branch is
 *    bounded with it.
 *  - `persistWorkspace` may wait behind one coalesced in-flight commit and then
 *    run as the follow-up: `TERMINAL_PERSIST_TIMEOUT_MS`.
 *  - `forgetWorkspace` JOINS whatever commit is in flight for the project so it
 *    cannot answer while a capture is still running, which is the same worst
 *    case a persist has and therefore the same bound. The flat budget is
 *    SHORTER than that worst case, and a forget declared late would mark a
 *    healthy host unresponsive on the delete path - and leave the layout the
 *    request exists to remove still held.
 *  - `shutdownAll` commits every project, then waits for every pty, then
 *    disposes: `TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS`.
 *
 * Every one of those is composed in `@shared/schemas/terminal.js` from the
 * constants the host itself bounds those phases with, so the two sides cannot
 * drift into disagreeing about how long the work takes.
 */
function deadlineFor(request: TerminalHostRequest): number {
  if (request.kind === "revive") {
    return (
      TERMINAL_CREATE_TIMEOUT_MS
      + request.assignments.length * TERMINAL_REVIVE_PER_TERMINAL_TIMEOUT_MS
    );
  }
  if (request.kind === "persistWorkspace" || request.kind === "forgetWorkspace") {
    return TERMINAL_PERSIST_TIMEOUT_MS;
  }
  if (request.kind === "shutdownAll") return TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS;
  return TERMINAL_CREATE_TIMEOUT_MS;
}

function defaultFork(entry: string, env: Record<string, string>): UtilityProcess {
  return utilityProcess.fork(entry, [], {
    serviceName: "vex-studio-pty-host",
    // The host's own configuration rides the environment and is DELETED by the
    // child before it captures the base every shell inherits (`config.ts`).
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}
