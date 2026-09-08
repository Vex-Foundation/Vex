import type { ILinkProviderOptions } from "@xterm/addon-web-links";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalClipboard, TerminalClipboardError } from "../../../../../lib/api/terminal-input.js";
import { TerminalRegistry } from "../terminal-registry.js";
import { installMatchMedia, stubBox } from "./terminal-harness.js";

const webLinks = vi.hoisted((): {
  activate: (event: MouseEvent, uri: string) => void;
  options: ILinkProviderOptions;
} => ({
  activate: (_event: MouseEvent, _uri: string): void => undefined,
  options: {},
}));

vi.mock("@xterm/addon-web-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xterm/addon-web-links")>();
  return {
    WebLinksAddon: class extends actual.WebLinksAddon {
      constructor(handler: (event: MouseEvent, uri: string) => void, options: ILinkProviderOptions) {
        super(handler, options);
        webLinks.activate = handler;
        webLinks.options = options;
      }
    },
  };
});

const registries: TerminalRegistry[] = [];
function mount(platform: "darwin" | "linux" | "win32" = "linux"): {
  registry: TerminalRegistry;
  entry: ReturnType<TerminalRegistry["acquire"]>;
} {
  const registry = new TerminalRegistry({ platform, webglLoader: () => Promise.reject(new Error("no gl in jsdom")) });
  registries.push(registry);
  const entry = registry.acquire("t1");
  const host = document.createElement("div");
  stubBox(host, { width: 800, height: 400 });
  document.body.appendChild(host);
  registry.attach("t1", host);
  return { registry, entry };
}
const range = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };

beforeEach(() => {
  installMatchMedia();
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const registry of registries) registry.disposeAll();
  registries.length = 0;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function write(terminal: { write: (data: string, callback: () => void) => void }, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe("terminal registry links", () => {
  it.each(["darwin", "linux", "win32"] as const)("gates both providers on %s and keeps the raw URL", async (platform) => {
    const { registry, entry } = mount(platform);
    const openLink = vi.fn().mockResolvedValue(undefined);
    registry.setInteractionHandlers("t1", { openLink, onNotice: vi.fn() }, platform);
    const raw = "https://example.com/path?a=1%2B2";
    const primary = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    for (const activate of [
      (event: MouseEvent) => entry.terminal.options.linkHandler?.activate(event, raw, range),
      (event: MouseEvent) => webLinks.activate(event, raw),
    ]) {
      openLink.mockClear();
      const plain = new MouseEvent("click", { cancelable: true });
      activate(plain);
      await settle();
      expect(plain.defaultPrevented).toBe(true);
      expect(openLink).not.toHaveBeenCalled();
      for (const button of [1, 2]) activate(new MouseEvent("click", { ...primary, button }));
      await settle();
      expect(openLink).not.toHaveBeenCalled();
      const modified = new MouseEvent("click", { ...primary, cancelable: true });
      activate(modified);
      await settle();
      expect(modified.defaultPrevented).toBe(true);
      expect(openLink).toHaveBeenCalledWith(raw, expect.any(AbortSignal));
    }
  });

  it.each(["release", "hide", "dispose", "unsubscribe", "move"])("withdraws pending consent on %s", async (operation) => {
    const { registry, entry } = mount();
    let signal: AbortSignal | undefined;
    const off = registry.setInteractionHandlers("t1", {
      openLink: (_url, requestSignal) => {
        signal = requestSignal;
        return new Promise(() => undefined);
      },
      onNotice: vi.fn(),
    });
    entry.terminal.options.linkHandler?.activate(new MouseEvent("click", { ctrlKey: true }), "https://example.com", range);
    await settle();
    expect(signal?.aborted).toBe(false);
    switch (operation) {
      case "release": registry.release("t1"); break;
      case "hide": registry.setVisible("t1", false); break;
      case "dispose": registry.dispose("t1"); break;
      case "unsubscribe": off(); off(); break;
      case "move": registry.attach("t1", document.createElement("div")); break;
    }
    expect(signal?.aborted).toBe(true);
  });

  it("surfaces a missing answerer and a rejected opener without leaking its error", async () => {
    const { registry, entry } = mount();
    entry.terminal.options.linkHandler?.activate(new MouseEvent("click", { ctrlKey: true }), "https://example.com", range);
    const onNotice = vi.fn();
    registry.setInteractionHandlers("t1", { openLink: () => Promise.reject(new Error("private transport detail")), onNotice });
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("cannot ask"));
    entry.terminal.options.linkHandler?.activate(new MouseEvent("click", { ctrlKey: true }), "https://example.com", range);
    await settle();
    expect(onNotice).toHaveBeenLastCalledWith("Vex could not finish opening this link. Try again.");
  });

  it("wires hover and leave callbacks for both providers", () => {
    const { entry } = mount();
    expect(entry.terminal.options.linkHandler?.hover).toBeTypeOf("function");
    expect(entry.terminal.options.linkHandler?.leave).toBeTypeOf("function");
    expect(webLinks.options.hover).toBeTypeOf("function");
    expect(webLinks.options.leave).toBeTypeOf("function");
  });
});

describe("terminal registry OSC 52 clipboard", () => {
  it("allows native clipboard writes but sends no bytes for unsolicited read queries", async () => {
    const { entry } = mount();
    const writeText = vi.spyOn(terminalClipboard, "writeText").mockResolvedValue(undefined);
    const readText = vi.spyOn(terminalClipboard, "readText").mockResolvedValue("private clipboard value");
    const replies: string[] = [];
    const off = entry.terminal.onData((value) => replies.push(value));
    await write(entry.terminal, "\x1b]52;c;d3JpdGUgdmFsdWU=\x07");
    expect(writeText).toHaveBeenCalledWith("write value");
    for (const selection of ["c", "p", "s", "", "cp"]) {
      await write(entry.terminal, `\x1b]52;${selection};?\x07`);
    }
    expect(readText).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
    off.dispose();
  });

  it("names a bounded clipboard failure and keeps the parser alive", async () => {
    const { registry, entry } = mount();
    const onNotice = vi.fn();
    registry.setInteractionHandlers("t1", { openLink: vi.fn(), onNotice });
    vi.spyOn(terminalClipboard, "writeText").mockRejectedValue(new TerminalClipboardError("terminal_clipboard_too_large"));
    await write(entry.terminal, "\x1b]52;c;dGV4dA==\x07");
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("exceeds Vex's terminal limit"));
    await write(entry.terminal, "still reading");
    expect(entry.terminal.buffer.active.getLine(0)?.translateToString()).toContain("still reading");
  });

  it("does not redirect unsupported selection clipboard operations to the system clipboard", async () => {
    const { registry, entry } = mount();
    const onNotice = vi.fn();
    registry.setInteractionHandlers("t1", { openLink: vi.fn(), onNotice });
    const readText = vi.spyOn(terminalClipboard, "readText");
    const writeText = vi.spyOn(terminalClipboard, "writeText");
    await write(entry.terminal, "\x1b]52;p;dGV4dA==\x07\x1b]52;p;?\x07");
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("selection clipboard is unavailable"));
  });
});
