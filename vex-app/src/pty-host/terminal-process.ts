/**
 * ONE TERMINAL: the pty, its authoritative mirror, and everything that has to
 * happen in a particular order around them.
 *
 * The structure is VS Code's `TerminalProcess` (`node/terminalProcess.ts`),
 * because every one of its non-obvious behaviours is a bug report:
 *
 *  - SPAWN VALIDATION BEFORE SPAWN. A missing cwd or an unresolvable shell
 *    becomes a typed refusal instead of a native exception whose message the
 *    user cannot act on.
 *  - FLOW CONTROL AT THE PRODUCER. Above `HighWatermarkChars` unacknowledged
 *    characters the pty is PAUSED, which stops the OS pipe from being drained
 *    and makes the writing program block. Below `LowWatermarkChars` it resumes.
 *    Nothing downstream needs an unbounded queue because the producer is what
 *    gets stopped.
 *  - TRAILING OUTPUT BEFORE EXIT. node-pty can emit data after `exit`
 *    (microsoft/node-pty#72), so exit is DEBOUNCED by
 *    `TERMINAL_DATA_FLUSH_TIMEOUT_MS` and re-queued by any late data. Without
 *    it, the last line of a build is routinely lost.
 *  - KILL WAITS FOR STARTUP. Killing before the ready event would fire an exit
 *    for a process whose start the consumer never saw.
 *  - CWD IS TRIGGER-BASED, TITLE IS POLLED. Reading cwd costs a `readlink` on
 *    Linux and a SUBPROCESS on macOS, so it happens on ready, on exit and after
 *    a probable `cd` (a debounced Enter keystroke). The title is a field on the
 *    pty object, so a 200 ms poll is free; it is the TITLE poll, never the cwd
 *    poll, and conflating them is how a 24-terminal workspace ends up forking
 *    120 `lsof` processes a second.
 *
 * ## What this class deliberately does NOT own
 *
 * Consumer identity, port routing, ownership checks and persistence. It emits
 * to ONE consumer callback set by its owner (`persistent-terminal.ts`), which
 * is what makes detach, reattach and resync expressible without this class
 * knowing that windows exist.
 */

import {
  TERMINAL_COLS_RESIZE_DEBOUNCE_MS,
  TERMINAL_COLS_RESIZE_DEBOUNCE_ROW_THRESHOLD,
  TERMINAL_DATA_FLUSH_TIMEOUT_MS,
  TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
  TERMINAL_FLOW_LOW_WATERMARK_CHARS,
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  TERMINAL_TITLE_POLL_MS,
  utf8ByteLength,
  type TerminalErrorCode,
  type TerminalLaunch,
  type TerminalProperty,
} from "@shared/schemas/terminal.js";
import { TerminalDataBufferer } from "./data-bufferer.js";
import { TerminalMirror } from "./mirror.js";
import { buildTerminalEnvironment } from "./process-env.js";
import type {
  IProcessEnvironment,
  LaunchProbe,
  PtyAdapter,
  PtyDisposable,
  PtySpawner,
} from "./types.js";

/** How long after an Enter keystroke the cwd is re-read. */
const CWD_TRIGGER_DEBOUNCE_MS = 300;

export interface TerminalProcessSinks {
  /** Live output, already coalesced. Never called with an empty string. */
  readonly onData: (data: string) => void;
  /** A property CHANGED. Never fired for an unchanged value. */
  readonly onProperty: (change: TerminalProperty) => void;
  /** The pty is gone. Fired exactly once, after trailing output. */
  readonly onExit: (exitCode: number, signal: number | null) => void;
}

export interface TerminalProcessDeps {
  readonly spawn: PtySpawner;
  readonly probe: LaunchProbe;
  readonly baseEnv: IProcessEnvironment;
  readonly scrollbackRows: number;
  readonly platform?: NodeJS.Platform;
}

export type TerminalStartResult =
  | { readonly ok: true; readonly pid: number; readonly cwd: string; readonly shellName: string }
  | { readonly ok: false; readonly code: TerminalErrorCode; readonly detail: string };

export class TerminalProcess {
  private pty: PtyAdapter | null = null;
  private readonly subscriptions: PtyDisposable[] = [];
  private readonly bufferer: TerminalDataBufferer;
  readonly mirror: TerminalMirror;

  /** Flow control, in CHARACTERS, exactly as VS Code accounts for it. */
  private unacknowledgedChars = 0;
  private ptyPaused = false;

  /**
   * Bytes handed to the consumer that it has not acknowledged, and the FIFO
   * that makes the accounting exact.
   *
   * Two counters rather than one because the two bounds are in different units
   * and neither converts to the other: flow control is specified in characters
   * (VS Code's constants, and the unit an ack is expressed in), while the
   * emergency ceiling is a MEMORY bound and memory is bytes. A UTF-8 character
   * is one to four of them, so a chars-only accounting would under-count a
   * CJK-heavy stream by up to 3x at exactly the moment the ceiling matters.
   */
  private pendingBytes = 0;
  private readonly pendingChunks: Array<{ chars: number; bytes: number }> = [];

