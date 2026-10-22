/**
 * The Needs you list: every row says the action, where and when, and offers a
 * key that only opens it; an empty inbox and an unreadable one are drawn
 * differently, and neither is ever drawn as the other.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  NEEDS_YOU_EMPTY_COPY,
  NEEDS_YOU_UNKNOWN_COPY,
  approvalNeedsYouItem,
  missionNeedsYouItem,
  type NeedsYouItem,
} from "../needs-you.js";
import { NeedsYouList, type NeedsYouListModel } from "../needs-you/NeedsYouList.js";
import { approval, session } from "./fixtures.js";

const NOW = Date.parse("2026-10-17T12:30:00.000Z");

afterEach(() => {
  cleanup();
});

function model(overrides: Partial<NeedsYouListModel> = {}): NeedsYouListModel {
  return { status: "ready", unknownCopy: null, items: [], retry: vi.fn(), retrying: false, ...overrides };
}

function itemsOf(...candidates: Array<NeedsYouItem | null>): NeedsYouItem[] {
  return candidates.filter((candidate): candidate is NeedsYouItem => candidate !== null);
}

const BRIDGE = approvalNeedsYouItem(
  approval({
    id: "a1",
    toolName: "BridgeExecute",
    sessionTitle: "Treasury chat",
    expiresAt: "2026-10-17T15:30:00.000Z",
  }),
  NOW,
);
const RECOVER = missionNeedsYouItem(session({ title: "Weekly rebalance", missionStatus: "paused_error" }));

describe("NeedsYouList rows", () => {
  it.each(["panel", "sidebar"] as const)("%s: the action, where and when, and a key", (variant) => {
    const onReview = vi.fn();
    render(<NeedsYouList model={model({ items: itemsOf(BRIDGE, RECOVER) })} variant={variant} onReview={onReview} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error("rows missing");

    expect(within(first).getByText("Approve bridge")).toBeTruthy();
    expect(first.textContent).toContain("Treasury chat · expires 15:30 UTC");
    expect(within(first).getByRole("button", { name: "Review: Approve bridge" })).toBeTruthy();

    expect(within(second).getByText("Recover the mission")).toBeTruthy();
    expect(second.textContent).toContain("Weekly rebalance · paused on an error");
    expect(within(second).getByRole("button", { name: "Recover: Recover the mission" })).toBeTruthy();
  });

  it("sets the time as a figure", () => {
    render(<NeedsYouList model={model({ items: itemsOf(BRIDGE) })} variant="panel" onReview={vi.fn()} />);
    const time = screen.getByText("15:30 UTC");
    expect(time.className).toContain("font-mono");
  });

  it("only opens: the key hands the item back and nothing else", () => {
    const onReview = vi.fn();
    render(<NeedsYouList model={model({ items: itemsOf(BRIDGE) })} variant="panel" onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Review: Approve bridge" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(BRIDGE);
    // No decision key lives in this list.
    expect(screen.queryByRole("button", { name: /^approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^reject/i })).toBeNull();
  });

  it("lets the surface word the key, as the sidebar's jump to the card does", () => {
    render(
      <NeedsYouList
        model={model({ items: itemsOf(BRIDGE) })}
        variant="sidebar"
        onReview={vi.fn()}
        goLabel={(item) => (item.kind === "approval" ? "Review ↓" : item.go)}
      />,
    );
    expect(screen.getByRole("button", { name: "Review ↓: Approve bridge" })).toBeTruthy();
  });

  it("marks a decision with the target fill and a mission to recover with the ink cross", () => {
    const { container } = render(
      <NeedsYouList model={model({ items: itemsOf(BRIDGE, RECOVER) })} variant="panel" onReview={vi.fn()} />,
    );
    const fills = Array.from(container.querySelectorAll(".vex-swatch")).map((swatch) =>
      swatch.getAttribute("data-s"),
    );
    expect(fills).toEqual(["awaiting", "error"]);
  });
});

describe("NeedsYouList states", () => {
  it("says Nothing needs you. after a read that listed nothing", () => {
    render(<NeedsYouList model={model()} variant="sidebar" onReview={vi.fn()} />);
    expect(screen.getByText(NEEDS_YOU_EMPTY_COPY)).toBeTruthy();
    expect(NEEDS_YOU_EMPTY_COPY).toBe("Nothing needs you.");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("an unreadable inbox says so and offers Retry, never the empty line", () => {
    const retry = vi.fn();
    render(<NeedsYouList model={model({ status: "unknown", unknownCopy: NEEDS_YOU_UNKNOWN_COPY, retry })} variant="panel" onReview={vi.fn()} />);
    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).toBeTruthy();
    expect(screen.queryByText(NEEDS_YOU_EMPTY_COPY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("disables Retry while the read runs", () => {
    render(
      <NeedsYouList model={model({ status: "unknown", retrying: true })} variant="panel" onReview={vi.fn()} />,
    );
    const button = screen.getByRole("button", { name: "Checking" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("still lists the missions that wait when the inbox is unreadable", () => {
    render(
      <NeedsYouList
        model={model({ status: "unknown", unknownCopy: NEEDS_YOU_UNKNOWN_COPY, items: itemsOf(RECOVER) })}
        variant="panel"
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).toBeTruthy();
    expect(screen.getByText("Recover the mission")).toBeTruthy();
  });

  it("says it is checking before the first read, not that nothing needs you", () => {
    render(<NeedsYouList model={model({ status: "loading" })} variant="panel" onReview={vi.fn()} />);
    expect(screen.getByText("Checking for pending approvals")).toBeTruthy();
    expect(screen.queryByText(NEEDS_YOU_EMPTY_COPY)).toBeNull();
  });
});
