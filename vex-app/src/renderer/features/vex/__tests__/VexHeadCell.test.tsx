/**
 * D2's VEX cell (docs/design/H3-DESKTOP.md section 6.2): the header's cell
 * over Vex's column at the right edge, VEX in caps and a 44 square key with
 * the panel glyph that hides or shows her whole column. The presence is
 * mocked (its wiring is `useVexPresence.test.tsx`); this suite pins:
 *
 *  - the cell's words and its one key, H3's portrait, state line, keycaps
 *    and chevron gone;
 *  - one control named for what it does ("Hide Vex", "Show Vex"), naming
 *    her column in `aria-controls`, with no `aria-expanded` or
 *    `aria-pressed` (EC-01), its tooltip and `aria-keyshortcuts` carrying
 *    the chord, her state word as its description;
 *  - every press said once, politely, "Vex shown." or "Vex hidden." (EC-24),
 *    and the announcer of her state word beside the key;
 *  - under 1024, while her band rests, a press acts on nothing and says why.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

const { VexHeadCell, VEX_HEAD_WORD } = await import("../VexHeadCell.js");
const { VEX_SECTION_ID } = await import("../vex-section-a11y.js");
const { setVexClosing } = await import("../vex-hide.js");

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
    needsYou: { status: "ready", unknownCopy: null, count: 0, items: [], retry: () => undefined, retrying: false },
    ...overrides,
  };
}

function key(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-key']");
  if (el === null) throw new Error("the key is missing");
  return el;
}

/** What the polite announcer of her shown or hidden press holds now. */
function said(): string {
  return Array.from(document.querySelectorAll("[data-vex-area='vex-section-announcer'] [role='status']"))
    .map((el) => el.textContent ?? "")
    .join("");
}

beforeEach(() => {
  arrange();
});

afterEach(() => {
  cleanup();
  setVexClosing(false);
});

describe("the VEX cell", () => {
  it("says VEX and holds one 44 key with the panel glyph, and nothing of H3's Vex key", () => {
    render(<VexHeadCell open onToggle={() => undefined} />);
    const cell = document.querySelector<HTMLElement>("[data-vex-area='vex-head-cell']");
    expect(cell?.querySelector(".vex-head-vex__word")?.textContent).toBe(VEX_HEAD_WORD);
    expect(VEX_HEAD_WORD).toBe("Vex");
    expect(cell?.querySelectorAll("button")).toHaveLength(1);
    expect(key().classList.contains("vex-head-vex__key")).toBe(true);
    expect(key().querySelector("svg")).not.toBeNull();
    for (const part of ["portrait", "state", "chevron"]) {
      expect(cell?.querySelector(`.vex-key__${part}`), part).toBeNull();
    }
    expect(cell?.querySelector(".vex-keycaps")).toBeNull();
  });

  it("is named for what it does, controls her column, and carries the chord", () => {
    const view = render(<VexHeadCell open onToggle={() => undefined} />);
    expect(key().getAttribute("aria-label")).toBe("Hide Vex");
    expect(key().getAttribute("aria-controls")).toBe(VEX_SECTION_ID);
    expect(key().hasAttribute("aria-expanded")).toBe(false);
    expect(key().hasAttribute("aria-pressed")).toBe(false);
    expect(key().getAttribute("aria-keyshortcuts")).toMatch(/Shift\+B$/);
    view.rerender(<VexHeadCell open={false} onToggle={() => undefined} />);
    expect(key().getAttribute("aria-label")).toBe("Show Vex");
    expect(key().getAttribute("data-vex-key-open")).toBe("false");
  });

  it("is described by her state word, which her column's state row shows", () => {
    arrange({ state: "thinking", word: "Thinking", live: true });
    render(<VexHeadCell open onToggle={() => undefined} />);
    const ids = (key().getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0] ?? "")?.textContent).toBe("Thinking");
  });

  it("presses the frame's toggle and says the press once, politely", () => {
    const onToggle = vi.fn();
    const view = render(<VexHeadCell open onToggle={onToggle} />);
    act(() => {
      fireEvent.click(key());
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(said()).toBe("Vex hidden.");
    view.rerender(<VexHeadCell open={false} onToggle={onToggle} />);
    act(() => {
      fireEvent.click(key());
    });
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(said()).toBe("Vex shown.");
  });

  it("keeps the announcer of her state word beside the key, never in it", () => {
    render(<VexHeadCell open onToggle={() => undefined} />);
    expect(key().querySelector("[role='status']")).toBeNull();
    expect(document.querySelector("[data-vex-area='vex-head-cell'] [role='status']")).not.toBeNull();
  });

  it("under 1024, while her band rests, acts on nothing and says why", () => {
    const onToggle = vi.fn();
    const reason = "Vex shows her section after this turn.";
    render(<VexHeadCell open={false} onToggle={onToggle} held={reason} />);
    expect(key().getAttribute("aria-disabled")).toBe("true");
    const ids = (key().getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(["Ready", reason]);
    act(() => {
      fireEvent.click(key());
    });
    expect(onToggle).not.toHaveBeenCalled();
    expect(said()).toBe(reason);
  });
});