  private exitCode: number | null = null;
  private exitSignal: number | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private forceKillTimer: NodeJS.Timeout | null = null;
  private titleTimer: NodeJS.Timeout | null = null;
  private cwdTimer: NodeJS.Timeout | null = null;
  private colsTimer: NodeJS.Timeout | null = null;
  private startupComplete: Promise<void>;
  private markStartupComplete: () => void = () => {};
  private disposed = false;
  private exitAnnounced = false;

  private currentTitle = "";
  private currentCwd: string;
  private cols: number;
  private rows: number;
  private pendingCols: number | null = null;

  constructor(
    private readonly launch: TerminalLaunch,
    private readonly deps: TerminalProcessDeps,
    private readonly sinks: TerminalProcessSinks,
  ) {
    this.cols = Math.max(1, launch.cols);
    this.rows = Math.max(1, launch.rows);
    this.currentCwd = launch.cwd;
    this.mirror = new TerminalMirror(this.cols, this.rows, deps.scrollbackRows);
    this.bufferer = new TerminalDataBufferer((data) => this.emitData(data));
    this.startupComplete = new Promise<void>((resolve) => {
      this.markStartupComplete = resolve;
    });
  }

  /* ---------------------------------------------------------------- *
   * Start
   * ---------------------------------------------------------------- */

  /**
   * Validate, then spawn.
   *
   * Both validations run BEFORE any process exists, so a refusal leaves nothing
   * to clean up. `executable` is resolved to an ABSOLUTE path and that path is
   * what is spawned, so node-pty never searches `PATH` a second time with a
   * different environment than the one we validated against.
   */
  async start(): Promise<TerminalStartResult> {
    const cwdInfo = await this.deps.probe.stat(this.launch.cwd);
    if (cwdInfo === null) {
      return {
        ok: false,
        code: "launch_cwd_missing",
        detail: `starting directory does not exist: ${this.launch.cwd}`,
      };
    }
    if (!cwdInfo.isDirectory) {
      return {
        ok: false,
        code: "launch_cwd_not_directory",
        detail: `starting directory is not a directory: ${this.launch.cwd}`,
      };
    }

    const env = buildTerminalEnvironment(this.deps.baseEnv, this.launch.env);
    const resolved = await this.deps.probe.findExecutable(
      this.launch.executable,
      this.launch.cwd,
      env,
    );
    if (resolved === null) {
      return {
        ok: false,
        code: "launch_executable_missing",
        detail: `shell executable not found: ${this.launch.executable}`,
      };
    }
    const executableInfo = await this.deps.probe.stat(resolved);
    if (
      executableInfo === null
      || (!executableInfo.isFile && !executableInfo.isSymbolicLink)
    ) {
      return {
        ok: false,
        code: "launch_executable_not_file",
        detail: `shell executable is not a file or symlink: ${resolved}`,
      };
    }

    let pty: PtyAdapter;
    try {
      pty = this.deps.spawn(resolved, this.launch.args, {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: this.launch.cwd,
        env,
      });
    } catch (cause: unknown) {
      return {
        ok: false,
        code: "launch_spawn_failed",
        detail: cause instanceof Error ? cause.message : "unknown spawn failure",
      };
    }

    this.pty = pty;
    this.subscriptions.push(pty.onData((data) => this.handlePtyData(data)));
    this.subscriptions.push(
      pty.onExit((event) => {
        this.exitCode = event.exitCode;
        this.exitSignal = event.signal ?? null;
        this.queueExit();
      }),
    );

    this.markStartupComplete();
    this.sinks.onProperty({ property: "pid", value: pty.pid });
    this.startTitlePolling();
    void this.refreshCwd();

    return {
      ok: true,
      pid: pty.pid,
      cwd: this.currentCwd,
      shellName: basename(resolved, this.deps.platform ?? process.platform),
    };
  }

  /* ---------------------------------------------------------------- *
   * Data and flow control
   * ---------------------------------------------------------------- */

  private handlePtyData(data: string): void {
    // THE MIRROR FIRST, ALWAYS. It is the source of truth for every replay,
    // resync and snapshot, so no branch below may skip it - including the
    // detached branch, which is exactly the case a reattach has to recover.
    this.mirror.write(data);

    this.unacknowledgedChars += data.length;
    if (
      !this.ptyPaused
      && this.unacknowledgedChars > TERMINAL_FLOW_HIGH_WATERMARK_CHARS
    ) {
      this.ptyPaused = true;
      this.pty?.pause();
    }

    this.bufferer.handle(data);

    // Late data after the pty reported exit: the flush window restarts, so the
    // exit is announced only once output has genuinely stopped.
    if (this.closeTimer !== null) this.queueExit();
  }

