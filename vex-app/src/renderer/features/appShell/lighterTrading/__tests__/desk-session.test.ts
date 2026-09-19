import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { deskSessionTitle, latestDeskSession } from "../desk-session.js";

function row(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    id: crypto.randomUUID(),
    mode: "agent",
    permission: "restricted",
    title: "Session",
    initialGoal: null,
    startedAt: "2026-09-17T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    workspace: null,
    ...overrides,
  };
}

describe("latestDeskSession", () => {
  it("picks the most recently started desk session regardless of list order or pins", () => {
    const older = row({ workspace: "lighter", startedAt: "2026-09-16T09:00:00.000Z", pinnedAt: "2026-09-16T10:00:00.000Z" });
    const newer = row({ workspace: "lighter", startedAt: "2026-09-17T09:00:00.000Z" });
    const agent = row({ startedAt: "2026-09-17T12:00:00.000Z" });
    expect(latestDeskSession([older, agent, newer])).toBe(newer);
  });

  it("returns null when the desk has no sessions", () => {
    expect(latestDeskSession([row({}), row({})])).toBeNull();
    expect(latestDeskSession([])).toBeNull();
  });
});

describe("deskSessionTitle", () => {
  it("names the session after the market and an en-US day", () => {
    expect(deskSessionTitle("BTC", new Date("2026-09-17T12:00:00Z"))).toBe("BTC · Sep 17");
  });
});
