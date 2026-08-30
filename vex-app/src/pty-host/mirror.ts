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
  /**
   * The row budget reached zero and the result STILL did not fit.
   *
   * Reported rather than returned as an oversized string, because the caller's
   * only correct response is to store nothing for this terminal and say so. A
   * serialization that silently exceeds the cap it was asked to respect is the
   * defect this flag exists to make impossible.
   */
  readonly overflowed: boolean;
}

export class TerminalMirror {
  private readonly terminal: XtermTerminal;
  private readonly serializer = new SerializeAddon();
  /** Lines pushed past the viewport over this terminal's whole life. */
  private scrolledLines = 0;
  private disposed = false;
  /** Resolves when every `write` issued so far has been parsed. */
  private drained: Promise<void> = Promise.resolve();
  /**
   * Rows this terminal had already lost BEFORE this mirror existed.
   *
   * A revived terminal's mirror is a fresh xterm holding a restored screen, so
   * its own counters start at zero - but the history the previous session
   * dropped is still gone, and a revived terminal that reported `0 earlier rows
   * dropped` would tell the user their scrollback was complete when it is not.
   */
  private carriedDroppedRows = 0;

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
  /**
   * Feed the mirror, optionally learning when xterm has PARSED what was fed.
   *
   * `onParsed` is what makes mirror-paced flow control possible: while no
   * consumer is attached, the mirror is the only thing consuming the pty's
   * output, so its parse rate is the rate the producer must be held to. Acking
   * on receipt instead would let a `yes` loop run at full speed into an
   * unbounded xterm parser queue that nothing ever drains.
   *
   * The callback fires once per `write`, after that write's bytes are parsed.
   * It does not fire on a disposed mirror, because there is then no consumer
   * whose pace it could describe.
   */
  write(data: string, onParsed?: () => void): void {
    if (this.disposed) return;
    this.drained = new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        resolve();
        onParsed?.();
      });
    });
  }

  /**
   * Write a previously serialized screen back in, for a revive.
   *
   * WRITE-THROUGH, deliberately: the restored bytes go through the same parser
   * every live byte goes through, so the mirror ends up holding a real screen
   * rather than a string it would have to remember to prepend to every replay.
   * Everything downstream - replay, resync, the next snapshot - then works on a
   * revived terminal without knowing it was revived.
   *
   * `carriedDroppedRows` is the history the previous session had already lost.
   */
  restore(serialized: string, carriedDroppedRows: number): void {
    if (this.disposed) return;
    this.carriedDroppedRows = Math.max(0, carriedDroppedRows);
    if (serialized.length > 0) this.write(serialized);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
  }

  /** Scrollback rows evicted by the bound so far, including inherited ones. */
  get droppedRows(): number {
    return (
      this.carriedDroppedRows
      + Math.max(0, this.scrolledLines - this.terminal.buffer.active.baseY)
    );
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

  /**
   * Wait for xterm to have parsed everything written so far, TO A FIXED POINT.
   *
   * Awaiting a single captured promise is not enough: a `write` issued while
   * that promise was outstanding replaces `this.drained`, and the caller would
   * return believing the mirror was current when a later chunk is still in the
   * parser. Every consumer of `drain` is about to make an ordering decision on
   * that belief - what belongs in a replay, what belongs in a snapshot - so the
   * loop continues until no new write appeared during the last await.
   *
   * It terminates because its callers pause the producer first; an unpaused
   * firehose would keep it looping, which is precisely why they pause.
   */
  async drain(): Promise<void> {
    let awaited: Promise<void>;
    do {
      awaited = this.drained;
      await awaited;
    } while (this.drained !== awaited);
  }

  /** A full serialization: every retained row, no byte cap. */
  async serialize(): Promise<MirrorSerialization> {
    await this.drain();
    return this.serializeNow();
  }

  /**
   * Serialize WITHOUT draining first.
   *
   * The attach handoff needs the serialization to happen in the same
   * synchronous run as installing the consumer - an await between the two is
   * the window in which live output is either duplicated into the replay or
   * lost before it. So the caller drains, and then calls this with no await in
   * between. See `persistent-terminal.ts`.
   */
  serializeNow(): MirrorSerialization {
    return {
      data: this.serializer.serialize({ scrollback: this.scrollbackRows }),
      droppedRows: this.droppedRows,
      reducedRows: 0,
      overflowed: false,
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
    return this.serializeWithinNow(maxBytes);
  }

  /**
   * `serializeWithin` without the drain, for a caller that has already drained.
   *
   * ZERO IS A REAL BUDGET AND IT CAN STILL BE TOO BIG. `scrollback: 0` is the
   * VIEWPORT, not nothing, and a 1000-column viewport of styled text can exceed
   * a small cap on its own. The previous loop exited on `budget > 0` and
   * returned whatever the last serialization produced, so the one case the cap
   * exists for - the result does not fit - was the one case it did not cover,
   * and an oversized string went to a caller that had been told it fit.
   *
   * So the fit is CHECKED after the loop, and a result that still does not fit
   * is reported as `overflowed` with no data. Every row is then accounted for
   * in `reducedRows`, because every row is what was given up.
   */
  serializeWithinNow(maxBytes: number): MirrorSerialization {
    let budget = this.scrollbackRows;
    let data = this.serializer.serialize({ scrollback: budget });
    while (utf8ByteLength(data) > maxBytes && budget > 0) {
      budget = Math.floor(budget / 2);
      data = this.serializer.serialize({ scrollback: budget });
    }
    if (utf8ByteLength(data) > maxBytes) {
      return {
        data: "",
        droppedRows: this.droppedRows,
        reducedRows: this.bufferRows,
        overflowed: true,
      };
    }
    return {
      data,
      droppedRows: this.droppedRows,
      // Measured against the scrollback the buffer ACTUALLY holds, not against
      // the 1000-row capacity. A 30-row buffer serialized at a budget of 500
      // gave up nothing, and reporting 470 lost rows would put a false loss
      // notice in front of the user and inflate the persisted running total.
      reducedRows: Math.max(0, this.scrollbackLines - budget),
      overflowed: false,
    };
  }

  /** Scrollback lines currently held above the viewport. */
  get scrollbackLines(): number {
    return this.terminal.buffer.active.baseY;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.serializer.dispose();
    this.terminal.dispose();
  }
}
