import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  filterSessionsByTitle,
  filterSessionsByWorkspace,
  formatChatRowTime,
  formatSessionTime,
  groupSessions,
} from "../sessionListModel.js";

describe("groupSessions", () => {
  // docs/design/H3-DESKTOP.md Appendix A.2: Pinned, Today, Yesterday, Earlier.
  const at = (daysAgo: number): string => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).toISOString();
  };

  it("files chats under Pinned, Today, Yesterday and Earlier, in that order", () => {
    const pinned = makeRow({ title: "Pinned one", startedAt: at(9), pinnedAt: at(0) });
    const today = makeRow({ title: "Today's", startedAt: at(0) });
    const yesterday = makeRow({ title: "Yesterday's", startedAt: at(1) });
    const earlier = makeRow({ title: "Last week's", startedAt: at(7) });
    const groups = groupSessions([earlier, yesterday, today, pinned]);
    expect(groups.map((g) => [g.key, g.title])).toEqual([
      ["pinned", "Pinned"],
      ["today", "Today"],
      ["yesterday", "Yesterday"],
      ["earlier", "Earlier"],
    ]);
    expect(groups.map((g) => g.rows)).toEqual([[pinned], [today], [yesterday], [earlier]]);
  });

  it("says Earlier, never R3's Older", () => {
    expect(groupSessions([]).map((g) => g.title)).not.toContain("Older");
  });
});

describe("formatChatRowTime", () => {
  // docs/design/H3-DESKTOP.md section 1.4: "12:41", "09:12", "Oct 28".
  const localAt = (daysAgo: number, hour: number, minute: number): string => {
    const now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysAgo,
      hour,
      minute,
    ).toISOString();
  };

  it("writes today's and yesterday's start on the 24-hour clock, zero-padded", () => {
    expect(formatChatRowTime(localAt(0, 9, 5))).toBe("09:05");
    expect(formatChatRowTime(localAt(0, 14, 30))).toBe("14:30");
    expect(formatChatRowTime(localAt(1, 18, 5))).toBe("18:05");
  });

  it("writes an earlier start as the English short date", () => {
    expect(formatChatRowTime("2020-06-15T12:00:00Z")).toMatch(/^Jun \d{1,2}$/);
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatChatRowTime("not-a-date")).toBe("");
  });
});

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
