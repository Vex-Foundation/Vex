/**
 * The registry's LIFECYCLE contract, with a real xterm.
 *
 * The one defect this suite exists to make impossible is the StrictMode dispose:
 * React 19 runs mount -> effect -> cleanup -> effect, so if `release` destroyed
 * a terminal at zero consumers, every development-mode mount would kill the
 * shell it just opened. That bug is invisible in production and fatal in
 * development, which is the worst combination to find by hand.
 *
 * A real `Terminal` is used rather than a double because the things being
 * asserted - that the wrapper element survives a move, that the buffer survives
 * a release, that `dispose` actually tears xterm down - are properties of xterm,
 * not of our bookkeeping. A double would let all four assertions pass while the
 * real integration was broken.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../terminal-registry.js";
import { installMatchMedia, stubBox } from "./terminal-harness.js";

/** The chain must not attempt a real WebGL load; jsdom has no context. */
const noWebgl = { webglLoader: () => Promise.reject(new Error("no gl in jsdom")) };

/**
 * Write and WAIT for xterm to have parsed it.
 *
 * `write` is asynchronous inside xterm; asserting on the buffer without the
 * callback reads whatever was there before the parse ran.
 */
function writeAndSettle(terminal: { write: (data: string, cb: () => void) => void }, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

/**
 * The first row of the scrollback - the thing a user is actually looking at.
 *
 * MEASURED, not assumed (probed against xterm 6.0.0 before this suite was
 * written): a DISPOSED xterm still answers `write` without throwing and still
 * serves its buffer, so "did it throw" and "is the buffer readable" both stay
 * green when a terminal has been destroyed. They are worthless as liveness
 * assertions. What a dispose DOES change is that the registry drops the record,
 * so the next `acquire` builds a NEW Terminal with an empty buffer - which is
 * exactly the user-visible loss. Identity plus surviving content is therefore
 * the honest observable, and this suite uses only that.
 */
function firstRow(terminal: {
  buffer: { active: { getLine: (index: number) => { translateToString: () => string } | undefined } };
}): string {
  return terminal.buffer.active.getLine(0)?.translateToString().trim() ?? "";
}

function mount(): HTMLDivElement {
  const host = document.createElement("div");
  stubBox(host, { width: 800, height: 400 });
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  installMatchMedia();
  document.body.innerHTML = "";
});

