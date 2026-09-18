import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  filterSessionsByTitle,
  filterSessionsByWorkspace,
  formatSessionTime,
} from "../sessionListModel.js";

describe("formatSessionTime", () => {
  it("formats older dates with an English (en-US) month, not the OS locale", () => {
    // Mid-month + midday UTC: the local date stays within June across every
    // timezone (UTC-12..UTC+14), so the English month abbreviation is
    // deterministic. A non-English OS locale (e.g. Polish "cze") would fail
    // this assertion, which is exactly the regression we guard against.
    const result = formatSessionTime("2020-06-15T12:00:00Z");
    expect(result).toMatch(/^Jun \d{1,2}$/);
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatSessionTime("not-a-date")).toBe("");
  });
});

describe("filterSessionsByTitle", () => {
  const rows: readonly SessionListItem[] = [
    makeRow({ title: "Arbitrum LP Rebalance" }),
    makeRow({ title: "Daily gas report", mode: "mission" }),
    makeRow({ title: null, initialGoal: "Watch ETH funding rates" }),
  ];

  it("matches rendered titles case-insensitively and trims the query", () => {
    expect(filterSessionsByTitle(rows, "  GAS ")).toEqual([rows[1]]);
  });

  it("keeps legacy sessions searchable through their rendered goal fallback", () => {
    expect(filterSessionsByTitle(rows, "funding")).toEqual([rows[2]]);
  });

  it("searches the complete title rather than only its truncated display label", () => {
    const longTitle = makeRow({
      title: `${"A".repeat(60)} hidden-keyword`,
    });
    expect(filterSessionsByTitle([longTitle], "hidden-keyword")).toEqual([
      longTitle,
    ]);
  });

  it("returns the original rows for an empty query", () => {
    expect(filterSessionsByTitle(rows, "   ")).toBe(rows);
  });
});

describe("filterSessionsByWorkspace", () => {
  const agent = makeRow({ title: "Agent" });
  const legacy = makeRow({ title: "Before the column existed" });
  delete (legacy as { workspace?: unknown }).workspace;
  const desk = makeRow({ title: "BTC · Sep 17", workspace: "lighter" });
  const rows = [agent, legacy, desk];

  it("gives the agent rail only agent sessions, legacy rows included", () => {
    expect(filterSessionsByWorkspace(rows, null)).toEqual([agent, legacy]);
  });

  it("gives the Lighter rail only desk sessions", () => {
    expect(filterSessionsByWorkspace(rows, "lighter")).toEqual([desk]);
  });
});

function makeRow(
  overrides: Partial<SessionListItem>,
): SessionListItem {
  return {
    id: crypto.randomUUID(),
    mode: "agent",
    permission: "restricted",
    title: "Session",
    initialGoal: null,
    startedAt: "2026-07-12T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    workspace: null,
    ...overrides,
  };
}
