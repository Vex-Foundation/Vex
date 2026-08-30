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
import path from "node:path";
import { app, utilityProcess, MessageChannelMain, type MessagePortMain, type UtilityProcess } from "electron";
import {
  TERMINAL_CREATE_TIMEOUT_MS,
  TERMINAL_HOST_BEAT_INTERVAL_MS,
  TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS,
  TERMINAL_HOST_FIRST_WAIT_MULTIPLIER,
  TERMINAL_HOST_MAX_RESTARTS,
  TERMINAL_HOST_SECOND_WAIT_MULTIPLIER,
  ptyHostEnvironment,
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
        resolve({ ok: false, code: "create_timeout" });
      }, TERMINAL_CREATE_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      child.postMessage({ requestId, request }, transfer);
    });
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
   * make snapshot durability depend on process-exit timing. The wait is bounded
   * by `send`'s own timeout.
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

function defaultFork(entry: string, env: Record<string, string>): UtilityProcess {
  return utilityProcess.fork(entry, [], {
    serviceName: "vex-studio-pty-host",
    // The host's own configuration rides the environment and is DELETED by the
    // child before it captures the base every shell inherits (`config.ts`).
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}
