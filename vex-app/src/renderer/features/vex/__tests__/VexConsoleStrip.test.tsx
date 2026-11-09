/**
 * The console line under 1024 (docs/design/H3-DESKTOP.md section 1.10; VEX
 * Cloud's `console-line.tsx`). The presence is mocked (its wiring is
 * `useVexPresence.test.tsx`); this suite pins what the line's first cell, her
 * state key, draws and says:
 *
 *  - her state as the square every place that says it draws
 *    (`VEX_STATE_SQUARE`, Cloud's `MOOD_STATE`): never the solid green of
 *    Confirmed for a state that is running, failed or waiting;
 *  - a disclosure of her band named by its words, controlling her section,
 *    described by the state word and, while the band rests, the reason;
 *  - every press said once, politely, "Vex shown." or "Vex hidden." (EC-24),
 *    and nothing said or done while it rests;
 *  - with the decision given way and no header control (section 4.8), the
 *    Needs you head is the Review key to the decision that leads, with the
 *    same count; at zero it is words, not a key.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexPresence } from "../useVexPresence.js";
import { NO_BACKGROUND_WORK } from "../background-work.js";

const presence = vi.hoisted(() => ({ current: null as VexPresence | null }));
const opened = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock("../useVexPresence.js", () => ({
  useVexPresence: () => {
    if (presence.current === null) throw new Error("presence not arranged");
    return presence.current;
  },
  useAllMissions: () => null,
}));
vi.mock("../needs-you-open.js", () => ({
  openNeedsYouItem: (item: unknown) => {
    opened.items.push(item);
  },
  needsYouItemIsHere: () => false,
}));
vi.mock("../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: () => ({ isLoading: true, isError: false, data: undefined }),
}));
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: () => ({ isLoading: false, data: undefined }),
}));
vi.mock("../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: () => ({ data: undefined }),
}));
vi.mock("../../../lib/api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({ data: undefined }),
  useSessionsList: () => ({ data: undefined, isError: false }),
}));

const { VexConsoleStrip } = await import("../VexConsoleStrip.js");
const { VEX_STATES, VEX_STATE_WORD, VEX_STATE_SQUARE } = await import("../vex-state.js");
const { VEX_SECTION_ID } = await import("../vex-section-a11y.js");
const { VexSectionAnnouncer } = await import("../VexSectionAnnouncer.js");
const { approvalNeedsYouItem } = await import("../needs-you.js");
const { approval } = await import("./fixtures.js");

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

function lineKey(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-console-line-key']");
  if (el === null) throw new Error("the console line's key is missing");
  return el;
}

function said(): string {
  const region = document.querySelector("[data-vex-area='vex-section-announcer']");
  return region?.textContent ?? "";
}

beforeEach(() => {
  arrange();
  opened.items = [];
});

afterEach(() => {
  cleanup();
});

describe("VexConsoleStrip: the console line's state key", () => {
  it("maps every state to the square the Vex key draws, never Confirmed's solid green", () => {
    // Cloud's MOOD_STATE: a running turn blinks, waiting is the target, a
    // failure the cross, Done the empty frame (section 2.2).
    expect(VEX_STATES.map((state) => [state, VEX_STATE_SQUARE[state]])).toEqual([
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
    const band = { open: false, held: null, onToggle: () => undefined };
    const { rerender } = render(<VexConsoleStrip band={band} />);
    for (const state of VEX_STATES) {
      arrange({ state, word: VEX_STATE_WORD[state] });
      rerender(<VexConsoleStrip band={band} />);
      const square = lineKey().querySelector(".vex-sq");
      expect(square?.getAttribute("data-state")).toBe(VEX_STATE_SQUARE[state]);
      expect(square?.getAttribute("data-state")).not.toBe("done");
    }
  });

  it("is a disclosure of her section named by its words and described by the state word", () => {
    arrange({ state: "thinking", word: "Thinking", timerStartedAt: Date.now() });
    render(<VexConsoleStrip band={{ open: false, held: null, onToggle: () => undefined }} />);
    const key = lineKey();
    expect(key.getAttribute("aria-label")).toBe("Show Vex");
    expect(key.getAttribute("aria-controls")).toBe(VEX_SECTION_ID);
    expect(key.hasAttribute("aria-expanded")).toBe(false);
    const described = (key.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual(["Thinking"]);
    // The ticking timer is a picture, never read.
    expect(key.querySelector(".vex-strip__timer")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says every press once, politely: Vex shown. or Vex hidden. (EC-24)", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <>
        <VexConsoleStrip band={{ open: false, held: null, onToggle }} />
        <VexSectionAnnouncer />
      </>,
    );
    act(() => {
      fireEvent.click(lineKey());
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(said()).toBe("Vex shown.");
    rerender(
      <>
        <VexConsoleStrip band={{ open: true, held: null, onToggle }} />
        <VexSectionAnnouncer />
      </>,
    );
    expect(lineKey().getAttribute("aria-label")).toBe("Hide Vex");
    act(() => {
      fireEvent.click(lineKey());
    });
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(said()).toBe("Vex hidden.");
  });

  it("while the band rests, adds the reason to its description and says it, acting on nothing", () => {
    const onToggle = vi.fn();
    const reason = "Vex shows her section after this turn.";
    render(
      <>
        <VexConsoleStrip band={{ open: false, held: reason, onToggle }} />
        <VexSectionAnnouncer />
      </>,
    );
    const key = lineKey();
    expect(key.getAttribute("aria-disabled")).toBe("true");
    const described = (key.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual(["Ready", reason]);
    act(() => {
      fireEvent.click(key);
    });
    expect(onToggle).not.toHaveBeenCalled();
    // The press says why, once, politely (VEX Cloud's held key).
    expect(said()).toBe(reason);
  });
});

describe("VexConsoleStrip: Needs you on the console line", () => {
  const band = { open: false, held: null, onToggle: () => undefined };

  it("is the Review key to the decision that leads, with the same count", () => {
    const item = approvalNeedsYouItem(approval({ id: "a1" }), Date.parse("2026-11-04T12:00:00.000Z"));
    arrange({
      needsYou: {
        status: "ready",
        unknownCopy: null,
        count: 1,
        items: [item],
        retry: () => undefined,
        retrying: false,
      },
    });
    render(<VexConsoleStrip band={band} />);
    const key = document.querySelector<HTMLElement>("[data-vex-area='vex-console-line-needs']");
    expect(key?.tagName).toBe("BUTTON");
    expect(key?.getAttribute("aria-label")).toBe(`${item.go}: ${item.title}`);
    expect(key?.querySelector(".vex-console__count")?.textContent).toBe("1");
    const described = key?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe("Needs you: 1");
    act(() => {
      fireEvent.click(key as HTMLElement);
    });
    expect(opened.items).toEqual([item]);
  });

  it("is words, not a key, when nothing needs you, and on the page strip from 1024", () => {
    render(<VexConsoleStrip band={band} />);
    expect(document.querySelector("[data-vex-area='vex-console-line-needs']")).toBeNull();
    expect(document.querySelector(".vex-strip__head")?.textContent).toBe("Needs you0");
    cleanup();
    const item = approvalNeedsYouItem(approval({ id: "a1" }), Date.parse("2026-11-04T12:00:00.000Z"));
    arrange({
      needsYou: {
        status: "ready",
        unknownCopy: null,
        count: 1,
        items: [item],
        retry: () => undefined,
        retrying: false,
      },
    });
    // The page strip keeps its decision cell, so its head stays words.
    render(<VexConsoleStrip />);
    expect(document.querySelector("[data-vex-area='vex-console-line-needs']")).toBeNull();
  });
});
