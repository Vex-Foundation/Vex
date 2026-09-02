/**
 * The 5 ms outbound data bufferer, per terminal.
 *
 * Cloned from VS Code's `TerminalDataBufferer`. A shell emits data in
 * kilobyte-sized OS pipe reads; forwarding each one as its own structured-clone
 * message across a `MessagePort` costs more in message overhead than in bytes.
 * Coalescing a 5 ms window collapses a burst into one message while staying far
 * under the frame budget, so nothing about the terminal feels slower.
 *
 * IT COALESCES, IT NEVER DROPS. Every chunk that enters is in the string that
 * leaves, in order. That is what lets the mirror and the consumer stay in
 * agreement without a sequence number.
 *
 * ## Lifecycle
 *
 * The owner is the terminal. `flush` is called on RESIZE (a consumer about to
 * reflow must not apply new dimensions to a screen that is missing the last
 * 5 ms of output) and `stop` on EXIT (the final bytes are delivered before the
 * exit event, or the exit would arrive describing a screen the consumer never
 * saw). `stop` flushes; it does not discard.
 */

import { TERMINAL_DATA_BUFFER_MS } from "@shared/schemas/terminal.js";

export class TerminalDataBufferer {
  private readonly pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly emit: (data: string) => void,
    private readonly windowMs: number = TERMINAL_DATA_BUFFER_MS,
  ) {}

  /** Queue a chunk. Starts the window if this is the first chunk in it. */
  handle(data: string): void {
    if (this.stopped) {
      // A chunk after `stop` is trailing output from a pty that has exited.
      // Emit it directly rather than silently discarding: the exit sequencing
      // in `terminal-process.ts` is what decides when output has genuinely
      // finished, and this class must not make that decision for it.
      this.emit(data);
      return;
    }
    this.pending.push(data);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs);
    this.timer.unref?.();
  }

  /** Emit whatever is queued now. Safe when nothing is queued. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const data = this.pending.join("");
    this.pending.length = 0;
    this.emit(data);
  }

  /**
   * Drop the queued window WITHOUT emitting it, and stop the timer.
   *
   * The one caller is the attach handoff, and the one thing that makes it sound
   * is that every queued chunk was written to the authoritative mirror before
   * it was queued here. The replay the handoff is about to send therefore
   * already contains them; emitting them as live data as well would show the
   * user the same bytes twice. Any other caller would be discarding output that
   * exists nowhere else, which this class otherwise never does.
   */
  discard(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.length = 0;
  }

  /** Flush and stop coalescing. Idempotent. */
  stop(): void {
    this.flush();
    this.stopped = true;
  }
}
