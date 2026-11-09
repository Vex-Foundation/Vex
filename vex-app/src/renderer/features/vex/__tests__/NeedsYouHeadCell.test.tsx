/**
 * NEEDS YOU in the header (docs/design/H3-DESKTOP.md section 6.2): one key
 * with the word and the count, and a press that OPENS THE NEEDS YOU PAGE and
 * never decides. The count is the console's own model (`useNeedsYou`,
 * mocked here): a count nobody verified is not a number.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeedsYouResult } from "../useVexPresence.js";

const model = vi.hoisted(() => ({ current: null as NeedsYouResult | null }));
const decide = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../useVexPresence.js", () => ({
  useNeedsYou: () => {
    if (model.current === null) throw new Error("Needs you not arranged");
    return model.current;
  },
}));
// The decision path must never be reached from the header.
vi.mock("../../appShell/ApprovalCard/reveal-approval-card.js", () => ({
  revealApprovalCard: () => {
    decide.calls += 1;
  },
}));

const { NeedsYouHeadCell, NEEDS_YOU_HEAD_HINT } = await import("../NeedsYouHeadCell.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

function arrange(overrides: Partial<NeedsYouResult> = {}): void {
  model.current = {
    status: "ready",
    unknownCopy: null,
    count: 2,
    items: [],
    retry: () => undefined,
    retrying: false,
    ...overrides,
  };
}

function key(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='needs-you-head']");
  if (el === null) throw new Error("the Needs you cell is missing");
  return el;
}

beforeEach(() => {
  arrange();
  decide.calls = 0;
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
});

describe("Needs you in the header", () => {
  it("is the header's needs cell: the word and its count, one key", () => {
    render(<NeedsYouHeadCell />);
    const cell = document.querySelector("[data-vex-head-cell='needs']");
    expect(cell?.querySelectorAll("button")).toHaveLength(1);
    expect(key().textContent).toBe("Needs you2");
    expect(key().getAttribute("aria-label")).toBe("Needs you: 2");
    const hint = document.getElementById(key().getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe(NEEDS_YOU_HEAD_HINT);
  });

  it("mutes a zero and says no count while the read runs or after it failed", () => {
    arrange({ count: 0, items: [] });
    const view = render(<NeedsYouHeadCell />);
    expect(key().querySelector(".vex-head-needs__count")?.hasAttribute("data-zero")).toBe(true);
    arrange({ status: "loading", count: null });
    view.rerender(<NeedsYouHeadCell />);
    expect(key().querySelector(".vex-head-needs__count")).toBeNull();
    expect(key().getAttribute("aria-label")).toBe("Needs you");
    arrange({ status: "unknown", count: null });
    view.rerender(<NeedsYouHeadCell />);
    expect(key().querySelector(".vex-head-needs__count")).toBeNull();
  });

  it("opens the Needs you page and never decides", () => {
    render(<NeedsYouHeadCell />);
    fireEvent.click(key());
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "needsYou", origin: null, approvalId: null });
    expect(decide.calls).toBe(0);
  });
});
