import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueryOne = vi.fn<(sql: string, params?: unknown[]) => Promise<{ found: number } | null>>();
vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  execute: vi.fn(),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
}));

const { hasPendingForSession } = await import("@vex-agent/db/repos/approvals.js");

describe("approvals.hasPendingForSession", () => {
  beforeEach(() => {
    mockQueryOne.mockReset();
  });

  it("is true when a pending row exists for the session", async () => {
    mockQueryOne.mockResolvedValue({ found: 1 });
    await expect(hasPendingForSession("session-1")).resolves.toBe(true);
    const [sql, params] = mockQueryOne.mock.calls[0] ?? [];
    expect(sql).toContain("session_id = $1");
    expect(sql).toContain("status = 'pending'");
    expect(params).toEqual(["session-1"]);
  });

  it("is false when none exists", async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(hasPendingForSession("session-1")).resolves.toBe(false);
  });
});
