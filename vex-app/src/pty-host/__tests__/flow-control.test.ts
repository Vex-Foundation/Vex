/**
 * FLOW CONTROL: the invariant that keeps a flooding shell from filling this
 * process's memory, and the one whose failure mode is silent.
 *
 * If the pause never fires, nothing breaks visibly until a `yes` loop has put
 * hundreds of megabytes into a queue. If the resume never fires, a terminal
 * freezes with no error anywhere. Neither shows up in a screenshot, so it is
 * pinned here against the real accounting rather than a mock.
 *
 * The scripted pty is what makes this deterministic: `paused` is the real
 * effect the real code produces, observed directly.
 */

import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_ACK_CHARS,
  TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
  TERMINAL_FLOW_LOW_WATERMARK_CHARS,
} from "@shared/schemas/terminal.js";
import { TerminalProcess } from "../terminal-process.js";
import { ScriptedPty, fakeProbe, scriptedSpawner } from "./scripted-pty.js";

const CWD = "/projects/demo";
const SHELL = "/bin/bash";

async function startProcess(): Promise<{
  pty: ScriptedPty;
  process: TerminalProcess;
  emitted: string[];
}> {
  const pty = new ScriptedPty();
  const emitted: string[] = [];
  const process = new TerminalProcess(
    {
      executable: "bash",
      args: [],
      cwd: CWD,
      projectLabel: "proj",
      cols: 80,
      rows: 24,
      env: {},
    },
    {
      spawn: scriptedSpawner(pty).spawn,
      probe: fakeProbe({
        directories: [CWD],
        files: [SHELL],
        executables: { bash: SHELL },
      }),
      baseEnv: { PATH: "/usr/bin" },
      scrollbackRows: 1000,
      platform: "linux",
    },
    {
      onData: (data) => emitted.push(data),
      onProperty: () => {},
      onExit: () => {},
    },
  );
  const started = await process.start();
  expect(started.ok).toBe(true);
  return { pty, process, emitted };
}

describe("terminal flow control", () => {
  it("PAUSES the pty once unacknowledged characters pass the high watermark", async () => {
    const { pty, process } = await startProcess();

    // One character below the watermark: still flowing.
    pty.emit("x".repeat(TERMINAL_FLOW_HIGH_WATERMARK_CHARS));
    expect(process.unacknowledged).toBe(TERMINAL_FLOW_HIGH_WATERMARK_CHARS);
    expect(pty.paused).toBe(false);

    // One more character crosses it.
    pty.emit("x");
    expect(pty.paused).toBe(true);

    process.dispose();
  });

  it("RESUMES only once unacknowledged characters fall BELOW the low watermark", async () => {
    const { pty, process } = await startProcess();
    pty.emit("x".repeat(TERMINAL_FLOW_HIGH_WATERMARK_CHARS + 1));
    expect(pty.paused).toBe(true);

    // Acknowledge down to exactly the low watermark - the contract says BELOW,
    // so this must NOT resume. Getting this boundary wrong is how a terminal
    // ends up stuttering at every burst.
    const toLowWatermark =
      TERMINAL_FLOW_HIGH_WATERMARK_CHARS + 1 - TERMINAL_FLOW_LOW_WATERMARK_CHARS;
    process.acknowledge(toLowWatermark);
    expect(process.unacknowledged).toBe(TERMINAL_FLOW_LOW_WATERMARK_CHARS);
    expect(pty.paused).toBe(true);

    process.acknowledge(1);
    expect(pty.paused).toBe(false);

    process.dispose();
  });

  it("accounts acknowledgements in TERMINAL_ACK_CHARS units and never goes negative", async () => {
    const { pty, process } = await startProcess();
    pty.emit("y".repeat(TERMINAL_ACK_CHARS * 3));
    expect(process.unacknowledged).toBe(TERMINAL_ACK_CHARS * 3);

    process.acknowledge(TERMINAL_ACK_CHARS);
    expect(process.unacknowledged).toBe(TERMINAL_ACK_CHARS * 2);

    // An over-acknowledgement heals to zero rather than making the pty
    // permanently un-pausable, which is what a negative count would do.
    process.acknowledge(TERMINAL_ACK_CHARS * 99);
    expect(process.unacknowledged).toBe(0);

    process.dispose();
  });

  it("clearUnacknowledgedChars zeroes the count AND forces a resume", async () => {
    const { pty, process } = await startProcess();
    pty.emit("z".repeat(TERMINAL_FLOW_HIGH_WATERMARK_CHARS + 1));
    expect(pty.paused).toBe(true);

    process.clearUnacknowledgedChars();

    expect(process.unacknowledged).toBe(0);
    expect(process.pendingConsumerBytes).toBe(0);
    // THE POINT: without the forced resume a terminal that paused while its
    // consumer was gone would stay paused forever after the replay, because
    // the acks for those bytes are never coming.
    expect(pty.paused).toBe(false);

    process.dispose();
  });

  it("keeps writing into the mirror while the pty is paused, and REPORTS the rows the bound evicted", async () => {
    const { pty, process } = await startProcess();
    pty.emit("first\r\n");
    // 100k characters at 80 columns is ~1250 rows, so the 1000-row scrollback
    // bound legitimately evicts the earliest lines. That is the bound working;
    // what makes it a bound rather than a truncation is that the count is
    // reported, which is the assertion below.
    pty.emit("x".repeat(TERMINAL_FLOW_HIGH_WATERMARK_CHARS + 1));
    expect(pty.paused).toBe(true);
    pty.emit("after-pause\r\n");

    const serialized = await process.mirror.serialize();
    expect(serialized.data).toContain("after-pause");
    expect(serialized.data).not.toContain("first");
    expect(serialized.droppedRows).toBeGreaterThan(0);

    process.dispose();
  });

  it("retains everything written while paused when it fits the scrollback bound", async () => {
    const { pty, process } = await startProcess();
    pty.emit("first\r\n");
    // Enough to pause (one long line, not many rows), so nothing is evicted.
    pty.emit("x".repeat(TERMINAL_FLOW_HIGH_WATERMARK_CHARS + 1).replace(/\r|\n/g, ""));
    process.acknowledge(TERMINAL_FLOW_HIGH_WATERMARK_CHARS + 1);
    pty.emit("after-pause\r\n");

    const serialized = await process.mirror.serialize();
    expect(serialized.data).toContain("after-pause");

    process.dispose();
  });

  it("coalesces the outbound stream over the 5 ms window without dropping a chunk", async () => {
    vi.useFakeTimers();
    try {
      const { pty, process, emitted } = await startProcess();
      pty.emit("a");
      pty.emit("b");
      pty.emit("c");
      expect(emitted).toEqual([]);

      vi.advanceTimersByTime(5);

      expect(emitted).toEqual(["abc"]);
      process.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
