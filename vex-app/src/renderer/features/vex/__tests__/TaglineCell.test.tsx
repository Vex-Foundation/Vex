/**
 * The tagline cell (docs/design/H3-DESKTOP.md section 1.8 and Appendix A.6):
 * the bottom row's cell under the Vex column says the moment. Pins:
 *   - at rest, desktop's line: "An AI trading agent, on your computer."
 *     (never H3's "inside your limits": desktop has no spend limits);
 *   - a card waiting in the open chat: "Check the card, then decide.";
 *   - the other moments say the first line (the contract's default);
 *   - a card's moment is read from the real state: the open chat, no page
 *     over it, Vex waiting for approval; never the welcome, a page or Studio;
 *   - the second clause is its own span (the muted half), and words are
 *     written in sentence case.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexState } from "../vex-state.js";

const presence = vi.hoisted(() => ({ state: "ready" as VexState }));
vi.mock("../useVexPresence.js", () => ({
  useVexPresence: () => ({ state: presence.state }),
}));

const { TAGLINES, TaglineCell, taglineMomentOf } = await import("../TaglineCell.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-0000000000a1";

function line(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".vex-tagline");
  if (el === null) throw new Error("the tagline is missing");
  return el;
}

beforeEach(() => {
  presence.state = "ready";
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: SESSION, shellRoute: { kind: "none" } });
});

afterEach(cleanup);

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
    expect(taglineMomentOf({ ...chat, runtimeMode: "studio", state: "awaiting" })).toBe("rest");
  });
});

describe("TaglineCell", () => {
  it("says desktop's line at rest, its second clause apart", () => {
    render(<TaglineCell />);
    expect(line().textContent).toBe("An AI trading agent, on your computer.");
    expect(line().getAttribute("data-vex-tagline")).toBe("rest");
    expect(line().querySelector(".vex-tagline__rest")?.textContent).toBe("on your computer.");
    expect(line().textContent).not.toContain("limits");
  });

  it("says check the card while one waits in the open chat", () => {
    presence.state = "awaiting";
    render(<TaglineCell />);
    expect(line().textContent).toBe("Check the card, then decide.");
    expect(line().getAttribute("data-vex-tagline")).toBe("card");
    expect(line().querySelector(".vex-tagline__lead")?.textContent).toBe(TAGLINES.card.lead);
  });

  it("goes back to the first line when a page covers the chat", () => {
    presence.state = "awaiting";
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    render(<TaglineCell />);
    expect(line().textContent).toBe("An AI trading agent, on your computer.");
  });
});