  private emitData(data: string): void {
    if (data.length === 0) return;
    this.chargePending(data);
    this.sinks.onData(data);
  }

  /** Record a chunk against both pending counters. */
  private chargePending(data: string): void {
    const bytes = utf8ByteLength(data);
    this.pendingChunks.push({ chars: data.length, bytes });
    this.pendingBytes += bytes;
  }

  /** Bytes emitted to the consumer and not yet acknowledged. */
  get pendingConsumerBytes(): number {
    return this.pendingBytes;
  }

  get isPaused(): boolean {
    return this.ptyPaused;
  }

  get unacknowledged(): number {
    return this.unacknowledgedChars;
  }

  /**
   * The consumer consumed `charCount` characters.
   *
   * Clamped at zero to heal from an over-ack rather than letting a negative
   * count make the pty un-pausable, which is VS Code's own note on this line.
   */
  acknowledge(charCount: number): void {
    this.unacknowledgedChars = Math.max(this.unacknowledgedChars - charCount, 0);

    let remaining = charCount;
    while (remaining > 0 && this.pendingChunks.length > 0) {
      const head = this.pendingChunks[0];
      if (head === undefined) break;
      if (head.chars > remaining) {
        // A partial ack of one chunk: charge bytes proportionally so the byte
        // counter tracks the char counter instead of holding a whole chunk's
        // bytes hostage to its final character.
        const share = Math.round((head.bytes * remaining) / head.chars);
        head.bytes -= share;
        head.chars -= remaining;
        this.pendingBytes = Math.max(0, this.pendingBytes - share);
        remaining = 0;
        break;
      }
      this.pendingChunks.shift();
      this.pendingBytes = Math.max(0, this.pendingBytes - head.bytes);
      remaining -= head.chars;
    }

    if (
      this.ptyPaused
      && this.unacknowledgedChars < TERMINAL_FLOW_LOW_WATERMARK_CHARS
    ) {
      this.ptyPaused = false;
      this.pty?.resume();
    }
  }

  /**
   * Forget every outstanding acknowledgement and FORCE a resume.
   *
   * Called after a replay, because a replay makes the consumer's screen equal
   * to the mirror's - which means every character counted as outstanding has by
   * definition been superseded. Without this, a terminal that paused during a
   * detach would stay paused forever waiting for acks for bytes the new
   * consumer never received and will never send.
   */
  clearUnacknowledgedChars(): void {
    this.unacknowledgedChars = 0;
    this.pendingChunks.length = 0;
    this.pendingBytes = 0;
    if (this.ptyPaused) {
      this.ptyPaused = false;
      this.pty?.resume();
    }
  }

  /** Charge replay bytes against the emergency ceiling. Replay is not paced. */
  chargeReplay(data: string): void {
    this.chargePending(data);
  }

  /* ---------------------------------------------------------------- *
   * Input, resize, properties
   * ---------------------------------------------------------------- */

  write(data: string): void {
    if (this.disposed || this.pty === null) return;
    this.pty.write(data);
    // An Enter keystroke is the only cheap signal that the working directory
    // may have changed. Debounced, so holding Enter costs one read.
    if (data.includes("\r") || data.includes("\n")) this.scheduleCwdRefresh();
  }

  /**
   * Resize discipline.
   *
   * Clamped to >= 1 because winpty raises a native exception at zero.
   * A no-op resize is DROPPED against the last applied dimensions: a reflow is
   * expensive in the renderer and a resize event storm from a drag would
   * otherwise reach the pty unfiltered.
   *
   * Rows apply immediately; COLUMNS are debounced once the buffer is taller
   * than `TERMINAL_COLS_RESIZE_DEBOUNCE_ROW_THRESHOLD`, because a column change
   * reflows every retained row and doing that on each frame of a window drag is
   * what makes a resize feel like a freeze. Rows never reflow, so they never
   * need the delay.
   */
  resize(cols: number, rows: number): void {
    if (this.disposed || this.pty === null) return;
    const nextCols = Math.max(1, Math.floor(cols));
    const nextRows = Math.max(1, Math.floor(rows));
    if (nextCols === this.cols && nextRows === this.rows && this.pendingCols === null) {
      return;
    }

    // The consumer is about to reflow; it must not do so against a screen that
    // is missing the last coalescing window's output.
    this.bufferer.flush();

    const tall =
      this.mirror.bufferRows > TERMINAL_COLS_RESIZE_DEBOUNCE_ROW_THRESHOLD;

    if (nextRows !== this.rows || !tall || nextCols === this.cols) {
      const applyCols = tall && nextCols !== this.cols ? this.cols : nextCols;
      this.applyResize(applyCols, nextRows);
    }

    if (tall && nextCols !== this.cols) {
      this.pendingCols = nextCols;
      if (this.colsTimer !== null) clearTimeout(this.colsTimer);
      this.colsTimer = setTimeout(() => {
        this.colsTimer = null;
        const target = this.pendingCols;
        this.pendingCols = null;
        if (target !== null) this.applyResize(target, this.rows);
      }, TERMINAL_COLS_RESIZE_DEBOUNCE_MS);
      this.colsTimer.unref?.();
    }
  }

