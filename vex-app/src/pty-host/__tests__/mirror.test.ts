/**
 * THE MIRROR, and the property that makes every replay in this system safe:
 * WHAT IT PRODUCES CAN ALWAYS BE WRITTEN BACK.
 *
 * The last test here is the one that matters most. It takes a serialization,
 * writes it into a FRESH headless terminal, and compares the visible text. A
 * byte-suffix truncation - the thing the row-reduction loop exists to avoid -
 * passes every size assertion and fails exactly this one, because it starts
 * mid-escape-sequence and the replayed screen does not match.
 */

import { describe, expect, it } from "vitest";
import headless from "@xterm/headless";
import { TerminalMirror } from "../mirror.js";

async function writeInto(target: TerminalMirror, lines: number): Promise<void> {
  for (let index = 0; index < lines; index += 1) {
    target.write(`line ${String(index)} \u001b[32mgreen\u001b[0m padding padding\r\n`);
  }
  await target.drain();
}

/** Replay a serialization into a fresh terminal and read its visible text. */
async function replayText(data: string, cols = 80, rows = 24): Promise<string> {
  const terminal = new headless.Terminal({
    cols,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
  const out: string[] = [];
  const buffer = terminal.buffer.active;
  for (let row = 0; row < buffer.length; row += 1) {
    out.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  terminal.dispose();
  return out.join("\n");
}

describe("TerminalMirror", () => {
  it("REPORTS the scrollback rows the bound evicted", async () => {
    const mirror = new TerminalMirror(80, 24, 10);
    await writeInto(mirror, 100);

    // 100 lines through a 24-row viewport with a 10-row scrollback: most of the
    // history is gone, and the count is what turns that from a truncation into
    // a bound the UI can show.
    expect(mirror.droppedRows).toBeGreaterThan(50);
    const serialized = await mirror.serialize();
    expect(serialized.droppedRows).toBe(mirror.droppedRows);
    expect(serialized.reducedRows).toBe(0);

    mirror.dispose();
  });

  it("reduces COMPLETE ROWS - never bytes - to fit a cap, and reports how many", async () => {
    const mirror = new TerminalMirror(80, 24, 1000);
    await writeInto(mirror, 600);

    const full = await mirror.serialize();
    const capped = await mirror.serializeWithin(4_000);

    expect(Buffer.byteLength(full.data, "utf8")).toBeGreaterThan(4_000);
    expect(Buffer.byteLength(capped.data, "utf8")).toBeLessThanOrEqual(4_000);
    expect(capped.reducedRows).toBeGreaterThan(0);
    // The reduction is reported SEPARATELY from the live scrollback eviction:
    // one is recoverable by scrolling and the other is not, and a single
    // number for both would tell the user nothing useful.
    expect(capped.droppedRows).toBe(full.droppedRows);

    mirror.dispose();
  });

  it("produces a serialization that REPLAYS INTO A FRESH TERMINAL identically", async () => {
    const mirror = new TerminalMirror(80, 24, 1000);
    await writeInto(mirror, 40);
    const serialized = await mirror.serialize();

    const replayed = await replayText(serialized.data);

    // Every line that was on the original screen is on the replayed one. A
    // raw byte suffix of the same stream fails here.
    for (let index = 16; index < 40; index += 1) {
      expect(replayed).toContain(`line ${String(index)}`);
    }
    mirror.dispose();
  });

  it("produces a REDUCED serialization that also replays cleanly", async () => {
    const mirror = new TerminalMirror(80, 24, 1000);
    await writeInto(mirror, 600);
    const capped = await mirror.serializeWithin(8_000);

    const replayed = await replayText(capped.data);

    // The most recent lines survived, and the escape sequences around them
    // parsed - a mid-sequence cut would leave literal `[32m` text behind.
    expect(replayed).toContain("line 599");
    expect(replayed).not.toContain("[32m");
    mirror.dispose();
  });

  /**
   * THE OVERSHOOT (F7). `scrollback: 0` is the VIEWPORT, not nothing, so the
   * row budget bottoming out does not by itself mean the result fits.
   *
   * The previous loop exited on `budget > 0` and returned whatever the last
   * serialization produced, so the one case the cap exists for - it still does
   * not fit - was the one case that returned an oversized string to a caller
   * that had been told it fitted. Restoring that condition turns this red.
   */
  it("REPORTS an overflow rather than returning data past a cap it cannot meet", async () => {
    const mirror = new TerminalMirror(80, 24, 1000);
    await writeInto(mirror, 200);

    // Row reduction bottoms out at zero scrollback rows; it does not spin.
    const capped = await mirror.serializeWithin(1);
    expect(capped.overflowed).toBe(true);
    // Nothing is returned, because nothing that could be returned would fit.
    expect(capped.data).toBe("");
    expect(Buffer.byteLength(capped.data, "utf8")).toBeLessThanOrEqual(1);
    // Every row is accounted for, because every row is what was given up.
    expect(capped.reducedRows).toBeGreaterThan(0);
    mirror.dispose();
  });

  /**
   * Reduction is measured against the scrollback the buffer ACTUALLY holds.
   *
   * A short buffer under a generous cap gave up nothing, and the old arithmetic
   * (`scrollbackRows - budget`) would report hundreds of lost rows whenever the
   * loop halved even once. That is a false data-loss notice to the user, and -
   * now that the count is persisted cumulatively - a running total that climbs
   * on every save of a terminal that has never lost a row.
   */
  it("reports NO reduction when everything the buffer holds already fits", async () => {
    const mirror = new TerminalMirror(80, 24, 1000);
    await writeInto(mirror, 30);

    const capped = await mirror.serializeWithin(2 * 1024 * 1024);
    expect(capped.overflowed).toBe(false);
    expect(capped.reducedRows).toBe(0);
    mirror.dispose();
  });

  /**
   * REVIVE (F1): a restored screen is served through the ORDINARY replay path.
   *
   * `restore` writes the persisted serialization THROUGH the parser, so the
   * mirror holds a real screen and every downstream consumer - replay, resync,
   * the next snapshot - works on a revived terminal without knowing it was
   * revived. Red if `restore` merely stashes the string beside the mirror.
   */
  it("restores a serialized screen INTO the mirror and carries its dropped rows", async () => {
    const source = new TerminalMirror(80, 24, 1000);
    await writeInto(source, 40);
    const saved = await source.serialize();
    source.dispose();

    const revived = new TerminalMirror(80, 24, 1000);
    revived.restore(saved.data, 1_204);
    const replayed = await revived.serialize();

    // Serialized OUT of the revived mirror, which is what an attaching consumer
    // is sent - so the restored screen reaches the renderer through one path.
    expect(await replayText(replayed.data)).toContain("line 39");
    // And the previous session's loss is still reported: a revived terminal
    // claiming 0 dropped rows would imply a complete history it does not have.
    expect(replayed.droppedRows).toBeGreaterThanOrEqual(1_204);
    revived.dispose();
  });
});
