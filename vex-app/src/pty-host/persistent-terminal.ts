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
 * ## Detached terminals are MIRROR-PACED
 *
 * An earlier revision exempted detached terminals from flow control entirely,
 * on the reasoning that a background build should not freeze because a renderer
 * reloaded. That was wrong, and the mistake is worth stating because it is easy
 * to make again: "the mirror retains rows, not bytes" bounds the SCREEN, not
 * the queue in front of it. Forgiving every unacknowledged character let a
 * detached `yes` loop run at full speed into the headless xterm's parser queue,
 * which is unbounded, so the memory the exemption was said to cost was not
 * bounded at all.
 *
 * So the pace has an owner in both states, and it is always the ACTIVE
 * CONSUMER:
 *
 *  - ATTACHED, the consumer is the renderer's xterm, and the acks that drive
 *    flow control come from its write COMPLETION callback - not from the
 *    packet's arrival in preload, which proves only that bytes were handed to a
 *    queue.
 *  - DETACHED, the only consumer is the headless mirror, and its parse
 *    completion is the pace. A program that outruns the mirror is paused at the
 *    pty, exactly as one that outruns the renderer is.
 *
 * A reload therefore does not freeze a build: the mirror keeps parsing, and the
 * producer is held only when it genuinely outruns the one thing still reading
 * it. That is the property the exemption was reaching for, obtained without an
 * unbounded queue.
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
  /**
   * The launch this terminal was started from, kept so a snapshot can record
   * enough to start an equivalent one next session. The ENVIRONMENT is
   * deliberately not part of it - see the snapshot entry schema.
   */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwdAtSpawn: string;
  /** Rows this terminal had already given up to snapshot caps, cumulatively. */
  readonly reducedRowsAtSpawn: number;
  readonly graceMs: number;
  readonly shortGraceMs: number;
}

export class PersistentTerminal {
  private consumer: TerminalConsumer | null = null;
  /**
   * The consumer the EMERGENCY CEILING parked, kept solely so its own resync
   * request can find a binding to replay into.
   *
   * The ceiling detaches a consumer that stopped keeping up and tells it to ask
   * again. Nulling `consumer` and keeping nothing else made that instruction
   * unfollowable: the resync request arrived, `resync()` read a null consumer
   * and returned, and the terminal - which had already cleared its screen on
   * the `resyncRequired` - stayed blank for the rest of the session. The window
   * has not gone anywhere, so the binding has not either; what the terminal
   * gives up at the ceiling is the LIVE STREAM, not the identity of who is
   * watching it.
   *
   * Cleared by every other decision about consumer identity - a real detach, a
   * newer attach, a dispose - so a parked binding can never outlive the window
   * that owns it or resurrect a stream a newer owner replaced.
   */
  private parkedConsumer: TerminalConsumer | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private exited = false;
  /** Set while a replay is streaming, so acks for pre-replay bytes are ignored. */
  private replaying = false;
  /**
   * Bumped by every decision about who the consumer is.
   *
   * An attach captures it before its await and checks it at publication; a
   * detach, a newer attach or a dispose invalidates it. This is what makes a
   * StrictMode mount/cleanup/mount safe rather than a race between two
   * acquisitions of the same stream.
   */
  private attachGeneration = 0;

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
   * Claim the live stream. REPLAY FIRST, ALWAYS.
   *
   * ## The ordering this method exists to guarantee
   *
   * The consumer must observe a full serialization of the mirror and then, in
   * order, every byte the pty produced after it. The obvious implementation -
   * install the consumer, then await the serialization - cannot provide that:
   * output arriving during the await is sent as live data BEFORE the replay
   * that also contains it, so the consumer sees it twice and in the wrong
   * order. That is what this rewrite fixes.
   *
   * The construction:
   *
   *  1. HOLD THE PRODUCER. With the pty stopped, "what the mirror has" becomes
   *     a decidable question instead of a race.
   *  2. DRAIN THE MIRROR TO A FIXED POINT. Every byte the pty already delivered
   *     is now parsed and will appear in the serialization.
   *  3. NO AWAIT FROM HERE. Discard the coalescing window - every byte in it is
   *     in the mirror already, because `handlePtyData` writes the mirror before
   *     it buffers - serialize, install the consumer, emit the replay. Nothing
   *     can interleave, because nothing yields.
   *  4. RELEASE THE PRODUCER. Bytes from now on are live, arrive after the
   *     replay, and are in neither twice.
   *
   * ## The generation fence
   *
   * StrictMode's mount/cleanup/mount runs an attach and a detach around this
   * await routinely. Each attach takes a generation; a detach or a newer attach
   * invalidates it, and the stale one publishes NOTHING - it does not install
   * its consumer, does not emit a replay to a subscriber that has gone, and
   * does not release a hold the newer attach now owns.
   *
   * Replacing an existing consumer is IDEMPOTENT rather than an error: a
   * renderer that remounts a component before its old cleanup ran must end up
   * with exactly one live subscription, and the newest one is the real one.
   */
  async attach(consumer: TerminalConsumer): Promise<void> {
    if (this.disposed) return;
    const generation = this.nextAttachGeneration();
    this.clearGrace();

    // The previous consumer stops receiving NOW. It must not be handed bytes
    // that belong to the replay the new consumer is about to be sent.
    this.consumer = null;
    this.parkedConsumer = null;
    this.process.setConsumerAttached(false);
    this.process.setAttachHold(true);
    try {
      await this.process.mirror.drain();
      if (this.disposed || this.attachGeneration !== generation) return;

      // ---- no await below this line until the replay is out ----
      this.process.discardBufferedOutput();
      const snapshot = this.process.mirror.serializeNow();
      this.consumer = consumer;
      this.process.setConsumerAttached(true);
      this.emitReplay(consumer, snapshot);
    } finally {
      // Only the generation that still owns the hold may release it.
      if (this.attachGeneration === generation) this.process.setAttachHold(false);
    }
  }

