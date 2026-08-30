/**
 * A terminal THAT SURVIVES ITS CONSUMER.
 *
 * The analogue of VS Code's `PersistentTerminalProcess`. A renderer reload
 * tears down every port and every xterm in the window; the shell behind them
 * did not stop running, and a build it was halfway through has no idea anything
 * happened. So the pty outlives the consumer, and this class owns the gap:
 *
 *   attached -> detached (grace timer running) -> attached again (replay)
 *                                             -> grace expired (pty killed)
 *
 * The grace is `TERMINAL_DETACH_GRACE_MS` for a RELOAD and
 * `TERMINAL_DETACH_SHORT_GRACE_MS` for a deliberate close: a user who closed
 * the window meant it, and holding their shells for a full minute afterwards
 * leaks processes they believe they ended.
 *
 * ## Reattach is a REPLAY, never a resumption
 *
 * The new consumer gets a full serialization of the mirror, then
 * `clearUnacknowledgedChars` plus a forced resume. Trying to resume a byte
 * stream instead would need the host to know exactly how much of the old
 * stream the dead renderer had rendered - a fact that died with it.
 *
 * ## Detached terminals are NOT flow-controlled
 *
 * While detached, output still feeds the mirror but no longer counts against
 * the flow-control watermark. This is a DELIBERATE DIVERGENCE from VS Code,
 * where a detached terminal's unacknowledged count keeps climbing until the pty
 * pauses and the program stalls. Vex reloads its renderer during development
 * far more often than VS Code reloads a window, and a background build frozen
 * by a reload it never observed is a worse outcome than the memory it costs -
 * which is bounded anyway, because the mirror retains rows, not bytes.
 */

import {
  TERMINAL_PENDING_CEILING_BYTES,
  TERMINAL_REPLAY_CHUNK_MAX_BYTES,
  type TerminalId,
  type TerminalPortEvent,
  type TerminalProperty,
  chunkByUtf8Bytes,
} from "@shared/schemas/terminal.js";
import { TerminalProcess } from "./terminal-process.js";

/** Where a terminal's events go while a consumer is attached. */
export interface TerminalConsumer {
  readonly windowId: string;
  readonly send: (event: TerminalPortEvent) => void;
}

export interface PersistentTerminalEvents {
  /** The pty exited. Main needs this to release leases and counts. */
  readonly onExit: (exitCode: number, signal: number | null) => void;
  /** A bounded thing happened that a human may need to hear about. */
  readonly onNotice: (
    code: "consumer_detached_pending_ceiling",
    count: number,
  ) => void;
}

export interface PersistentTerminalOptions {
  readonly terminalId: TerminalId;
  readonly windowId: string;
  readonly projectId: string;
  readonly shellName: string;
  readonly cwdAtSpawn: string;
  readonly graceMs: number;
  readonly shortGraceMs: number;
}

export class PersistentTerminal {
  private consumer: TerminalConsumer | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private exited = false;
  /** Set while a replay is streaming, so acks for pre-replay bytes are ignored. */
  private replaying = false;

  constructor(
    readonly options: PersistentTerminalOptions,
    readonly process: TerminalProcess,
    private readonly events: PersistentTerminalEvents,
  ) {}

  /** The sinks a `TerminalProcess` is constructed with. Wired by the host. */
  static sinksFor(
    holder: { current: PersistentTerminal | null },
  ): {
    onData: (data: string) => void;
    onProperty: (change: TerminalProperty) => void;
    onExit: (exitCode: number, signal: number | null) => void;
  } {
    return {
      onData: (data) => holder.current?.handleData(data),
      onProperty: (change) => holder.current?.handleProperty(change),
      onExit: (exitCode, signal) => holder.current?.handleExit(exitCode, signal),
    };
  }

  get windowId(): string {
    return this.options.windowId;
  }

