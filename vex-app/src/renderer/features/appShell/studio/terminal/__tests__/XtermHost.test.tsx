/**
 * XtermHost against a REAL xterm and a recording bridge.
 *
 * The whole point of this suite is that the terminal is real. The host's job is
 * to move bytes between a bridge and a terminal, and a doubled terminal would
 * let every assertion pass while the actual integration - which xterm API to
 * call to discard a screen, whether a write lands before the next one, whether
 * the buffer survives - was wrong. The bridge is the double instead, because it
 * is the process boundary and this is a unit test.
 */

import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../terminal-registry.js";
import { TERMINAL_FULL_RESET_SEQUENCE, XtermHost } from "../XtermHost.js";
import {
  installMatchMedia,
  installResizeObserver,
  installTerminalBridge,
  stubBox,
  type TerminalBridgeStub,
} from "./terminal-harness.js";

const noWebgl = { webglLoader: () => Promise.reject(new Error("no gl in jsdom")) };

let bridge: TerminalBridgeStub;
let registry: TerminalRegistry;

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
  bridge = installTerminalBridge();
  registry = new TerminalRegistry(noWebgl);
  document.body.innerHTML = "";
});

/** Give the pane a measurable box so a fit has something to measure. */
function sizeThePane(): void {
  for (const node of document.querySelectorAll("div")) {
    stubBox(node, { width: 800, height: 400 });
  }
}