  private applyResize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.mirror.resize(cols, rows);
    try {
      this.pty?.resize(cols, rows);
    } catch {
      // The pty exited between the check and the call. Its exit event is what
      // reports that, not a resize that lost a race.
    }
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get title(): string {
    return this.currentTitle;
  }

  private startTitlePolling(): void {
    const platform = this.deps.platform ?? process.platform;
    this.pollTitle();
    // Windows does not update the pty's `process` field, so a poll there is
    // pure cost. VS Code skips it for the same reason.
    if (platform === "win32") return;
    this.titleTimer = setInterval(() => this.pollTitle(), TERMINAL_TITLE_POLL_MS);
    this.titleTimer.unref?.();
  }

  private pollTitle(): void {
    if (this.disposed || this.pty === null) return;
    // node-pty's `process` can be undefined despite its type (microsoft/vscode#222323).
    const title = this.pty.process ?? "";
    if (title === this.currentTitle) return;
    this.currentTitle = title;
    this.sinks.onProperty({ property: "title", value: title });
  }

  private scheduleCwdRefresh(): void {
    if (this.cwdTimer !== null) clearTimeout(this.cwdTimer);
    this.cwdTimer = setTimeout(() => {
      this.cwdTimer = null;
      void this.refreshCwd();
    }, CWD_TRIGGER_DEBOUNCE_MS);
    this.cwdTimer.unref?.();
  }

  /** Read the cwd and emit ONLY on change. */
  async refreshCwd(): Promise<void> {
    if (this.disposed || this.pty === null) return;
    const next = await this.deps.probe.readCwd(this.pty.pid);
    if (next === null || next === this.currentCwd) return;
    this.currentCwd = next;
    this.sinks.onProperty({ property: "cwd", value: next });
  }

  /* ---------------------------------------------------------------- *
   * Exit
   * ---------------------------------------------------------------- */

  /**
   * Ask the pty to go away.
   *
   * `immediate` kills now (a user closed the tab and is watching). Otherwise
   * the flush window runs, with a `TERMINAL_MAXIMUM_SHUTDOWN_MS` backstop so a
   * program that keeps writing forever cannot keep the terminal alive forever.
   */
  shutdown(immediate: boolean): void {
    if (this.disposed) return;
    if (immediate) {
      void this.kill();
      return;
    }
    if (this.closeTimer !== null) return;
    this.queueExit();
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = null;
      if (this.closeTimer !== null && !this.disposed) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
        void this.kill();
      }
    }, TERMINAL_MAXIMUM_SHUTDOWN_MS);
    this.forceKillTimer.unref?.();
  }

  private queueExit(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      void this.kill();
    }, TERMINAL_DATA_FLUSH_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  private async kill(): Promise<void> {
    // Never fire an exit before the start it belongs to.
    await this.startupComplete;
    if (this.disposed) return;
    try {
      this.pty?.kill();
    } catch {
      // Already dead. The exit below is still owed to the consumer.
    }
    // Final trailing output reaches the consumer BEFORE the exit event, or the
    // exit describes a screen the consumer never saw.
    this.bufferer.stop();
    await this.refreshCwd();
    this.announceExit();
    this.dispose();
  }

  private announceExit(): void {
    if (this.exitAnnounced) return;
    this.exitAnnounced = true;
    this.sinks.onExit(this.exitCode ?? 0, this.exitSignal);
  }

  /**
   * Release every handle. Idempotent, and safe after a partial start: each
   * timer and subscription is cleared only if it was ever acquired.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of [
      this.closeTimer,
      this.forceKillTimer,
      this.cwdTimer,
      this.colsTimer,
    ]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.closeTimer = null;
    this.forceKillTimer = null;
    this.cwdTimer = null;
    this.colsTimer = null;
    if (this.titleTimer !== null) clearInterval(this.titleTimer);
    this.titleTimer = null;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.bufferer.stop();
    this.mirror.dispose();
    this.pty = null;
    // A dispose that races a pending start must not leave `kill` awaiting
    // forever on a promise nothing will resolve.
    this.markStartupComplete();
  }
}

/** Basename without a platform-specific `path` import in the hot path. */
function basename(target: string, platform: NodeJS.Platform): string {
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  const parts = target.split(separator);
  return parts[parts.length - 1] ?? target;
}