describe("TerminalRegistry lifecycle", () => {
  it("creates ONCE and hands the same instance to a second acquire", () => {
    const registry = new TerminalRegistry(noWebgl);

    const first = registry.acquire("t1");
    const second = registry.acquire("t1");

    expect(second).toBe(first);
    expect(second.terminal).toBe(first.terminal);
    expect(second.wrapper).toBe(first.wrapper);
    expect(registry.consumerCount("t1")).toBe(2);

    registry.disposeAll();
  });

  it("survives a StrictMode double-mount: acquire, release, acquire keeps the terminal", async () => {
    const registry = new TerminalRegistry(noWebgl);
    const host = mount();

    // Effect #1.
    const first = registry.acquire("t1");
    registry.attach("t1", host);
    await writeAndSettle(first.terminal, "work in progress");

    // Cleanup #1 - the count goes to ZERO, and nothing may be destroyed.
    registry.release("t1");
    expect(registry.consumerCount("t1")).toBe(0);
    expect(registry.has("t1")).toBe(true);

    // Effect #2.
    const second = registry.acquire("t1");
    registry.attach("t1", host);

    // The two assertions that go red the moment `release` starts disposing: a
    // disposed record would make this a BRAND NEW terminal with an empty buffer,
    // and what the user was reading would be gone.
    expect(second.terminal).toBe(first.terminal);
    expect(second.wrapper).toBe(first.wrapper);
    expect(firstRow(second.terminal)).toBe("work in progress");

    registry.disposeAll();
  });

  it("gives a FRESH terminal after a dispose, which is what release must not cause", async () => {
    const registry = new TerminalRegistry(noWebgl);
    const host = mount();
    const first = registry.acquire("t1");
    registry.attach("t1", host);
    await writeAndSettle(first.terminal, "work in progress");

    registry.dispose("t1");
    const replacement = registry.acquire("t1");

    // The contrast that gives the StrictMode case above its meaning: this is
    // what a wrongly-disposing `release` would look like to the user.
    expect(replacement.terminal).not.toBe(first.terminal);
    expect(firstRow(replacement.terminal)).toBe("");

    registry.disposeAll();
  });

  it("re-parents on a move and is a NO-OP when the container did not change", () => {
    const registry = new TerminalRegistry(noWebgl);
    const entry = registry.acquire("t1");
    const first = mount();
    const second = mount();

    registry.attach("t1", first);
    expect(entry.wrapper.parentElement).toBe(first);

    // The same container again: the wrapper must not be detached and re-added,
    // which would repaint the canvas and drop the selection.
    registry.attach("t1", first);
    expect(entry.wrapper.parentElement).toBe(first);

    registry.attach("t1", second);
    expect(entry.wrapper.parentElement).toBe(second);
    expect(first.childElementCount).toBe(0);

    registry.disposeAll();
  });

  it("releases the LAST consumer by detaching the wrapper, not by disposing", async () => {
    const registry = new TerminalRegistry(noWebgl);
    const entry = registry.acquire("t1");
    const host = mount();
    registry.attach("t1", host);
    await writeAndSettle(entry.terminal, "kept");

    registry.release("t1");

    expect(entry.wrapper.isConnected).toBe(false);
    expect(registry.has("t1")).toBe(true);
    expect(registry.acquire("t1").terminal).toBe(entry.terminal);
    expect(firstRow(entry.terminal)).toBe("kept");

    registry.disposeAll();
  });

  it("disposes only on the explicit call, and is idempotent", () => {
    const registry = new TerminalRegistry(noWebgl);
    const entry = registry.acquire("t1");
    const host = mount();
    registry.attach("t1", host);

    registry.dispose("t1");
    expect(registry.has("t1")).toBe(false);
    expect(entry.wrapper.isConnected).toBe(false);

    // A second dispose (a close racing a window teardown) must not throw.
    expect(() => {
      registry.dispose("t1");
    }).not.toThrow();
  });

  it("keeps terminals independent: disposing one leaves the other running", async () => {
    const registry = new TerminalRegistry(noWebgl);
    const kept = registry.acquire("keep");
    registry.acquire("doomed");
    await writeAndSettle(kept.terminal, "still here");

    registry.dispose("doomed");

    expect(registry.has("keep")).toBe(true);
    expect(registry.acquire("keep").terminal).toBe(kept.terminal);
    expect(firstRow(kept.terminal)).toBe("still here");

    registry.disposeAll();
    expect(registry.has("keep")).toBe(false);
  });

  it("toggles the active class on setVisible and REFITS only when shown", () => {
    const registry = new TerminalRegistry(noWebgl);
    const entry = registry.acquire("t1");
    const host = mount();
    registry.attach("t1", host);
    // jsdom has no layout engine, so FitAddon can never propose a real size.
    // Stubbing the ONE measurement it makes keeps everything downstream of the
    // measurement - the resize, the reported size, the hidden/shown asymmetry -
    // real, which is the part that carries the risk.
    vi.spyOn(entry.fit, "proposeDimensions").mockReturnValue({ cols: 120, rows: 40 });

    // HIDDEN: no fit at all. A `display: none` element measures 0x0, and fitting
    // to that would reflow the user's shell to a geometry nobody is looking at.
    expect(registry.setVisible("t1", false)).toBeNull();
    expect(entry.wrapper.className).not.toContain("--active");
    expect(entry.terminal.cols).not.toBe(120);

    // SHOWN: fit, apply, and report - the second half of the activation contract
    // whose first half (`XtermHost` asking) lives in XtermHost.test.tsx.
    expect(registry.setVisible("t1", true)).toEqual({ cols: 120, rows: 40 });
    expect(entry.wrapper.className).toContain("--active");
    expect(entry.terminal.cols).toBe(120);
    expect(entry.terminal.rows).toBe(40);

    registry.disposeAll();
  });

  it("reports null rather than a fabricated size when nothing can be measured", () => {
    const registry = new TerminalRegistry(noWebgl);
    registry.acquire("t1");
    // Never attached: the wrapper has no layout, so a fit has no basis. A
    // fabricated size here would reflow the user's shell to a geometry that
    // exists nowhere.
    expect(registry.refit("t1")).toBeNull();
    registry.disposeAll();
  });

  it("ignores every operation on an unknown id", () => {
    const registry = new TerminalRegistry(noWebgl);
    expect(registry.consumerCount("nope")).toBe(0);
    expect(registry.refit("nope")).toBeNull();
    expect(registry.setVisible("nope", true)).toBeNull();
    expect(() => {
      registry.release("nope");
      registry.dispose("nope");
      registry.attach("nope", mount());
    }).not.toThrow();
  });
});
