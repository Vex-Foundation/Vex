/**
 * THE AUTHORITATIVE MIRROR: a headless xterm that receives every byte the pty
 * ever emitted, in order.
 *
 * Everything a consumer is ever shown after the fact - a reattach replay, a
 * resync, a revive snapshot - is SERIALIZED FROM HERE. That single decision is
 * what makes the whole subsystem's correctness argument short:
 *
 *  - serialized output is always a valid, self-contained VT stream, so a
 *    replay can never land a consumer mid-escape-sequence the way a raw byte
 *    suffix would;
 *  - a bound on the mirror is a bound on ROWS, which xterm enforces itself,
 *    rather than a bound on bytes, which cannot be applied to a byte stream
 *    without cutting a sequence in half;
 *  - the mirror and the consumer can never silently disagree, because the
 *    repair for any disagreement is "serialize again", and that is always
 *    available.
 *
 * The cost is one headless terminal's memory per live terminal, bounded by
 * `TERMINAL_SCROLLBACK_ROWS`. VS Code pays exactly this cost for exactly this
 * reason (`XtermSerializer` in `node/ptyService.ts`).
 *
 * ## Dropped rows are REPORTED, never hidden
 *
 * The 1000-row bound means a long-running build's early output is gone. That
 * is a bound, not a truncation, only because the count travels with every
 * replay and snapshot: `droppedRows` is derived from the number of lines that
 * have scrolled minus the number the buffer still holds, so the renderer can
 * show "1,204 earlier rows are no longer available" instead of implying the
 * history is complete.
 *
 * ## Measured library facts (probed against the installed packages, not assumed)
 *
 *  - `@xterm/headless@6.0.0` exposes NO named `Terminal` export under Node ESM;
 *    it has a `default` only. Hence the default import below.
 *  - `@xterm/addon-serialize@0.14.0` DOES export `SerializeAddon` by name, and
 *    its typings are declared against `@xterm/xterm` (the browser build) rather
 *    than the headless one. The single cast at `loadAddon` is that typings
 *    mismatch and nothing more; VS Code carries the same one.
 *  - `serialize({ scrollback: n })` is monotonic in `n`, which is what makes
 *    the row-reduction loop below terminate.
 */

import headless from "@xterm/headless";
import type { ITerminalAddon, Terminal as XtermTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { utf8ByteLength } from "@shared/schemas/terminal.js";

export interface MirrorSerialization {
  readonly data: string;
  readonly droppedRows: number;
  /** Rows deliberately left out to fit a byte cap. Zero for a full replay. */
  readonly reducedRows: number;
}

export class TerminalMirror {
  private readonly terminal: XtermTerminal;
  private readonly serializer = new SerializeAddon();
  /** Lines pushed past the viewport over this terminal's whole life. */
  private scrolledLines = 0;
  private disposed = false;
  /** Resolves when every `write` issued so far has been parsed. */
  private drained: Promise<void> = Promise.resolve();

  constructor(
    cols: number,
    rows: number,
    private readonly scrollbackRows: number,
  ) {
    this.terminal = new headless.Terminal({
      cols,
      rows,
      scrollback: scrollbackRows,
      allowProposedApi: true,
    });
    this.terminal.onScroll(() => {
      this.scrolledLines += 1;
    });
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  /**
   * Feed the mirror. Every byte the pty produced goes through here BEFORE it is
   * handed to any consumer, so a consumer that arrives late can always be
   * brought to the same screen.
   */
  write(data: string): void {
    if (this.disposed) return;
    this.drained = new Promise<void>((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
  }

  /** Scrollback rows evicted by the bound so far. */
  get droppedRows(): number {
    return Math.max(0, this.scrolledLines - this.terminal.buffer.active.baseY);
  }

  /**
   * Rows currently held (viewport plus retained scrollback).
   *
   * The resize discipline reads this to decide whether a column change is
   * expensive enough to debounce: reflowing a 24-row buffer is imperceptible,
   * reflowing a 1000-row one on every frame of a window drag is not.
   */
  get bufferRows(): number {
    return this.terminal.buffer.active.length;
  }

  /** Wait for xterm to have parsed everything written so far. */
  async drain(): Promise<void> {
    await this.drained;
  }

  /** A full serialization: every retained row, no byte cap. */
  async serialize(): Promise<MirrorSerialization> {
    await this.drain();
    return {
      data: this.serializer.serialize({ scrollback: this.scrollbackRows }),
      droppedRows: this.droppedRows,
      reducedRows: 0,
    };
  }

  /**
   * A serialization guaranteed to fit `maxBytes`, by REDUCING COMPLETE
   * SCROLLBACK ROWS and reserializing.
   *
   * Never a byte suffix of a larger serialization. A byte suffix of a VT stream
   * begins in the middle of an escape sequence roughly whenever the terminal
   * had colour, and writing that back produces a corrupted screen with no
   * indication anything went wrong. Halving the row budget until the result
   * fits costs a handful of reserializations and is always correct.
   *
   * The rows given up are REPORTED as `reducedRows`, separately from
   * `droppedRows`: the two have different causes (a snapshot size cap versus
   * the live scrollback bound) and a user shown one number for both cannot tell
   * which of their history is recoverable by scrolling.
   */
  async serializeWithin(maxBytes: number): Promise<MirrorSerialization> {
    await this.drain();
    let budget = this.scrollbackRows;
    let data = this.serializer.serialize({ scrollback: budget });
    while (utf8ByteLength(data) > maxBytes && budget > 0) {
      budget = Math.floor(budget / 2);
      data = this.serializer.serialize({ scrollback: budget });
    }
    return {
      data,
      droppedRows: this.droppedRows,
      reducedRows: Math.max(0, this.scrollbackRows - budget),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.serializer.dispose();
    this.terminal.dispose();
  }
}
