/**
 * The token chip in the title bar (docs/design/R3-MINIMAL.md sections 2.4 and
 * 3): the open chat's state as a fill and a word, and the Vex toggle. The
 * presence is mocked here (its wiring is `useVexPresence.test.tsx`); this suite
 * pins what the chip draws from it and what a press does.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexPresence } from "../useVexPresence.js";
import { NO_BACKGROUND_WORK, backgroundWorkOf } from "../background-work.js";
import { session } from "./fixtures.js";

const presence = vi.hoisted(() => ({ current: null as VexPresence | null }));

vi.mock("../useVexPresence.js", () => ({
  useVexPresence: () => {
    if (presence.current === null) throw new Error("presence not arranged");
    return presence.current;
  },
}));

const { VexTokenChip, vexToggleLabel } = await import("../VexTokenChip.js");

function arrange(overrides: Partial<VexPresence> = {}): void {
  presence.current = {
    state: "ready",
    word: "Ready",
    fill: "idle",
    scope: "This chat:",
    timerStartedAt: null,
    narration: null,
    background: NO_BACKGROUND_WORK,
    needsYou: {
      status: "ready",
      count: 0,
      items: [],
      retry: () => undefined,
      retrying: false,
    },
    ...overrides,
  };
}

function chip(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-token-chip']");
  if (el === null) throw new Error("chip missing");
  return el;
}

const ONE_RUNNING = backgroundWorkOf(
  [session({ title: "Weekly rebalance", missionStatus: "running" })],
  null,
);

beforeEach(() => {
  arrange();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("VexTokenChip: the state", () => {
  it("draws the flat token, the fill and the word, without the scope (as the core renders)", () => {
    arrange({ state: "working", word: "Working", fill: "done" });
    render(<VexTokenChip open onToggle={() => undefined} />);
    const el = chip();
    expect(el.querySelector("[data-vex-vx-token]")).not.toBeNull();
    expect(el.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("done");
    expect(el.querySelector(".vex-state-word__scope")).toBeNull();
    expect(el.textContent).not.toContain("This chat:");
    expect(el.textContent).toContain("Working");
    expect(el.getAttribute("data-vex-state")).toBe("working");
  });

  it("draws the word alone where the presence has no scope either (the welcome)", () => {
    arrange({ scope: null });
    render(<VexTokenChip open={false} onToggle={() => undefined} />);
    expect(chip().querySelector(".vex-state-word__scope")).toBeNull();
    expect(chip().textContent).toContain("Ready");
  });

  it("counts the live turn's real elapsed time, and shows no timer at rest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:02.000Z"));
    arrange({
      state: "working",
      word: "Working",
      fill: "done",
      timerStartedAt: Date.parse("2026-10-17T12:00:00.000Z"),
    });
    render(<VexTokenChip open onToggle={() => undefined} />);
    const timer = (): string | null | undefined =>
      chip().querySelector(".vex-state-word__timer")?.textContent;
    expect(timer()).toBe("0:02");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(timer()).toBe("0:05");
    cleanup();

    arrange();
    render(<VexTokenChip open onToggle={() => undefined} />);
    expect(chip().querySelector(".vex-state-word__timer")).toBeNull();
  });

  it("keeps the fill and the word while Vex is hidden", () => {
    arrange({ state: "awaiting", word: "Waiting for approval", fill: "awaiting" });
    render(<VexTokenChip open={false} onToggle={() => undefined} />);
    expect(chip().querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("awaiting");
    expect(chip().textContent).toContain("Waiting for approval");
  });
});

describe("VexTokenChip: background work", () => {
  it("names the running missions after a rule while Vex is hidden", () => {
    arrange({ background: ONE_RUNNING });
    render(<VexTokenChip open={false} onToggle={() => undefined} />);
    const tail = chip().querySelector("[data-vex-chip-background]");
    expect(tail?.textContent).toBe("1 mission running");
    expect(tail?.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("done");
  });

  it("leaves that line to the open sidebar", () => {
    arrange({ background: ONE_RUNNING });
    render(<VexTokenChip open onToggle={() => undefined} />);
    expect(chip().querySelector("[data-vex-chip-background]")).toBeNull();
  });

  it("says nothing about background work when none runs", () => {
    render(<VexTokenChip open={false} onToggle={() => undefined} />);
    expect(chip().querySelector("[data-vex-chip-background]")).toBeNull();
  });
});

describe("VexTokenChip: the toggle", () => {
  it("is pressed while Vex is open, and its tooltip says what a press does", () => {
    expect(vexToggleLabel(true)).toBe("Hide Vex");
    expect(vexToggleLabel(false)).toBe("Show Vex");
    const { rerender } = render(<VexTokenChip open onToggle={() => undefined} />);
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    fireEvent.focus(chip());
    expect(screen.getByText("Hide Vex")).not.toBeNull();
    rerender(<VexTokenChip open={false} onToggle={() => undefined} />);
    expect(chip().getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles on a press, and its name carries the visible state", () => {
    const onToggle = vi.fn();
    arrange({ state: "working", word: "Working", fill: "done" });
    render(<VexTokenChip open onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: /^Vex,\s*Working$/ });
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
