import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  queryOneWith: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  queryOneWith: mocks.queryOneWith,
}));

const { recordReconciliation } = await import(
  "@vex-agent/db/repos/lighter-withdrawal-intents.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryOne.mockResolvedValue(null);
});

describe("Lighter withdrawal reconciliation persistence", () => {
  it("casts the nullable history id before PostgreSQL evaluates its null guard", async () => {
    await expect(recordReconciliation({
      intentId: "lighter-withdrawal-1",
      sessionId: "session-1",
      state: "secure_waiting",
      providerTxStatus: 3,
      providerTxEvidence: { status: 3 },
      historyId: null,
      historyStatus: null,
      historyTimestamp: null,
      historyEvidence: null,
      pendingBalanceUnits: "0",
      settlementScanFromBlock: "123",
    })).resolves.toBeNull();

    const [sql, params] = mocks.queryOne.mock.calls[0]!;
    expect(sql).toContain("COALESCE(withdrawal_history_id, $6::text)");
    expect(sql).toContain("OR $6::text IS NULL");
    expect(sql).toContain("withdrawal_history_id = $6::text");
    expect(params[5]).toBeNull();
  });
});
