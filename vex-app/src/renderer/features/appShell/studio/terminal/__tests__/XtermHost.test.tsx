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

/**
 * THE SKIP-SHELL HANDLER, against a real xterm.
 *
 * This is the one assertion that could not be made anywhere else. The table's
 * suite proves which chords Studio owns and the hook's suite proves what it
 * does with them, and both were green while `Ctrl+W` in a terminal reached the
 * shell as `0x17` and never reached the document at all: the missing step was
 * xterm's own key handling, which is why the terminal here is real and only the
 * bridge is a double.
 *
 * The pattern is VS Code's own (`terminalInstance.test.ts:370`, "custom key
 * event handler should handle commands in DEFAULT_COMMANDS_TO_SKIP_SHELL"),
 * with one deliberate difference: theirs captures the handler and calls it,
 * while this dispatches a real `keydown` at xterm's textarea, so what is
 * asserted is what xterm DID with the key rather than what our callback
 * returned.
 */
describe("XtermHost and the chords Studio owns", () => {
  /** xterm's own input element, by the class xterm gives it. */
  function textarea(): HTMLTextAreaElement {
    const node = document.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    if (node === null) throw new Error("xterm rendered no textarea");
    return node;
  }

  function typeChord(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    textarea().dispatchEvent(event);
    return event;
  }

  function sentToShell(): string {
    return bridge.writes.map((write) => write.data).join("");
  }

  it("does not send a Studio chord to the shell, and does not cancel it either", () => {
    render(<XtermHost terminalId="t1" visible registry={registry} platform="linux" />);
    sizeThePane();

    // Ctrl+W. The shell's own meaning for it is "erase the last word", which is
    // exactly what the user got instead of the tab closing.
    const closeTab = typeChord({ key: "w", code: "KeyW", keyCode: 87, ctrlKey: true });
    // Ctrl+Tab and Ctrl+Shift+Tab, the two the strip never saw at all.
    const nextTab = typeChord({ key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true });
    const previousTab = typeChord({
      key: "Tab",
      code: "Tab",
      keyCode: 9,
      ctrlKey: true,
      shiftKey: true,
    });
    // The new-terminal chord.
    const newTerminal = typeChord({
      key: "`",
      code: "Backquote",
      keyCode: 192,
      ctrlKey: true,
      shiftKey: true,
    });

    // NOTHING REACHED THE PTY.
    expect(sentToShell()).toBe("");
    // AND NOTHING WAS CANCELLED. The hook that owns the table is a bubble-phase
    // listener on `document` and returns early on a defaultPrevented event, so
    // a refusal that also cancelled would swallow the chord it just protected.
    for (const event of [closeTab, nextTab, previousTab, newTerminal]) {
      expect(event.defaultPrevented, event.code).toBe(false);
    }
  });

  it("still sends the shell its own control keys", () => {
    render(<XtermHost terminalId="t1" visible registry={registry} platform="linux" />);
    sizeThePane();

    // Ctrl+C, and it must arrive as the interrupt byte. A terminal that could
    // not interrupt a runaway command would be a broken terminal, whatever the
    // shortcut table gained.
    typeChord({ key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });

    expect(sentToShell()).toBe("\u0003");
  });

  it("withdraws the refusal when the pane unmounts", () => {
    const view = render(
      <XtermHost terminalId="t1" visible registry={registry} platform="linux" />,
    );
    sizeThePane();
    const entry = registry.acquire("t1");
    registry.release("t1");
    view.unmount();

    // The terminal outlives the component (the registry owns it), so a policy
    // left attached would be applied by a host that is no longer driving it.
    // XTERM'S OWN ANSWER IS THE EVIDENCE: it cancels a key it handles, and the
    // three tests above turn on a refused chord NOT being cancelled. The pty
    // is not the evidence here - the input subscription went with the unmount,
    // so nothing would be written whatever xterm decided.
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      keyCode: 87,
      ctrlKey: true,
      cancelable: true,
    });
    expect(entry.terminal.textarea).not.toBeNull();
    entry.terminal.textarea?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The key path: what reaches the shell, and what Studio takes
 * ------------------------------------------------------------------ */

/**
 * A keypress as xterm's own handler sees it.
 *
 * `keyCode` is DEFINED rather than passed to the constructor because jsdom
 * exposes it as a getter, and xterm's `evaluateKeyboardEvent` reads it: without
 * it the library encodes NOTHING and every assertion below would pass against a
 * terminal that had simply ignored the key. Measured while writing this suite,
 * not assumed.
 */
function typeInto(
  terminal: { textarea?: HTMLTextAreaElement | undefined },
  spec: {
    code: string;
    key: string;
    keyCode: number;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
  },
): void {
  const event = new KeyboardEvent("keydown", {
    code: spec.code,
    key: spec.key,
    ctrlKey: spec.ctrl ?? false,
    shiftKey: spec.shift ?? false,
    metaKey: spec.meta ?? false,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "keyCode", { get: () => spec.keyCode });
  Object.defineProperty(event, "which", { get: () => spec.keyCode });
  terminal.textarea?.dispatchEvent(event);
}

/** The bytes the pty was sent, joined. */
function sentBytes(): string {
  return bridge.writes.map((write) => write.data).join("");
}

/** ETX, which is what `Ctrl+C` means to a shell. */
const INTERRUPT = "\u0003";

describe("XtermHost key path", () => {
  /**
   * THE CODEX-REVIEW DEFECT, as an experiment on the real library.
   *
   * `Ctrl+Enter` was in the skip list on behalf of `keepTabOpen`, an intent
   * that returns false on a terminal tab. xterm refused to encode it and no
   * owner acted, so the keystroke reached NEITHER Studio NOR the pty. Claude
   * Code, and every REPL that binds Ctrl+Enter to submit, lost the key.
   *
   * Revert either half of the fix - put `terminal` back in `keepTabOpen`'s
   * `when`, or drop the reserved/handled filter in `studioTerminalSkipChords` -
   * and this goes red: the bridge sees nothing.
   */
  it("lets Ctrl+Enter reach the pty", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} platform="win32" />);
    sizeThePane();
    const entry = registry.acquire("t1");
    registry.release("t1");

    await act(async () => {
      typeInto(entry.terminal, { code: "Enter", key: "Enter", keyCode: 13, ctrl: true });
      await settle();
    });

    expect(sentBytes()).toBe("\r");
  });

  /**
   * `Ctrl+\`` is the other key the projection ate, and it cannot be asserted the
   * same way: xterm encodes NO sequence for that chord (measured - the library
   * writes nothing for it even when it processes the event). So the observable
   * is the seam itself, which is all this component controls: the handler
   * ALLOWS xterm to process the key rather than refusing it on behalf of an
   * intent nothing answers.
   */
  it("does not refuse Ctrl+Backquote on Studio's behalf", () => {
    // Held on an object rather than in a `let`, so reading it back keeps its
    // declared type: TypeScript narrows a `let` that is only ever assigned
    // inside a callback to `null`, and working around that with an assertion
    // would be an assertion covering a real possibility (nothing attached).
    // The `throw` below covers it honestly instead.
    const captured: { handler: ((event: KeyboardEvent) => boolean) | null } = {
      handler: null,
    };
    const entry = registry.acquire("t1");
    const original = entry.terminal.attachCustomKeyEventHandler.bind(entry.terminal);
    entry.terminal.attachCustomKeyEventHandler = (fn) => {
      captured.handler = fn;
      original(fn);
    };
    registry.release("t1");

    render(<XtermHost terminalId="t1" visible registry={registry} platform="win32" />);
    const press = captured.handler;
    if (press === null) throw new Error("the host attached no key handler");

    const chord = (code: string): KeyboardEvent =>
      new KeyboardEvent("keydown", { code, ctrlKey: true, cancelable: true });

    // Reserved, so nothing will act on it: the shell gets the key.
    expect(press(chord("Backquote"))).toBe(true);
    // Bound and applicable on a terminal: Studio takes it, exactly as before.
    expect(press(chord("KeyW"))).toBe(false);
  });

  it("keeps Ctrl+C an interrupt when nothing is selected", async () => {
    render(<XtermHost terminalId="t1" visible registry={registry} platform="win32" />);
    sizeThePane();
    const entry = registry.acquire("t1");
    registry.release("t1");

    await act(async () => {
      typeInto(entry.terminal, { code: "KeyC", key: "c", keyCode: 67, ctrl: true });
      await settle();
    });

    // The clipboard table must never cost the terminal its interrupt.
    expect(sentBytes()).toBe(INTERRUPT);
  });

  it("copies and clears instead, once there IS a selection", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });

    render(<XtermHost terminalId="t1" visible registry={registry} platform="win32" />);
    sizeThePane();
    const entry = registry.acquire("t1");
    registry.release("t1");

    await act(async () => {
      bridge.emitData("t1", "pick me up");
      await settle();
    });
    act(() => {
      entry.terminal.selectAll();
    });
    expect(entry.terminal.hasSelection()).toBe(true);

    await act(async () => {
      typeInto(entry.terminal, { code: "KeyC", key: "c", keyCode: 67, ctrl: true });
      await settle();
    });

    expect(written.join("")).toContain("pick me up");
    // AND THE INTERRUPT WAS NOT SENT. Both halves matter: a copy that also
    // killed the running command would be worse than no copy at all.
    expect(sentBytes()).toBe("");
    expect(entry.terminal.hasSelection()).toBe(false);
  });

  it("pastes on Ctrl+Shift+V, into the pty like any other input", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("echo hello") },
    });

    render(<XtermHost terminalId="t1" visible registry={registry} platform="win32" />);
    sizeThePane();
    const entry = registry.acquire("t1");
    registry.release("t1");

    await act(async () => {
      typeInto(entry.terminal, {
        code: "KeyV",
        key: "V",
        keyCode: 86,
        ctrl: true,
        shift: true,
      });
      await settle();
    });

    expect(sentBytes()).toBe("echo hello");
  });

  it("says WHY when the clipboard is denied, and sends nothing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.reject(new Error("denied")) },
    });

    render(<XtermHost terminalId="t1" visible registry={registry} platform="win32" />);
    sizeThePane();
    const entry = registry.acquire("t1");
    registry.release("t1");

    await act(async () => {
      typeInto(entry.terminal, {
        code: "KeyV",
        key: "V",
        keyCode: 86,
        ctrl: true,
        shift: true,
      });
      await settle();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("denied");
    expect(alert.textContent).not.toContain("nexpected");
    expect(sentBytes()).toBe("");
  });
});

