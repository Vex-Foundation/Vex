/**
 * `findLaunchActivityTerminalByTxHash` — the identity sweep's ONE window onto
 * the pending lane's own durable verdict about a launch broadcast.
 *
 * WHY IT IS A READ AND NOT A CLASSIFICATION. Only the EVM pending lane may
 * terminalize a superseded broadcast: it holds the claim fence and owns both A6
 * clocks. But the lane never touches the launch INTENT, so the intent sat in
 * `broadcast_pending` forever even after the lane had answered. This read is how
 * the intent learns the answer — from a durable row, so the mirror works with the
 * provider completely unavailable.
 *
 * THE ROLE GUARD IS THE SAFETY PROPERTY. `agent_activity.tx_hash` is globally
 * unique (migration 044), so a hash match ALONE would happily hand back a swap's
 * or a transfer's status and let it decide a launch's terminal state. The
 * predicate therefore requires `event_role = 'token_launch'`, exactly like every
 * other launch-scoped writer in this module.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;

let mockQueryOne: QueryOneMock;

function resetMocks(): void {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/agent-activity.js");

const TX_HASH = "0x09b84e0000000000000000000000000000000000000000000000000000e955";

function sqlOf(): string {
  return String(mockQueryOne.mock.calls.at(-1)![0]).replace(/\s+/g, " ");
}

beforeEach(() => {
  resetMocks();
});

describe("findLaunchActivityTerminalByTxHash", () => {
  it("REQUIRES event_role = 'token_launch' — a swap's verdict may not end a launch", async () => {
    await repo.findLaunchActivityTerminalByTxHash(TX_HASH);
    const sql = sqlOf();
    expect(sql).toContain("WHERE tx_hash = $1");
    expect(sql).toContain("AND event_role = 'token_launch'");
    expect(mockQueryOne.mock.calls.at(-1)![1]).toEqual([TX_HASH]);
  });

  it("reads status and nothing else — it is not a second opinion about the money", async () => {
    await repo.findLaunchActivityTerminalByTxHash(TX_HASH);
    const sql = sqlOf();
    expect(sql).toContain("SELECT status FROM agent_activity");
    expect(sql).not.toContain("executed_amount");
    expect(sql).not.toContain("UPDATE");
  });

  it("returns the lane's verdict when there is one", async () => {
    mockQueryOne.mockResolvedValue({ status: "superseded_unproven" });
    expect(await repo.findLaunchActivityTerminalByTxHash(TX_HASH)).toEqual({
      status: "superseded_unproven",
    });
  });

  it("returns null when no launch row carries the hash — NOT a fabricated 'pending'", async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await repo.findLaunchActivityTerminalByTxHash(TX_HASH)).toBeNull();
  });

  it("passes a still-pending sibling through verbatim, for the caller to reject", async () => {
    mockQueryOne.mockResolvedValue({ status: "pending" });
    expect(await repo.findLaunchActivityTerminalByTxHash(TX_HASH)).toEqual({ status: "pending" });
  });
});
