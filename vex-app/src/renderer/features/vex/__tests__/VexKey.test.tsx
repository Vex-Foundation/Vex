/**
 * The Vex key (docs/design/H3-DESKTOP.md sections 1.3, 1.6 and 3.3): the
 * header's cell over the Vex column, one control in three cells. The presence
 * is mocked here (its wiring is `useVexPresence.test.tsx`); this suite pins
 * what the key draws from it and what a press does:
 *
 *  - three cells in order: her portrait, the state, the chevron;
 *  - the state line: the square with the state's fill, the state machine's
 *    own word, and the live timer only while a turn runs;
 *  - the action line: Hide Vex or Show Vex, then the chord's keycaps in the
 *    platform's spelling, hidden from assistive technology;
 *  - one control named for what it does, expanded while she is open, its
 *    tooltip and `aria-keyshortcuts` carrying the chord (Appendix A.9);
 *  - the portrait: the fold glyph on the raised fill while open, the empty
 *    seam S4-03 fills while closed; the chevron up while open, down closed;
 *  - the words change at the press: while her close plays the key reads Show
 *    Vex and a press keeps her; a hide goes through her close;
 *  - the one announcer of the state word sits beside the key, not in it.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexPresence } from "../useVexPresence.js";
import { NO_BACKGROUND_WORK } from "../background-work.js";

const presence = vi.hoisted(() => ({ current: null as VexPresence | null }));

vi.mock("../useVexPresence.js", () => ({
  useVexPresence: () => {
    if (presence.current === null) throw new Error("presence not arranged");
    return presence.current;
  },
}));

const { VexKey } = await import("../VexKey.js");
const { registerVexCloser, setVexClosing } = await import("../vex-hide.js");

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function arrange(overrides: Partial<VexPresence> = {}): void {
  presence.current = {
    state: "ready",
    word: "Ready",
    fill: "idle",
    scope: "This chat:",
    timerStartedAt: null,
    live: false,
    narration: null,
    background: NO_BACKGROUND_WORK,
    needsYou: {
      status: "ready",
      unknownCopy: null,
      count: 0,
      items: [],
      retry: () => undefined,
      retrying: false,
    },
    ...overrides,
  };
}

function key(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-key']");
  if (el === null) throw new Error("the Vex key is missing");
  return el;
}

function part(name: string): HTMLElement | null {
  return key().querySelector<HTMLElement>(`.vex-key__${name}`);
}

beforeEach(() => {
  arrange();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVexClosing(false);
});

describe("VexKey: what it draws", () => {
  it("is one button in three cells: the portrait, the state, the chevron", () => {
    render(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
    expect(key().tagName).toBe("BUTTON");
    expect(Array.from(key().children).map((el) => el.className)).toEqual([
      "vex-key__portrait",
      "vex-key__state",
      "vex-key__chevron",
    ]);
  });

  it("says the state as its square and the state machine's own word", () => {
    arrange({ state: "awaiting", word: "Waiting for approval", fill: "awaiting" });
    render(<VexKey open onToggle={() => undefined} platform="win32" />);
    expect(key().getAttribute("data-vex-state")).toBe("awaiting");
    const status = part("status");
    expect(status?.textContent).toBe("Waiting for approval");
    const square = status?.querySelector(".vex-swatch");
    expect(square?.getAttribute("data-s")).toBe("awaiting");
    expect(square?.getAttribute("aria-hidden")).toBe("true");
    expect(part("timer")).toBeNull();
  });

  it("counts the live turn beside the word, in m:ss from its start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    arrange({ state: "thinking", word: "Thinking", fill: "thinking", timerStartedAt: NOW - 3_000, live: true });
    render(<VexKey open onToggle={() => undefined} platform="linux" />);
    expect(part("status")?.textContent).toBe("Thinking0:03");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(part("timer")?.textContent).toBe("0:04");
  });

  it("says the action and the chord's keycaps, in each platform's keys", () => {
    const { rerender } = render(<VexKey open onToggle={() => undefined} platform="win32" />);
    expect(part("name")?.textContent).toBe("Hide Vex");
    const caps = part("action")?.querySelector(".vex-keycaps");
    expect(caps?.textContent).toBe("CtrlShiftB");
    expect(caps?.getAttribute("aria-hidden")).toBe("true");
    rerender(<VexKey open={false} onToggle={() => undefined} platform="darwin" />);
    expect(part("name")?.textContent).toBe("Show Vex");
    expect(part("action")?.querySelector(".vex-keycaps")?.textContent).toBe("⇧⌘B");
  });

  it("folds: the fold glyph on the raised cell and the chevron up while open; the seam and the chevron down closed", () => {
    const { rerender } = render(<VexKey open onToggle={() => undefined} platform="linux" />);
    expect(part("portrait")?.hasAttribute("data-open")).toBe(true);
    expect(part("portrait")?.querySelector("svg")).not.toBeNull();
    expect(part("chevron")?.querySelector("path")?.getAttribute("d")).toBe("M4 10l4-4 4 4");
    rerender(<VexKey open={false} onToggle={() => undefined} platform="linux" />);
    expect(part("portrait")?.hasAttribute("data-open")).toBe(false);
    // Her face is S4-03's: until it lands the closed cell draws nothing.
    expect(part("portrait")?.childElementCount).toBe(0);
    expect(part("chevron")?.querySelector("path")?.getAttribute("d")).toBe("M4 6l4 4 4-4");
  });
});

describe("VexKey: the control", () => {
  it("is named for what a press does, expanded while she is open, with the chord", () => {
    const { rerender } = render(<VexKey open onToggle={() => undefined} platform="linux" />);
    const hide = screen.getByRole("button", { name: "Hide Vex" });
    expect(hide).toBe(key());
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    rerender(<VexKey open={false} onToggle={() => undefined} platform="darwin" />);
    const show = screen.getByRole("button", { name: "Show Vex" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(show.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+B");
  });

  it("is described by its state line, so the state is heard after the name", () => {
    arrange({ state: "done", word: "Done", fill: "done" });
    render(<VexKey open onToggle={() => undefined} platform="linux" />);
    const described = document.getElementById(key().getAttribute("aria-describedby") ?? "");
    expect(described).toBe(part("status"));
  });

  it("spells its tooltip as the contract does: the name, then the chord", () => {
    const { rerender } = render(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
    fireEvent.focus(key());
    expect(screen.getByText("Show Vex (Ctrl+Shift+B)")).not.toBeNull();
    rerender(<VexKey open onToggle={() => undefined} platform="darwin" />);
    fireEvent.focus(key());
    expect(screen.getByText("Hide Vex (⇧⌘B)")).not.toBeNull();
  });

  it("shows her at once on a press while she is closed", () => {
    const onToggle = vi.fn();
    render(<VexKey open={false} onToggle={onToggle} platform="linux" />);
    fireEvent.click(key());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("hides through her close, and the write waits for it", () => {
    const onToggle = vi.fn();
    const pending: (() => void)[] = [];
    const dispose = registerVexCloser({
      close: (commit) => {
        pending.push(commit);
        return true;
      },
      keep: () => undefined,
    });
    try {
      render(<VexKey open onToggle={onToggle} platform="linux" />);
      fireEvent.click(key());
      expect(onToggle).not.toHaveBeenCalled();
      pending[0]?.();
      expect(onToggle).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("reads Show Vex from the press while she closes, and a press then keeps her", () => {
    const onToggle = vi.fn();
    const keep = vi.fn();
    const dispose = registerVexCloser({ close: () => true, keep });
    try {
      render(<VexKey open onToggle={onToggle} platform="win32" />);
      act(() => {
        setVexClosing(true);
      });
      expect(key().getAttribute("aria-label")).toBe("Show Vex");
      expect(key().getAttribute("aria-expanded")).toBe("false");
      expect(part("name")?.textContent).toBe("Show Vex");
      fireEvent.click(key());
      expect(keep).toHaveBeenCalledTimes(1);
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe("VexKey: the one announcer of the state word", () => {
  it("sits beside the key, never inside it, so the key's name stays its action", () => {
    arrange({ state: "working", word: "Working", fill: "done" });
    render(<VexKey open onToggle={() => undefined} platform="linux" />);
    const announcer = document.querySelector("[data-vex-area='vex-state-announcer']");
    expect(announcer).not.toBeNull();
    expect(key().contains(announcer)).toBe(false);
    expect(key().querySelector("[role='status']")).toBeNull();
  });
});
