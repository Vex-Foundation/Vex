/**
 * The watch half of the loop-wake repo: the type-filtered pending read the
 * price poller runs on its own tick, and the `triggeredBy` stamp that lets the
 * wake banner say WHY the session woke.
 *
 * Same scripted-mock discipline as `loop-wake.test.ts` (no DB): the SQL is
 * asserted on its load-bearing fragments, because those fragments ARE the
 * safety argument - `due_at > NOW()` is what makes "affected > 0" mean "this
 * statement advanced the deadline" rather than "a row matched".
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;
type ExecuteMock = Mock<(sql: string, params?: unknown[]) => Promise<number>>;

let mockQuery: QueryMock;
let mockExecute: ExecuteMock;

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({ connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) }),
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOneWith: async () => null,
  execute: (sql: string, params?: unknown[]) => mockExecute(sql, params),
  executeWith: async () => 0,
}));

const loopWake = await import("@vex-agent/db/repos/loop-wake.js");

const SESSION = "session-1";
const RUN = "run-1";
const TRIGGERED_BY = {
  type: "token_price",
  chain: "base",
  tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  direction: "above",
  thresholdUsd: "1.5",
  observedPriceUsd: "1.62",
  observedAt: "2026-08-10T12:00:00.000Z",
} as const;

beforeEach(() => {
  mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
  mockExecute = vi.fn<(sql: string, params?: unknown[]) => Promise<number>>()
    .mockResolvedValue(0);
});

describe("getPendingWithWatchType", () => {
  it("filters pending rows by condition type inside Postgres, not in Node", async () => {
    await loopWake.getPendingWithWatchType("token_price");
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("payload ? 'watchId'");
    expect(sql).toContain("payload -> 'conditions' @> $1::jsonb");
    expect(params).toEqual([JSON.stringify([{ type: "token_price" }])]);
  });

  it("maps rows through the shared row mapper", async () => {
    mockQuery.mockResolvedValueOnce([{
      id: "wake-9",
      session_id: SESSION,
      mission_run_id: RUN,
      due_at: "2026-08-10T12:05:00.000Z",
      status: "pending",
      reason: "watching price",
      payload: { watchId: "watch-1", conditions: [{ type: "token_price" }] },
      created_at: "2026-08-10T12:00:00.000Z",
      consumed_at: null,
      cancelled_at: null,
      cancelled_reason: null,
    }]);
    const [row] = await loopWake.getPendingWithWatchType("token_price");
    expect(row?.sessionId).toBe(SESSION);
    expect(row?.dueAt).toBe("2026-08-10T12:05:00.000Z");
  });
});

describe("promotePendingWake with triggeredBy", () => {
  it("leaves the bridge promotion byte-identical when no cause is supplied", async () => {
    mockExecute.mockResolvedValueOnce(1);
    await loopWake.promotePendingWake({ sessionId: SESSION, missionRunId: RUN, watchId: "watch-1" });
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).not.toContain("triggeredBy");
    expect(sql).not.toContain("due_at > NOW()");
    expect(params).toEqual([SESSION, RUN, "watch-1"]);
  });

  it("stamps the cause only under a due_at > NOW() predicate (mission run)", async () => {
    mockExecute.mockResolvedValueOnce(1);
    const promoted = await loopWake.promotePendingWake({
      sessionId: SESSION,
      missionRunId: RUN,
      watchId: "watch-1",
      triggeredBy: TRIGGERED_BY,
    });
    expect(promoted).toBe(true);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("SET due_at = LEAST(wake.due_at, NOW())");
    expect(sql).toContain("jsonb_build_object('triggeredBy', $4::jsonb)");
    expect(sql).toContain("wake.due_at > NOW()");
    expect(sql).toContain("run.status = 'paused_wake'");
    expect(params).toEqual([SESSION, RUN, "watch-1", JSON.stringify(TRIGGERED_BY)]);
  });

  it("stamps the cause for a session-scoped wake without joining mission_runs", async () => {
    mockExecute.mockResolvedValueOnce(1);
    await loopWake.promotePendingWake({
      sessionId: SESSION,
      missionRunId: null,
      watchId: "watch-1",
      triggeredBy: TRIGGERED_BY,
    });
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("wake.mission_run_id IS NULL");
    expect(sql).not.toContain("mission_runs");
    expect(sql).toContain("jsonb_build_object('triggeredBy', $3::jsonb)");
    expect(sql).toContain("wake.due_at > NOW()");
    expect(params).toEqual([SESSION, "watch-1", JSON.stringify(TRIGGERED_BY)]);
  });

  it("reports false when the deadline had already passed, so nothing is mislabelled", async () => {
    mockExecute.mockResolvedValueOnce(0);
    await expect(loopWake.promotePendingWake({
      sessionId: SESSION,
      missionRunId: RUN,
      watchId: "watch-1",
      triggeredBy: TRIGGERED_BY,
    })).resolves.toBe(false);
  });
});
