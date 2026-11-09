/**
 * The Vex key (docs/design/H3-DESKTOP.md sections 1.3, 1.6 and 3.3): the
 * header's cell over the Vex column, one control in three cells. The presence
 * is mocked here (its wiring is `useVexPresence.test.tsx`); this suite pins
 * what the key draws from it and what a press does:
 *
 *  - three cells in order: her portrait, the state, the chevron;
 *  - the state line: H3's key square (a drawing per state, the running one
 *    blinking),
 *    the state machine's own word, and the live timer only while a turn runs;
 *  - the action line: Hide Vex or Show Vex, then the chord's keycaps in the
 *    platform's spelling, hidden from assistive technology;
 *  - VEX Cloud's measures and width rules in its sheet: no keycaps under
 *    1440, the chat row's short word under 1280 ("Waiting"), 14 from 1920;
 *  - one control named for what it does, controlling her section, with no
 *    `aria-expanded` or `aria-pressed` (EC-01), its tooltip and
 *    `aria-keyshortcuts` carrying the chord (Appendix A.9); every press said
 *    once, politely, "Vex shown." or "Vex hidden." (EC-24);
 *  - the portrait: her portrait key (S4-03, faceless until her art) and the
 *    portrait glyph stand together and crossfade, the glyph on the open
 *    ground while open; the chevron up while open, down closed;
 *  - the words change at the press: while her close plays the key reads Show
 *    Vex and a press keeps her; a hide goes through her close;
 *  - the one announcer of the state word sits beside the key, not in it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const { VexKey, VexKeyView } = await import("../VexKey.js");
const { VEX_SECTION_ID, VEX_STAGE_SECTION_ID } = await import("../vex-section-a11y.js");
const { VEX_STATES, VEX_STATE_WORD } = await import("../vex-state.js");
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
    expect(part("long")?.textContent).toBe("Waiting for approval");
    const square = status?.querySelector(".vex-key__square");
    // Waiting is the target, as Cloud's MOOD_STATE draws it (section 2.2),
    // apart from Done with the colour taken away.
    expect(square?.getAttribute("data-state")).toBe("warning");
    expect(square?.getAttribute("aria-hidden")).toBe("true");
    expect(part("timer")).toBeNull();
  });

  it("carries the chat row's short word for the narrow window, a picture of the long one", () => {
    // Under 1280 the sheet shows `.vex-key__short` for `.vex-key__long`
    // (VEX Cloud's `.vk-short`): "Waiting", the chat row's word.
    arrange({ state: "awaiting", word: "Waiting for approval", fill: "awaiting" });
    const { rerender } = render(<VexKey open onToggle={() => undefined} platform="win32" />);
    expect(part("word")?.hasAttribute("data-short")).toBe(true);
    expect(part("short")?.textContent).toBe("Waiting");
    expect(part("short")?.getAttribute("aria-hidden")).toBe("true");
    // Every other word is already short: no second word to swap in.
    arrange({ state: "thinking", word: "Thinking", fill: "thinking" });
    rerender(<VexKey open onToggle={() => undefined} platform="win32" />);
    expect(part("word")?.hasAttribute("data-short")).toBe(false);
    expect(part("short")).toBeNull();
    expect(part("word")?.textContent).toBe("Thinking");
  });

  it("draws the state square as an outline at Ready", () => {
    render(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
    expect(part("status")?.textContent).toBe("Ready");
    expect(part("status")?.querySelector(".vex-key__square")?.getAttribute("data-state")).toBe("idle");
  });

  it("gives each state Cloud's square: running blinks, waiting the target, done the empty frame", () => {
    // VEX Cloud's MOOD_STATE (components/vex/vex-mood.ts): Done is a settled
    // turn whatever its outcome, never a solid fill; Waiting is the target.
    const { rerender } = render(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
    const drawn = VEX_STATES.map((state) => {
      arrange({ state, word: VEX_STATE_WORD[state] });
      rerender(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
      return [state, part("status")?.querySelector(".vex-key__square")?.getAttribute("data-state")];
    });
    expect(drawn).toEqual([
      ["ready", "idle"],
      ["listening", "idle"],
      ["thinking", "ongoing"],
      ["working", "ongoing"],
      ["awaiting", "warning"],
      ["done", "idle"],
      ["concerned", "concerned"],
      ["error", "error"],
      ["sleeping", "paused"],
      ["waking", "ongoing"],
    ]);
  });

  it("carries the waiting count under the same target square", () => {
    arrange({
      needsYou: {
        status: "ready",
        unknownCopy: null,
        count: 2,
        items: [],
        retry: () => undefined,
        retrying: false,
      },
    });
    render(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
    const count = part("count");
    expect(count?.textContent).toBe("2");
    expect(count?.querySelector(".vex-key__square")?.getAttribute("data-state")).toBe("warning");
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

  it("holds her face and the portrait glyph together, the cell saying which shows; the chevron up open, down closed", () => {
    const { rerender } = render(<VexKey open onToggle={() => undefined} platform="linux" />);
    expect(part("portrait")?.hasAttribute("data-open")).toBe(true);
    // The portrait glyph (Cloud's DG-1 `portrait`): a framed bust on the
    // filled 24 grid, hidden from assistive technology.
    const glyph = part("pic");
    expect(glyph?.tagName.toLowerCase()).toBe("svg");
    expect(glyph?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    // Her face stays in the cell while she is open, so the two crossfade.
    expect(part("chip")?.getAttribute("data-kimm-key")).toBe("closed");
    expect(part("chevron")?.querySelector("path")?.getAttribute("d")).toBe("M4 10l4-4 4 4");
    rerender(<VexKey open={false} onToggle={() => undefined} platform="linux" />);
    expect(part("portrait")?.hasAttribute("data-open")).toBe(false);
    expect(part("pic")).not.toBeNull();
    // Her face is her portrait key's (S4-03): her mood's chip, VEX Cloud's
    // header portrait, as the app ships it.
    const face = part("portrait")?.querySelector("[data-vex-area='kimm-portrait-key']");
    expect(face).toBe(part("chip"));
    expect(face?.getAttribute("data-kimm-key")).toBe("closed");
    expect(face?.getAttribute("data-kimm-art")).toBe("ready");
    expect(face?.querySelector("img")?.getAttribute("src")).toMatch(/^\/art\/kimm\/chip-[a-z]+\.webp$/);
    expect(part("chevron")?.querySelector("path")?.getAttribute("d")).toBe("M4 6l4 4 4-4");
  });
});

describe("VexKey: the control", () => {
  it("is a disclosure named by its words, controlling her section, with no state attribute (EC-01)", () => {
    const { rerender } = render(<VexKey open onToggle={() => undefined} platform="linux" />);
    const hide = screen.getByRole("button", { name: "Hide Vex" });
    expect(hide).toBe(key());
    expect(hide.getAttribute("aria-controls")).toBe(VEX_SECTION_ID);
    expect(hide.hasAttribute("aria-expanded")).toBe(false);
    expect(hide.hasAttribute("aria-pressed")).toBe(false);
    expect(hide.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    rerender(<VexKey open={false} onToggle={() => undefined} platform="darwin" />);
    const show = screen.getByRole("button", { name: "Show Vex" });
    expect(show.getAttribute("aria-controls")).toBe(VEX_SECTION_ID);
    expect(show.hasAttribute("aria-expanded")).toBe(false);
    expect(show.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+B");
  });

  it("is described by its state line, so the state is heard after the name", () => {
    arrange({ state: "done", word: "Done", fill: "done" });
    render(<VexKey open onToggle={() => undefined} platform="linux" />);
    const described = document.getElementById(key().getAttribute("aria-describedby") ?? "");
    expect(described).toBe(part("status"));
  });

  it("keeps the ticking timer out of its description, as a picture of the live turn", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    arrange({ state: "thinking", word: "Thinking", fill: "thinking", timerStartedAt: NOW - 3_000, live: true });
    render(<VexKey open onToggle={() => undefined} platform="linux" />);
    expect(part("timer")?.textContent).toBe("0:03");
    expect(part("timer")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says every press once, politely: Vex shown. or Vex hidden. (EC-24)", () => {
    const { rerender } = render(<VexKey open={false} onToggle={() => undefined} platform="linux" />);
    const announcer = document.querySelector("[data-vex-area='vex-section-announcer']");
    expect(announcer).not.toBeNull();
    expect(key().contains(announcer)).toBe(false);
    const regions = Array.from(announcer?.querySelectorAll("[role='status']") ?? []);
    expect(regions.map((r) => r.getAttribute("aria-live"))).toEqual(["polite", "polite"]);
    const said = (): string => regions.map((r) => r.textContent).join("");
    expect(said()).toBe("");
    fireEvent.click(key());
    expect(said()).toBe("Vex shown.");
    rerender(<VexKey open onToggle={() => undefined} platform="linux" />);
    fireEvent.click(key());
    expect(said()).toBe("Vex hidden.");
    rerender(<VexKey open={false} onToggle={() => undefined} platform="linux" />);
    fireEvent.click(key());
    // The same words again land in the other half, so they are heard again.
    expect(said()).toBe("Vex shown.");
  });

  it("names the stage's own section where the stage hands it in", () => {
    render(
      <VexKeyView
        open
        onToggle={() => undefined}
        platform="linux"
        state="ready"
        word="Ready"
        controls={VEX_STAGE_SECTION_ID}
      />,
    );
    expect(key().getAttribute("aria-controls")).toBe(VEX_STAGE_SECTION_ID);
  });

  it("spells its tooltip as the contract does: the name, then the chord", () => {
    const { rerender } = render(<VexKey open={false} onToggle={() => undefined} platform="win32" />);
    fireEvent.focus(key());
    expect(screen.getByText("Show Vex (Ctrl+Shift+B)")).not.toBeNull();
    rerender(<VexKey open onToggle={() => undefined} platform="darwin" />);
    fireEvent.focus(key());
    expect(screen.getByText("Hide Vex (⇧⌘B)")).not.toBeNull();
  });

  it("while her band rests, adds the reason to its description and says it on a press, acting on nothing", () => {
    const onToggle = vi.fn();
    const reason = "Vex shows her section after this turn.";
    render(<VexKey open={false} onToggle={onToggle} platform="linux" held={reason} />);
    expect(key().getAttribute("aria-disabled")).toBe("true");
    expect(key().hasAttribute("data-vex-key-held")).toBe(true);
    const described = (key().getAttribute("aria-describedby") ?? "").split(" ");
    expect(described.map((id) => document.getElementById(id))).toEqual([
      part("status"),
      expect.objectContaining({ textContent: reason }),
    ]);
    const regions = Array.from(
      document.querySelectorAll("[data-vex-area='vex-section-announcer'] [role='status']"),
    );
    fireEvent.click(key());
    expect(onToggle).not.toHaveBeenCalled();
    expect(regions.map((r) => r.textContent).join("")).toBe(reason);
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

describe("VexKey: its sheet, at Cloud's measures and widths", () => {
  // Read as TEXT: jsdom has no cascade for an imported sheet, so a computed
  // style would report the initial value and pass vacuously.
  const sheet = readFileSync(
    join(process.cwd(), "src/renderer/styles/global-css/title-bar.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** The body of the first `@media (query)` block. */
  function media(query: string): string {
    const at = sheet.indexOf(`@media (${query}) {`);
    expect(at, `no @media (${query})`).toBeGreaterThan(-1);
    const open = sheet.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < sheet.length; end += 1) {
      if (sheet[end] === "{") depth += 1;
      if (sheet[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return sheet.slice(open + 1, end);
  }

  /** One rule's declarations by its exact selector, the whole selector of its line. */
  function rule(selector: string, css = sheet): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{([^}]*)\\}`).exec(css);
    expect(match, `selector not found: ${selector}`).not.toBeNull();
    return match?.[1] ?? "";
  }

  it("sets the words 13 and 12, the lines 10 apart, the text 20 in and 12 from the right", () => {
    expect(rule(".vex-key__status")).toMatch(/font-size:\s*13px;/);
    expect(rule(".vex-key__action")).toMatch(/font-size:\s*12px;/);
    const cell = rule(".vex-key__state");
    expect(cell).toMatch(/gap:\s*10px;/);
    expect(cell).toMatch(/padding:\s*0 12px 0 20px;/);
    expect(rule(".vex-key__chevron")).toMatch(/width:\s*60px;/);
    const timer = rule(".vex-key .vex-key__timer");
    expect(timer).toMatch(/font-family:\s*var\(--font-sans\);/);
    expect(timer).toMatch(/letter-spacing:\s*0\.04em;/);
    expect(timer).toMatch(/color:\s*var\(--vex-alias-label-tertiary\);/);
  });

  it("drops the keycaps under 1440, at 12 and 0.06em, 16 in, with a 48 chevron cell", () => {
    const narrow = media("max-width: 1439px");
    expect(rule(".vex-key .vex-keycaps", narrow)).toMatch(/display:\s*none;/);
    expect(rule(".vex-key__state", narrow)).toMatch(/padding-left:\s*16px;/);
    expect(rule(".vex-key__status", narrow)).toMatch(/font-size:\s*12px;/);
    expect(rule(".vex-key__word", narrow)).toMatch(/letter-spacing:\s*0\.06em;/);
    expect(rule(".vex-key__chevron", narrow)).toMatch(/width:\s*48px;/);
  });

  it("crossfades her face and the portrait glyph over 200ms on the open ground, at once when still", () => {
    expect(rule(".vex-key__portrait[data-open]")).toMatch(/background:\s*var\(--vex-alias-cell-open\);/);
    expect(rule(".vex-key__portrait > .vex-key__chip")).toMatch(/transition:\s*opacity 200ms/);
    expect(rule(".vex-key__portrait[data-open] > .vex-key__chip")).toMatch(/opacity:\s*0;/);
    expect(rule(".vex-key__pic")).toMatch(/opacity:\s*0;/);
    expect(rule(".vex-key__portrait[data-open] > .vex-key__pic")).toMatch(/opacity:\s*1;/);
    expect(rule(".vex-key__portrait")).toMatch(/color:\s*var\(--vex-alias-label-secondary\);/);
    expect(sheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.vex-key__portrait,\s*\.vex-key__portrait > \* \{\s*transition: none;/,
    );
    expect(rule("html[data-still] :is(.vex-key__portrait, .vex-key__portrait > *)")).toMatch(
      /transition:\s*none;/,
    );
  });

  it("drops the action words and the chevron while held, keeping her face and state", () => {
    expect(rule(".vex-key[data-vex-key-held] :is(.vex-key__action, .vex-key__chevron > svg)")).toMatch(
      /visibility:\s*hidden;/,
    );
  });

  it("says the short word under 1280 and sets the state at 14 from 1920", () => {
    const short = media("max-width: 1279px");
    expect(rule(".vex-key__word[data-short] > .vex-key__long", short)).toMatch(/display:\s*none;/);
    expect(rule(".vex-key__word[data-short] > .vex-key__short", short)).toMatch(/display:\s*inline;/);
    expect(rule(".vex-key__status", media("min-width: 1920px"))).toMatch(/font-size:\s*14px;/);
  });
});