/**
 * Let xterm PARSE what has been written.
 *
 * `Terminal.write` queues; the buffer does not change on the turn the write was
 * issued. A single microtask is not enough (measured), so this drains macrotasks
 * until the queue has settled - which is also why the production clear had to go
 * through the queue rather than around it.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function bufferText(terminalId: string): string {
  const terminal = registry.acquire(terminalId).terminal;
  registry.release(terminalId);
  const lines: string[] = [];
  for (let row = 0; row < terminal.buffer.active.length; row += 1) {
    const line = terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
    if (line !== "") lines.push(line);
  }
  return lines.join("\n");
}

describe("XtermHost data path", () => {
  it("claims the stream on mount and renders what the host sends", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} />);
    sizeThePane();

    expect(bridge.attaches).toEqual(["t1"]);

    await act(async () => {
      bridge.emitData("t1", "hello from the shell");
      await settle();
    });

    expect(bufferText("t1")).toContain("hello from the shell");
  });

  it("sends what the user types back through the bridge", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} />);
    const entry = registry.acquire("t1");
    registry.release("t1");

    // xterm turns a real keystroke into an onData event; firing the event the
    // library itself would fire keeps this a test of OUR wiring rather than a
    // re-test of xterm's key handling.
    await act(async () => {
      entry.terminal.input("ls\r");
      await settle();
    });

    expect(bridge.writes.map((write) => write.data).join("")).toContain("ls\r");
    expect(bridge.writes.every((write) => write.terminalId === "t1")).toBe(true);
  });

  it("clears ONCE per replay and renders every chunk of it", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} />);
    const entry = registry.acquire("t1");
    registry.release("t1");
    // The clear is a control sequence in the OUTPUT STREAM, so the stream is
    // where it is counted. This is protocol bytes, not a mock call count: the
    // buffer assertions below say what those bytes had to mean.
    const written: string[] = [];
    const write = entry.terminal.write.bind(entry.terminal);
    vi.spyOn(entry.terminal, "write").mockImplementation((data) => {
      if (typeof data === "string") written.push(data);
      write(data);
    });
    const clears = (): number =>
      written.filter((chunk) => chunk === TERMINAL_FULL_RESET_SEQUENCE).length;

    await act(async () => {
      bridge.emitData("t1", "STALE SCREEN\r\n");
      await settle();
    });
    // Ordinary output never discards the screen.
    expect(clears()).toBe(0);

    await act(async () => {
      // TWO resyncs for ONE replay - the duplicate the latch exists for.
      bridge.emitResync("t1", 12);
      bridge.emitResync("t1", 12);
      bridge.emitData("t1", "AAA");
      bridge.emitData("t1", "BBB");
      bridge.emitData("t1", "CCC");
      await settle();
    });

    // The MECHANISM: exactly one clear, however many resyncs arrived.
    expect(clears()).toBe(1);
    // The MEANING: the replay is whole and the pre-replay screen is gone. A
    // second clear would have eaten AAA; a missing clear would have kept STALE.
    const text = bufferText("t1");
    expect(text).toContain("AAABBBCCC");
    expect(text).not.toContain("STALE SCREEN");
  });

  it("names the dropped scrollback instead of implying the history is complete", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} />);

    expect(screen.queryByText(/earlier rows dropped/)).toBeNull();

    await act(async () => {
      bridge.emitResync("t1", 1234);
      await settle();
    });

    expect(screen.getByText("1,234 earlier rows dropped")).toBeTruthy();
  });

  it("surfaces a refusal BY NAME, with the remedy, and lets it be dismissed", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} />);

    await act(async () => {
      bridge.emitRefused("t1", "limit_project_terminals");
      await settle();
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("terminal limit");
    // The doctrine, asserted: the remedy is to close one, never an eviction.
    expect(alert.textContent).toContain("Close");

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
      await settle();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still names a refusal it has no prepared sentence for", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} />);

    await act(async () => {
      bridge.emitRefused("t1", "invalid_packet");
      await settle();
    });

    expect(screen.getByRole("alert").textContent).toContain("invalid_packet");
  });

  it("reports an exit rather than blanking the pane", async () => {
    const onExit = vi.fn();
    render(<XtermHost terminalId="t1" visible registry={registry} onExit={onExit} />);

    await act(async () => {
      bridge.emitData("t1", "output the user came back to read");
      bridge.emitExit("t1", 130, null);
      await settle();
    });

    expect(onExit).toHaveBeenCalledWith({ exitCode: 130, signal: null });
    expect(screen.getByText("Exited with code 130")).toBeTruthy();
    // The scrollback is why the pane stays: closing it would take away what the
    // user came back for.
    expect(bufferText("t1")).toContain("output the user came back to read");
  });

  it("raises title and directory changes without re-subscribing on every parent render", async () => {
    const onTitleChange = vi.fn();
    const onDisplayCwdChange = vi.fn();
    const view = render(
      <XtermHost
        terminalId="t1"
        visible
        registry={registry}
        onTitleChange={onTitleChange}
        onDisplayCwdChange={onDisplayCwdChange}
      />,
    );

    // A parent re-render with FRESH closures. If the subscriptions depended on
    // the callback identities they would tear down here, which means a detach
    // and a full replay on every parent render.
    view.rerender(
      <XtermHost
        terminalId="t1"
        visible
        registry={registry}
        onTitleChange={onTitleChange}
        onDisplayCwdChange={(value: string) => onDisplayCwdChange(value)}
      />,
    );
    expect(bridge.attaches).toEqual(["t1"]);
    expect(bridge.detaches).toEqual([]);

    await act(async () => {
      bridge.emitProperty("t1", { property: "title", value: "vim README.md" });
      // The LABEL the host derived, which is what this property now carries.
      // A raw path can no longer reach this callback: the union has no `cwd`
      // member, so the old spelling is a type error rather than a test that
      // quietly kept asserting on a value the wire stopped sending.
      bridge.emitProperty("t1", { property: "displayCwd", value: "src" });
      await settle();
    });

    expect(onTitleChange).toHaveBeenCalledWith("vim README.md");
    expect(onDisplayCwdChange).toHaveBeenCalledWith("src");
  });
});

describe("XtermHost lifecycle", () => {
  it("DETACHES on unmount and leaves no subscription behind", () => {
    const view = render(<XtermHost terminalId="t1" visible registry={registry} />);
    expect(bridge.subscriberCount("data")).toBe(1);

    view.unmount();

    // Detach, never kill: unmounting a pane is not a decision to end a shell.
    expect(bridge.detaches).toEqual(["t1"]);
    expect(bridge.kills).toEqual([]);
    expect(bridge.subscriberCount("data")).toBe(0);
    expect(bridge.subscriberCount("resync")).toBe(0);
    expect(bridge.subscriberCount("refused")).toBe(0);
    // The terminal itself outlives its consumer.
    expect(registry.has("t1")).toBe(true);
  });

  it("survives a StrictMode double-mount with ONE live subscription per kind", async () => {
    render(
      <StrictMode>
        <XtermHost terminalId="t1" visible registry={registry} />
      </StrictMode>,
    );
    sizeThePane();

    // StrictMode ran effect, cleanup, effect. Preload allows exactly one
    // subscriber per (terminal, kind); two would silently steal each other's
    // output.
    expect(bridge.subscriberCount("data")).toBe(1);
    expect(bridge.subscriberCount("exit")).toBe(1);
    expect(registry.has("t1")).toBe(true);

    // And the terminal is still the one that can receive the host's bytes.
    await act(async () => {
      bridge.emitData("t1", "alive after strict mode");
      await settle();
    });
    expect(bufferText("t1")).toContain("alive after strict mode");
  });

  it("asks the registry to re-measure when a hidden pane becomes visible", () => {
    const setVisible = vi.spyOn(registry, "setVisible");
    const view = render(<XtermHost terminalId="t1" visible={false} registry={registry} />);

    expect(setVisible).toHaveBeenLastCalledWith("t1", false);

    view.rerender(<XtermHost terminalId="t1" visible registry={registry} />);

    // A `display: none` pane measures 0x0, so any geometry computed while it was
    // hidden is meaningless and the pane MUST re-measure on activation. This
    // half asserts that the host asks; `terminal-registry.test.ts` asserts that
    // `setVisible(true)` is what performs the fit and reports the size. jsdom has
    // no layout engine, so the two halves cannot be one assertion here.
    expect(setVisible).toHaveBeenLastCalledWith("t1", true);
  });

  it("forwards a measured size to the host", () => {
    // The registry answers with a size (jsdom cannot produce one from layout),
    // and the host's job is to tell the pty about it.
    vi.spyOn(registry, "setVisible").mockReturnValue({ cols: 120, rows: 40 });
    render(<XtermHost terminalId="t1" visible registry={registry} />);

    expect(bridge.resizes).toContainEqual({ terminalId: "t1", cols: 120, rows: 40 });
  });

  it("layers the brand watermark under the terminal on the shared mark", () => {
    const { container } = render(<XtermHost terminalId="t1" visible registry={registry} />);
    // The vendorless mark, painted through the brand-mark token - not a second
    // drawing and not a raw colour.
    const mark = container.querySelector("svg.text-brand-mark");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });
});
