import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primaryModifierName, type StudioPlatform } from "../../keybindings-labels.js";
import { isTerminalLinkActivation, TerminalLinkHint } from "../terminal-link-hint.js";

describe("terminal link modifier", () => {
  it.each(["darwin", "linux", "win32"] as const)("labels the mouse modifier through the platform owner on %s", (platform) => {
    expect(primaryModifierName(platform)).toBe(platform === "darwin" ? "cmd" : "ctrl");
  });
  it.each<StudioPlatform>(["darwin", "linux", "win32"])("requires modifier and left click on %s", (platform) => {
    const primary = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    const other = platform === "darwin" ? { ctrlKey: true } : { metaKey: true };
    expect(isTerminalLinkActivation(new MouseEvent("click"), platform)).toBe(false);
    expect(isTerminalLinkActivation(new MouseEvent("click", primary), platform)).toBe(true);
    expect(isTerminalLinkActivation(new MouseEvent("click", other), platform)).toBe(false);
    for (const button of [1, 2]) {
      expect(isTerminalLinkActivation(new MouseEvent("click", { ...primary, button }), platform)).toBe(false);
    }
  });
});

describe("terminal link hint lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => vi.useRealTimers());

  function mount(): {
    hint: TerminalLinkHint;
    wrapper: HTMLElement;
    scroll: () => void;
    render: () => void;
    disposeScroll: ReturnType<typeof vi.fn>;
    disposeRender: ReturnType<typeof vi.fn>;
  } {
    const wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    let scroll = (): void => undefined;
    let render = (): void => undefined;
    const disposeScroll = vi.fn();
    const disposeRender = vi.fn();
    const hint = new TerminalLinkHint({
      onScroll: (listener) => {
        scroll = () => listener(1);
        return { dispose: disposeScroll };
      },
      onRender: (listener) => {
        render = () => listener({ start: 0, end: 5 });
        return { dispose: disposeRender };
      },
    }, wrapper);
    return { hint, wrapper, scroll: () => scroll(), render: () => render(), disposeScroll, disposeRender };
  }

  it("delays, labels macOS, and renders untrusted URL text literally", () => {
    const { hint, wrapper } = mount();
    const url = "https://example.com/<img src=x onerror=alert(1)>";
    hint.show(url, "darwin");
    expect(wrapper.querySelector("[role=tooltip]")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(wrapper.querySelector("[role=tooltip]")?.textContent).toBe(`Follow link (cmd + click)\n${url}`);
    expect(wrapper.querySelector("img")).toBeNull();
    hint.dispose();
  });

  it.each(["clear", "scroll", "render", "leave", "wheel", "dispose"])("cancels before and after display on %s", (reason) => {
    for (const displayed of [false, true]) {
      const fixture = mount();
      fixture.hint.show("https://example.com", "linux");
      if (displayed) vi.advanceTimersByTime(500);
      switch (reason) {
        case "clear": fixture.hint.clear(); break;
        case "scroll": fixture.scroll(); break;
        case "render": fixture.render(); break;
        case "leave": fixture.wrapper.dispatchEvent(new MouseEvent("mouseleave")); break;
        case "wheel": fixture.wrapper.dispatchEvent(new WheelEvent("wheel")); break;
        case "dispose": fixture.hint.dispose(); break;
      }
      vi.advanceTimersByTime(500);
      expect(fixture.wrapper.querySelector("[role=tooltip]")).toBeNull();
      fixture.hint.dispose();
    }
  });

  it("does not display a delayed hint in a detached terminal", () => {
    const { hint, wrapper } = mount();
    hint.show("https://example.com", "linux");
    wrapper.remove();
    vi.advanceTimersByTime(500);
    expect(wrapper.querySelector("[role=tooltip]")).toBeNull();
    hint.dispose();
  });

  it("replaces a pending link and unregisters listeners once", () => {
    const { hint, wrapper, disposeScroll, disposeRender } = mount();
    hint.show("old", "darwin");
    hint.show("new", "win32");
    vi.advanceTimersByTime(500);
    expect(wrapper.querySelector("[role=tooltip]")?.textContent).toBe("Follow link (ctrl + click)\nnew");
    hint.dispose();
    hint.dispose();
    hint.show("late", "linux");
    vi.advanceTimersByTime(500);
    expect(wrapper.querySelector("[role=tooltip]")).toBeNull();
    expect(disposeScroll).toHaveBeenCalledOnce();
    expect(disposeRender).toHaveBeenCalledOnce();
  });
});
