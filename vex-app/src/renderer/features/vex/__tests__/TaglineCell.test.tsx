/**
 * The tagline cell (docs/design/H3-DESKTOP.md section 1.8 and Appendix A.6):
 * Vex's line on her column's foot, VEX Cloud's `.moment`. Pins:
 *   - at rest, desktop's line: "An AI trading agent, on your computer."
 *     (never H3's "inside your limits": desktop has no spend limits);
 *   - a card waiting in the open chat: "Check the card, then decide.";
 *   - Studio's own line in Studio, whatever Vex's state;
 *   - a card's moment is read from the real state: the open chat, no page
 *     over it, Vex waiting for approval; never the welcome, a page or Studio;
 *   - while Vex works, her narration in the say register, or the state word
 *     where the narration has nothing true to add;
 *   - a settled turn says "Done." (never a fill, never "approved by you") for
 *     3.4 s, then the line empties until the moment changes;
 *   - the second clause is its own span (the muted half), words are written
 *     in sentence case, and the line is hidden from assistive tech;
 *   - the sheet: the strip without a blur, the caps register at
 *     clamp(14px, 1.1vw, 22px), 600, 0.01em, 1.15, the say register in ink 2.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexState } from "../vex-state.js";

const presence = vi.hoisted(() => ({
  state: "ready" as VexState,
  word: "Ready",
  narration: null as string | null,
}));
vi.mock("../useVexPresence.js", () => ({
  useVexPresence: () => ({ ...presence }),
}));

const { SETTLED_HOLD_MS, TAGLINES, TaglineCell, taglineMomentOf, vexLineOf } = await import(
  "../TaglineCell.js"
);
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

function line(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".vex-tagline");
  if (el === null) throw new Error("the tagline is missing");
  return el;
}

function arrange(state: VexState, word: string, narration: string | null = null): void {
  presence.state = state;
  presence.word = word;
  presence.narration = narration;
}

beforeEach(() => {
  arrange("ready", "Ready");
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: SESSION, shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("taglineMomentOf", () => {
  const chat = { runtimeMode: "agent", activeSessionId: SESSION, pageOpen: false } as const;

  it("is a card's moment only while the open chat waits for approval", () => {
    expect(taglineMomentOf({ ...chat, state: "awaiting" })).toBe("card");
    for (const state of ["ready", "thinking", "working", "done", "error", "listening"] as const) {
      expect(taglineMomentOf({ ...chat, state }), state).toBe("rest");
    }
  });

  it("is never a card's moment on the welcome, under a page or in Studio", () => {
    expect(taglineMomentOf({ ...chat, activeSessionId: null, state: "awaiting" })).toBe("rest");
    expect(taglineMomentOf({ ...chat, pageOpen: true, state: "awaiting" })).toBe("rest");
    // Studio has its own line, never the card's (our approved Studio plate).
    expect(taglineMomentOf({ ...chat, runtimeMode: "studio", state: "awaiting" })).toBe("studio");
  });

  it("says Studio's line in Studio, whatever Vex's state", () => {
    for (const state of ["ready", "thinking", "awaiting"] as const) {
      expect(taglineMomentOf({ ...chat, runtimeMode: "studio", activeSessionId: null, state })).toBe("studio");
    }
    expect(`${TAGLINES.studio.lead} ${TAGLINES.studio.rest}`).toBe("Coding agents, on your computer.");
  });
});

describe("vexLineOf", () => {
  const chat = {
    runtimeMode: "agent",
    activeSessionId: SESSION,
    pageOpen: false,
    word: "Ready",
    narration: null,
    settled: null,
  } as const;

  it("narrates while Vex works, in the say register, from her narration or her state word", () => {
    expect(
      vexLineOf({ ...chat, state: "working", word: "Working", narration: "Running Swap to answer “Swap it.”" }),
    ).toEqual({ kind: "working", reg: "say", text: "Running Swap to answer “Swap it.”" });
    expect(vexLineOf({ ...chat, state: "thinking", word: "Thinking" })).toEqual({
      kind: "working",
      reg: "say",
      text: "Thinking",
    });
    // Studio keeps its own line while a project's agents work.
    expect(vexLineOf({ ...chat, runtimeMode: "studio", state: "working", word: "Working" }).kind).toBe(
      "studio",
    );
  });

  it("says only the state word at a settled moment: Done., never a fill or an approval", () => {
    const settled = vexLineOf({ ...chat, state: "done", word: "Done", settled: "settled" });
    expect(settled).toEqual({ kind: "settled", reg: "caps", lead: "Done.", rest: "", empty: false });
    const quiet = vexLineOf({ ...chat, state: "ready", settled: "quiet" });
    expect(quiet).toMatchObject({ kind: "settled", empty: true });
    const words = settled.reg === "caps" ? `${settled.lead} ${settled.rest}` : "";
    expect(words).not.toMatch(/fill|approved|placed/i);
  });

  it("keeps the rest line at rest and the card's line while one waits", () => {
    expect(vexLineOf({ ...chat, state: "ready" })).toMatchObject({ kind: "rest", empty: false });
    expect(vexLineOf({ ...chat, state: "error", word: "Error" })).toMatchObject({ kind: "rest" });
    expect(vexLineOf({ ...chat, state: "awaiting", word: "Waiting for approval" })).toMatchObject({
      kind: "card",
      lead: "Check the card,",
    });
  });
});

describe("TaglineCell", () => {
  it("says desktop's line at rest, its second clause apart, hidden from assistive tech", () => {
    render(<TaglineCell />);
    expect(line().textContent).toBe("An AI trading agent, on your computer.");
    expect(line().getAttribute("data-vex-tagline")).toBe("rest");
    expect(line().getAttribute("data-reg")).toBe("caps");
    expect(line().getAttribute("aria-hidden")).toBe("true");
    expect(line().querySelector(".vex-tagline__rest")?.textContent).toBe("on your computer.");
    expect(line().textContent).not.toContain("limits");
  });

  it("says check the card while one waits in the open chat", () => {
    arrange("awaiting", "Waiting for approval");
    render(<TaglineCell />);
    expect(line().textContent).toBe("Check the card, then decide.");
    expect(line().getAttribute("data-vex-tagline")).toBe("card");
    expect(line().querySelector(".vex-tagline__lead")?.textContent).toBe(TAGLINES.card.lead);
  });

  it("goes back to the first line when a page covers the chat", () => {
    arrange("awaiting", "Waiting for approval");
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    render(<TaglineCell />);
    expect(line().textContent).toBe("An AI trading agent, on your computer.");
  });

  it("narrates a turn, holds Done. for 3.4 s when it settles, then empties until the moment changes", () => {
    vi.useFakeTimers();
    arrange("working", "Working", "Writing to answer “What is in my wallet?”");
    const view = render(<TaglineCell />);
    expect(line().getAttribute("data-reg")).toBe("say");
    expect(line().textContent).toBe("Writing to answer “What is in my wallet?”");
    arrange("done", "Done");
    view.rerender(<TaglineCell />);
    expect(line().getAttribute("data-vex-tagline")).toBe("settled");
    expect(line().textContent).toBe("Done.");
    expect(line().hasAttribute("data-empty")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(SETTLED_HOLD_MS - 1);
    });
    expect(line().hasAttribute("data-empty")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(line().hasAttribute("data-empty")).toBe(true);
    // Done gives way to Ready: the line stays empty, the bars alone.
    arrange("ready", "Ready");
    view.rerender(<TaglineCell />);
    expect(line().hasAttribute("data-empty")).toBe(true);
    // A new turn is a new moment.
    arrange("thinking", "Thinking");
    view.rerender(<TaglineCell />);
    expect(line().getAttribute("data-reg")).toBe("say");
    expect(line().textContent).toBe("Thinking");
    arrange("ready", "Ready");
    view.rerender(<TaglineCell />);
    expect(line().getAttribute("data-vex-tagline")).toBe("rest");
  });

  it("forgets a settled moment in another chat", () => {
    vi.useFakeTimers();
    arrange("working", "Working");
    const view = render(<TaglineCell />);
    arrange("done", "Done");
    view.rerender(<TaglineCell />);
    expect(line().getAttribute("data-vex-tagline")).toBe("settled");
    act(() => {
      useUiStore.setState({ activeSessionId: OTHER });
    });
    arrange("ready", "Ready");
    view.rerender(<TaglineCell />);
    expect(line().getAttribute("data-vex-tagline")).toBe("rest");
    expect(line().hasAttribute("data-empty")).toBe(false);
  });
});

describe("the tagline's sheet", () => {
  // Read as TEXT: jsdom has no cascade for an imported sheet.
  const sheet = readFileSync(
    join(process.cwd(), "src/renderer/styles/global-css/vex-sidebar.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(sheet);
    expect(match, `selector not found: ${selector}`).not.toBeNull();
    return match?.[1] ?? "";
  }

  it("lays the strip over the cell, with no blur", () => {
    const strip = rule(".vex-tagline");
    expect(strip).toMatch(/background:\s*var\(--vex-alias-strip\);/);
    expect(strip).toMatch(/inset:\s*0;/);
    expect(strip).not.toMatch(/backdrop-filter|blur/);
    expect(rule(".vex-tagline[data-empty]")).toMatch(/opacity:\s*0;/);
  });

  it("sets the caps register at Cloud's size, weight, tracking and leading", () => {
    const caps = rule('.vex-tagline[data-reg="caps"] .vex-tagline__text');
    expect(caps).toMatch(/font-size:\s*clamp\(14px, 1\.1vw, 22px\);/);
    expect(caps).toMatch(/font-weight:\s*600;/);
    expect(caps).toMatch(/letter-spacing:\s*0\.01em;/);
    expect(caps).toMatch(/line-height:\s*1\.15;/);
    expect(caps).toMatch(/text-transform:\s*uppercase;/);
  });

  it("sets the narration in sentence case, 14 times the zoom, in ink 2", () => {
    const say = rule('.vex-tagline[data-reg="say"] .vex-tagline__text');
    expect(say).toMatch(/font-size:\s*calc\(14px \* var\(--vex-zoom\)\);/);
    expect(say).toMatch(/color:\s*var\(--vex-alias-label-secondary\);/);
    expect(say).not.toMatch(/text-transform/);
  });
});