  /**
   * Invalidate any in-flight attach and take the next generation.
   *
   * Every path that changes who the consumer is goes through here, so a stale
   * acquisition can never publish over a newer decision.
   */
  private nextAttachGeneration(): number {
    this.attachGeneration += 1;
    return this.attachGeneration;
  }

  /** Give up the live stream and start the grace timer. */
  detach(reason: "reload" | "closed"): void {
    if (this.disposed) return;
    // Cancels an attach that is mid-acquisition: without this, the stale attach
    // completes after the detach and installs a consumer nobody is reading.
    this.nextAttachGeneration();
    this.consumer = null;
    this.parkedConsumer = null;
    this.process.setConsumerAttached(false);
    this.process.setAttachHold(false);
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

  /**
   * A fresh full serialization, on the consumer's request.
   *
   * This is the CONSUMER'S half of the emergency-ceiling recovery: the host
   * detached it and told it to resync, and this is the request that brings its
   * screen back. It runs the whole ordered handoff rather than a bare
   * re-serialization, because a resync has exactly the same ordering problem an
   * attach has - the pty is still producing while the mirror is being
   * serialized.
   */
  async resync(): Promise<void> {
    // THE PARKED BINDING IS THE POINT. On the ordinary path `consumer` is set
    // and this is a re-serialization; on the emergency-ceiling path it is null
    // and the parked one is the only thing that can complete the recovery the
    // host itself demanded. Reading `consumer` alone made the ceiling's
    // `resyncRequired` an instruction with no possible response.
    const consumer = this.consumer ?? this.parkedConsumer;
    if (consumer === null) return;
    await this.attach(consumer);
  }

  /**
   * Emit one replay. SYNCHRONOUS by contract.
   *
   * Called only from inside `attach`, between the drain and the release of the
   * producer hold. It must not await: an await here reopens the window the hold
   * was taken to close.
   */
  private emitReplay(
    consumer: TerminalConsumer,
    snapshot: { data: string; droppedRows: number },
  ): void {
    this.replaying = true;
    try {
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
      // This is also why a replay packet is never acknowledged by the consumer:
      // the counters it would settle are cleared here, and a late ack for a
      // replay chunk would then be charged against LIVE debt it never incurred.
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
      // first), and the reattach replay is what delivers it. The producer is
      // paced by the MIRROR's parse completion while we are here - see the
      // module header - so nothing needs to be forgiven at this point.
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
    // Invalidate first: the terminal is going back to mirror pacing, and an
    // attach still in flight must not install a consumer over that decision.
    this.nextAttachGeneration();
    this.consumer = null;
    // PARKED, not forgotten: the resync this consumer is about to be told to
    // request needs a binding to replay into, and this is the only record of
    // one. See `parkedConsumer`.
    this.parkedConsumer = consumer;
    this.process.setConsumerAttached(false);
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
    this.nextAttachGeneration();
    this.clearGrace();
    this.consumer = null;
    this.parkedConsumer = null;
    this.process.setConsumerAttached(false);
    this.process.dispose();
  }
}