  get attached(): boolean {
    return this.consumer !== null;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /* ---------------------------------------------------------------- *
   * Consumer lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Claim the live stream.
   *
   * Replacing an existing consumer is IDEMPOTENT rather than an error: a
   * renderer that remounts a component before its old cleanup ran must end up
   * with exactly one live subscription, and the newest one is the real one.
   */
  async attach(consumer: TerminalConsumer): Promise<void> {
    if (this.disposed) return;
    this.clearGrace();
    this.consumer = consumer;
    await this.sendReplay();
  }

  /** Give up the live stream and start the grace timer. */
  detach(reason: "reload" | "closed"): void {
    if (this.disposed) return;
    this.consumer = null;
    this.clearGrace();
    const graceMs =
      reason === "closed" ? this.options.shortGraceMs : this.options.graceMs;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      // The consumer never came back. Shut the pty down through the ordinary
      // flush-then-kill path so a build's last lines still reach the snapshot.
      this.process.shutdown(false);
    }, graceMs);
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer === null) return;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** Whether a grace timer is pending. Exposed for the host's own tests. */
  get graceRunning(): boolean {
    return this.graceTimer !== null;
  }

  /* ---------------------------------------------------------------- *
   * Replay and resync
   * ---------------------------------------------------------------- */

  /** A fresh full serialization, on the consumer's request. */
  async resync(): Promise<void> {
    await this.sendReplay();
  }

  private async sendReplay(): Promise<void> {
    const consumer = this.consumer;
    if (consumer === null) return;
    this.replaying = true;
    try {
      const snapshot = await this.process.mirror.serialize();
      const chunks = chunkByUtf8Bytes(snapshot.data, TERMINAL_REPLAY_CHUNK_MAX_BYTES);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] ?? "";
        // Replay is NOT paced by flow control (the pty is not its producer), so
        // it is charged against the emergency ceiling instead. A consumer that
        // stalls mid-replay is exactly what that ceiling exists to survive.
        this.process.chargeReplay(chunk);
        consumer.send({
          kind: "replay",
          terminalId: this.options.terminalId,
          data: chunk,
          last: index === chunks.length - 1,
          droppedRows: snapshot.droppedRows,
        });
      }
      if (chunks.length === 0) {
        consumer.send({
          kind: "replay",
          terminalId: this.options.terminalId,
          data: "",
          last: true,
          droppedRows: snapshot.droppedRows,
        });
      }
    } finally {
      this.replaying = false;
      // The consumer's screen now EQUALS the mirror, so every outstanding
      // acknowledgement is moot and a pty paused during the gap must resume.
      this.process.clearUnacknowledgedChars();
    }
  }

  /* ---------------------------------------------------------------- *
   * Stream
   * ---------------------------------------------------------------- */

  private handleData(data: string): void {
    const consumer = this.consumer;
    if (consumer === null) {
      // Detached: the mirror already has it (TerminalProcess writes there
      // first), and the reattach replay is what delivers it.
      this.process.clearUnacknowledgedChars();
      return;
    }
    consumer.send({ kind: "data", terminalId: this.options.terminalId, data });
    this.enforcePendingCeiling();
  }

  private handleProperty(change: TerminalProperty): void {
    this.consumer?.send({
      kind: "property",
      terminalId: this.options.terminalId,
      change,
    });
  }

  private handleExit(exitCode: number, signal: number | null): void {
    this.exited = true;
    this.clearGrace();
    this.consumer?.send({
      kind: "exit",
      terminalId: this.options.terminalId,
      exitCode,
      signal,
    });
    this.events.onExit(exitCode, signal);
  }

  acknowledge(charCount: number): void {
    if (this.replaying) return;
    this.process.acknowledge(charCount);
  }

  /**
   * THE EMERGENCY CEILING.
   *
   * Flow control normally keeps this unreachable, which is why crossing it is
   * treated as evidence the consumer is broken rather than slow. The response
   * is to DETACH it and demand a resync - never to drop bytes from the live
   * ordered stream, because a consumer that silently missed a range has no way
   * to discover that it did.
   */
  private enforcePendingCeiling(): void {
    if (this.process.pendingConsumerBytes <= TERMINAL_PENDING_CEILING_BYTES) {
      return;
    }
    const consumer = this.consumer;
    const pending = this.process.pendingConsumerBytes;
    this.consumer = null;
    this.process.clearUnacknowledgedChars();
    consumer?.send({
      kind: "resyncRequired",
      terminalId: this.options.terminalId,
      reason: "pending_ceiling",
    });
    this.events.onNotice("consumer_detached_pending_ceiling", pending);
    // The consumer is still the window's; it simply has to ask again. The
    // grace timer is NOT started, because the window has not gone anywhere.
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGrace();
    this.consumer = null;
    this.process.dispose();
  }
}