describe("XtermHost link path", () => {
  /**
   * THE DEFECT FROM THE OWNER'S SESSION (17.png, 18.png).
   *
   * xterm's OSC 8 provider activates through `options.linkHandler`, and with
   * none set it runs `confirm()` and `window.open`
   * (`@xterm/xterm/src/browser/OscLinkProvider.ts:114-129`) - the renderer
   * dialog the owner saw, followed by nothing, because main's window-open
   * handler serves a closed allowlist of Vex's own destinations. Remove the
   * `linkHandler` from `terminal-registry.ts` and both assertions go red.
   *
   * The renderer's whole contract is "it ASKED, with the exact string".
   * Whether a browser opens is main's authority, and is proved on main's side.
   */
  it("routes an activated link to the bridge and never to window.open", () => {
    const openSpy = vi.fn();
    Object.defineProperty(window, "open", { configurable: true, value: openSpy });

    render(<XtermHost terminalId="t1" visible registry={registry} />);
    const entry = registry.acquire("t1");
    registry.release("t1");

    const raw = "https://dexscreener.com/robinhood/0xf65E8?a=1%2B2";
    const activate = entry.terminal.options.linkHandler?.activate;
    expect(activate).toBeTypeOf("function");
    activate?.(new MouseEvent("click"), raw, {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    });

    // The RAW string, byte for byte: re-serialising a URL is lossy.
    expect(bridge.openedLinks).toEqual([raw]);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("XtermHost on glass", () => {
  it("paints no surface of its own and keeps the grid inset from the pane edge", () => {
    const { container } = render(<XtermHost terminalId="t1" visible registry={registry} />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    // The pane above is the surface; a fill here would sit between the glass
    // and the alpha-0 canvas and turn the pane back into a card.
    expect(root?.className).toContain("bg-transparent");
    expect(root?.className).not.toMatch(/\bbg-surface-/);
    // The registry's wrapper fills its container's box, so the inset the text
    // keeps from the pane's edge light is the container's margin.
    const wrapper = container.querySelector("[data-terminal-id]");
    expect(wrapper?.parentElement?.className).toContain("mx-2");
    expect(wrapper?.parentElement?.className).toContain("mb-2");
  });
});
