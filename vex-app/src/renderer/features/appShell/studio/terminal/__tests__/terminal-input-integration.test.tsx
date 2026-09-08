import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../../../../stores/uiStore.js";
import type { StudioPlatform } from "../../keybindings-labels.js";
import { TerminalRegistry } from "../terminal-registry.js";
import { XtermHost } from "../XtermHost.js";
import { installMatchMedia, installResizeObserver, installTerminalBridge, stubBox, type TerminalBridgeStub } from "./terminal-harness.js";

let registry: TerminalRegistry;
let bridge: TerminalBridgeStub;
const escape = String.fromCharCode(27);
beforeEach(() => {
  installMatchMedia(); installResizeObserver();
  bridge = installTerminalBridge();
  registry = new TerminalRegistry({ webglLoader: () => Promise.reject(new Error("no gl")) });
  useUiStore.setState({ terminalPasteWarning: true });
});
afterEach(() => { cleanup(); registry.disposeAll(); });
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
function pane(platform: StudioPlatform = "linux") {
  const mounted = render(<XtermHost terminalId="t1" visible registry={registry} platform={platform} />);
  for (const node of document.querySelectorAll("div")) stubBox(node, { width: 800, height: 400 });
  const entry = registry.acquire("t1"); registry.release("t1");
  const textarea = entry.wrapper.querySelector("textarea");
  if (textarea === null) throw new Error("terminal has no textarea");
  return { ...mounted, entry, textarea };
}
function sent(): string { return bridge.writes.map((write) => write.data).join(""); }
async function paste(textarea: HTMLTextAreaElement, platform: StudioPlatform = "linux"): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "v", code: "KeyV", keyCode: 86, metaKey: platform === "darwin", ctrlKey: platform !== "darwin", shiftKey: platform === "linux" });
    await settle();
  });
}

describe("main-owned clipboard in the terminal", () => {
  it.each(["darwin", "linux", "win32"] as const)("copies selected text using the %s keyboard chord", async (platform) => {
    const { entry, textarea } = pane(platform);
    await act(async () => { bridge.emitData("t1", "selected message"); await settle(); });
    act(() => entry.terminal.selectAll());
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "c", code: "KeyC", keyCode: 67, metaKey: platform === "darwin", ctrlKey: platform !== "darwin", shiftKey: platform !== "darwin" });
      await settle();
    });
    expect(bridge.copiedText.join("")).toContain("selected message");
    expect(sent()).toBe("");
  });
  it("copies selected text through the macOS context menu", async () => {
    const { entry, textarea } = pane("darwin");
    await act(async () => { bridge.emitData("t1", "menu selection"); await settle(); });
    act(() => entry.terminal.selectAll());
    fireEvent.contextMenu(textarea, { clientX: 100, clientY: 100 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(bridge.copiedText.join("")).toContain("menu selection"));
    expect(sent()).toBe("");
  });
  it.each(["darwin", "linux", "win32"] as const)("sends raw image paste input on %s in bracketed mode", async (platform) => {
    const { entry, textarea } = pane(platform);
    await act(async () => { bridge.emitData("t1", `${escape}[?2004h`); await settle(); });
    expect(entry.terminal.modes.bracketedPasteMode).toBe(true);
    bridge.clipboardContent = { kind: "image" };
    await paste(textarea, platform);
    expect(sent()).toBe(platform === "win32" ? `${escape}v` : String.fromCharCode(22));
  });
  it("pastes text with one final newline removed", async () => {
    const { textarea } = pane();
    bridge.clipboardContent = { kind: "text", text: "echo review\n" };
    await paste(textarea);
    expect(sent()).toBe("echo review");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("pastes from the context menu and Windows right click", async () => {
    const mac = pane("darwin");
    bridge.clipboardContent = { kind: "text", text: "first" };
    fireEvent.contextMenu(mac.textarea, { clientX: 100, clientY: 100 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Paste" }));
    await waitFor(() => expect(sent()).toBe("first"));
    mac.unmount();
    const windows = pane("win32");
    bridge.clipboardContent = { kind: "text", text: "second" };
    await act(async () => { fireEvent.contextMenu(windows.textarea); await settle(); });
    expect(sent()).toBe("firstsecond");
  });
  it.each(["text", "image"] as const)("cancels a delayed %s read when the user focuses another control", async (kind) => {
    const { textarea } = pane();
    const field = document.createElement("input");
    document.body.appendChild(field);
    bridge.clipboardContent = kind === "text" ? { kind, text: "first\nsecond" } : { kind };
    bridge.deferClipboard = true;
    try {
      await paste(textarea);
      expect(bridge.pendingClipboardReads).toHaveLength(1);
      field.focus();
      await act(async () => { for (const resolve of bridge.pendingClipboardReads.splice(0)) resolve(); await settle(); });
      expect(sent()).toBe("");
      expect(document.activeElement).toBe(field);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain("Terminal focus changed");
    } finally {
      field.remove();
    }
  });
  it.each(["unmount", "hide"])("ignores stale clipboard read after %s", async (action) => {
    const mounted = pane();
    bridge.clipboardContent = { kind: "text", text: "late" }; bridge.deferClipboard = true;
    await paste(mounted.textarea);
    expect(bridge.pendingClipboardReads).toHaveLength(1);
    if (action === "unmount") mounted.unmount();
    else mounted.rerender(<XtermHost terminalId="t1" visible={false} registry={registry} platform="linux" />);
    await act(async () => { for (const resolve of bridge.pendingClipboardReads.splice(0)) resolve(); await settle(); });
    expect(sent()).toBe("");
  });
});

describe("multiline paste confirmation", () => {
  it.each(["cancel", "paste", "one line"])("handles %s with preference changes only on confirm", async (choice) => {
    const { textarea } = pane();
    bridge.clipboardContent = { kind: "text", text: "first\nsecond\n" };
    await paste(textarea);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("2 lines");
    expect(dialog.querySelector("svg.text-brand-mark")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(sent()).toBe("");
    fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again" }));
    fireEvent.click(screen.getByRole("button", { name: choice === "cancel" ? "Cancel" : choice === "paste" ? "Paste" : "Paste as one line" }));
    await act(settle);
    expect(sent()).toBe(choice === "cancel" ? "" : choice === "paste" ? "first\rsecond" : "first second");
    expect(useUiStore.getState().terminalPasteWarning).toBe(choice === "cancel");
    if (choice === "cancel") expect(screen.getByRole("alert").textContent).toContain("cancel");
  });
  it("retains a persisted opt-out while still stripping a final newline", async () => {
    const { textarea } = pane();
    useUiStore.getState().setTerminalPasteWarning(false);
    bridge.clipboardContent = { kind: "text", text: "first\nsecond\n" };
    await paste(textarea);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent()).toBe("first\rsecond");
  });
  it("bounds an untrusted preview and reveals all text only on request", async () => {
    const { textarea } = pane();
    bridge.clipboardContent = { kind: "text", text: `${"x".repeat(35)}\n<img src=x>\nthird\nfourth` };
    await paste(textarea);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("pre")?.textContent).toBe(`${"x".repeat(30)}\n<img src=x>\nthird`);
    expect(dialog.textContent).toContain("1 more lines; 1 preview lines shortened");
    expect(dialog.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all text" }));
    expect(dialog.querySelector("pre")?.textContent).toContain("fourth");
    expect(sent()).toBe("");
  });
  it("suppresses warning in bracketed mode and preserves final newline", async () => {
    const { entry, textarea } = pane();
    await act(async () => { bridge.emitData("t1", `${escape}[?2004h`); await settle(); });
    expect(entry.terminal.modes.bracketedPasteMode).toBe(true);
    bridge.clipboardContent = { kind: "text", text: "first\nsecond\n" };
    await paste(textarea);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent()).toBe(`${escape}[200~first\rsecond\r${escape}[201~`);
  });
});

describe("file input and visible refusals", () => {
  it("pastes every copied local file as a quoted path without Enter", async () => {
    const { textarea } = pane();
    const file = new File([""], "shot.png"); const other = new File([""], "other.txt");
    bridge.clipboardContent = { kind: "files" }; bridge.clipboardFiles = [file, other];
    bridge.filePaths.set(file, "/tmp/my shot.png"); bridge.filePaths.set(other, "/tmp/other.txt");
    await paste(textarea);
    expect(sent()).toBe("'/tmp/my shot.png' '/tmp/other.txt'");
  });
  it("cancels a copied-file paste when focus moves to another pane before the native event", async () => {
    const first = pane();
    render(<XtermHost terminalId="t2" visible registry={registry} platform="linux" />);
    const other = registry.acquire("t2"); registry.release("t2");
    const otherTextarea = other.wrapper.querySelector("textarea");
    if (otherTextarea === null) throw new Error("second terminal has no textarea");
    const file = new File([""], "local.txt");
    bridge.clipboardContent = { kind: "files" };
    bridge.filePaths.set(file, "/tmp/local.txt");
    let deliverPaste: (() => void) | undefined;
    const trigger = vi.spyOn(window.vex.terminalInput, "triggerPaste").mockImplementation(() => new Promise((resolve) => {
      deliverPaste = () => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
        document.activeElement?.dispatchEvent(event);
        resolve({ ok: true, data: { kind: "triggered" } });
      };
    }));
    try {
      await paste(first.textarea);
      expect(trigger).toHaveBeenCalledOnce();
      otherTextarea.focus();
      expect(document.activeElement).toBe(otherTextarea);
      await act(async () => { deliverPaste?.(); await settle(); });
      expect(bridge.writes).toEqual([]);
      expect(document.activeElement).toBe(otherTextarea);
      expect(screen.getByRole("alert").textContent).toMatch(/focus changed|cancelled/i);
    } finally {
      trigger.mockRestore();
    }
  });
  it.each(["hide", "unmount"])("drains a queued native file event after %s without sending it to another pane", async (change) => {
    const first = pane();
    render(<XtermHost terminalId="t2" visible registry={registry} platform="linux" />);
    const other = registry.acquire("t2"); registry.release("t2");
    const otherTextarea = other.wrapper.querySelector("textarea");
    if (otherTextarea === null) throw new Error("second terminal has no textarea");
    const file = new File([""], "local.txt");
    bridge.clipboardContent = { kind: "files" };
    bridge.filePaths.set(file, "/tmp/local.txt");
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    let deliverPaste: (() => void) | undefined;
    const trigger = vi.spyOn(window.vex.terminalInput, "triggerPaste").mockImplementation(() => new Promise((resolve) => {
      deliverPaste = () => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
        document.activeElement?.dispatchEvent(event);
        resolve({ ok: true, data: { kind: "triggered" } });
      };
    }));
    try {
      await paste(first.textarea);
      expect(trigger).toHaveBeenCalledOnce();
      const capture = addListener.mock.calls.find(([name, , capturePhase]) => name === "paste" && capturePhase === true)?.[1];
      expect(capture).toBeDefined();
      if (change === "hide") first.rerender(<XtermHost terminalId="t1" visible={false} registry={registry} platform="linux" />);
      else first.unmount();
      otherTextarea.focus();
      await act(async () => { deliverPaste?.(); await settle(); });
      expect(bridge.writes).toEqual([]);
      expect(document.activeElement).toBe(otherTextarea);
      expect(removeListener).toHaveBeenCalledWith("paste", capture, true);
    } finally {
      trigger.mockRestore();
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });
  it("retains native paste capture while main acknowledgment is delayed beyond the event timeout", async () => {
    const first = pane();
    render(<XtermHost terminalId="t2" visible registry={registry} platform="linux" />);
    const other = registry.acquire("t2"); registry.release("t2");
    const otherTextarea = other.wrapper.querySelector("textarea");
    if (otherTextarea === null) throw new Error("second terminal has no textarea");
    const file = new File([""], "local.txt");
    bridge.clipboardContent = { kind: "files" };
    bridge.filePaths.set(file, "/tmp/local.txt");
    let deliverPaste: (() => void) | undefined;
    const trigger = vi.spyOn(window.vex.terminalInput, "triggerPaste").mockImplementation(() => new Promise((resolve) => {
      deliverPaste = () => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
        document.activeElement?.dispatchEvent(event);
        resolve({ ok: true, data: { kind: "triggered" } });
      };
    }));
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.keyDown(first.textarea, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true }); });
      expect(trigger).toHaveBeenCalledOnce();
      first.unmount();
      otherTextarea.focus();
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      await act(async () => { deliverPaste?.(); await vi.advanceTimersByTimeAsync(0); });
      expect(bridge.writes).toEqual([]);
      expect(document.activeElement).toBe(otherTextarea);
    } finally {
      trigger.mockRestore();
      vi.useRealTimers();
    }
  });
  it("shows the drop overlay and inserts local paths on drop", async () => {
    const { container, textarea } = pane();
    const file = new File([""], "shot.png"); bridge.filePaths.set(file, "/tmp/my shot.png");
    fireEvent.dragEnter(textarea, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.getByRole("status").textContent).toContain("Drop files");
    expect(screen.getByRole("status").className).toContain("pointer-events-none");
    await act(async () => { fireEvent.drop(textarea, { dataTransfer: { types: ["Files"], files: [file] } }); await settle(); });
    expect(sent()).toBe("'/tmp/my shot.png'");
    expect(container.querySelector("[role=status]")).toBeNull();
  });
  it("refuses an entire drop when any file has no local path", async () => {
    const { textarea } = pane();
    const good = new File([""], "saved.png");
    const unsaved = new File([""], "clipboard.png");
    bridge.filePaths.set(good, "/tmp/saved.png");
    await act(async () => { fireEvent.drop(textarea, { dataTransfer: { types: ["Files"], files: [good, unsaved] } }); await settle(); });
    expect(sent()).toBe("");
    expect(screen.getByRole("alert").textContent).toContain("Save it locally");
  });
  it("consolidates transport and clipboard refusals into one branded notice", async () => {
    const { textarea } = pane();
    act(() => bridge.emitRefused("t1", "host_unavailable"));
    bridge.clipboardContent = { kind: "refused", reason: "terminal_clipboard_too_large" };
    await paste(textarea);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Nothing was shortened");
    expect(alert.textContent).not.toContain("system denied");
    expect(alert.querySelector("svg.text-brand-mark")).not.toBeNull();
    expect(sent()).toBe("");
  });
});
