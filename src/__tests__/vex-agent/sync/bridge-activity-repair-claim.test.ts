/**
 * A2 — the bridge sweep's candidate CLAIM, its per-row due gate, and the end of
 * the every-30-s identical warn.
 *
 * The defect this pins: FOUR drivers call `repairPendingBridges` (the fast
 * lane's provider leg at 30 s, the periodic 120 s job, `drainPendingRuns` and
 * `processNextRun`), and the candidate query was a plain read followed later by
 * a separate `touchAttempt`. Two drivers could therefore select the same rows
 * before either stamped anything and both poll the provider for them — and with
 * no due gate, every extra driver was pure amplification of the same row.
 *
 * These are mocked-pool statement-shape tests, the same shape as
 * `db/repos/agent-activity-solana-sweep-candidates.test.ts`. That two concurrent
 * transactions take DISJOINT batches is a property of `FOR UPDATE SKIP LOCKED`
 * in a real Postgres and belongs to the integration suite
 * (`integration/agent-scan/bridge-sweep.int.test.ts`); what is provable here is
 * that selection and stamp are ONE statement, which is the part the code owns.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import logger from "@utils/logger.js";

let mockQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: vi.fn(),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmBridgeExpectedFill: vi.fn(),
  failActivityEvent: vi.fn(),
  markBridgeLegObserved: vi.fn(),
  attachProviderOrderId: vi.fn(),
  touchLastChecked: vi.fn(),
  clearVerificationStall: vi.fn(),
}));

const { buildProductionBridgeRepairDeps } = await import(
  "@vex-agent/sync/bridge-activity-repair-production-deps.js"
);
const { logInconclusiveVerification } = await import("@vex-agent/sync/bridge-activity-repair-log.js");

beforeEach(() => {
  mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
});

describe("listSweepCandidates is a CLAIM, not a read", () => {
  it("selects, locks and stamps in one statement", async () => {
    await buildProductionBridgeRepairDeps().listSweepCandidates(25);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toMatch(/UPDATE\s+agent_activity/);
    expect(sql).toMatch(/SET\s+last_attempted_at\s*=\s*NOW\(\)/);
    expect(sql).toContain("RETURNING");
    expect(params).toEqual([25]);
  });

  it("gates a repeat on a phase clock the poll cannot reset", async () => {
    await buildProductionBridgeRepairDeps().listSweepCandidates(25);

    const [sql] = mockQuery.mock.calls[0]!;
    // Due-ness is measured on `last_attempted_at`; the PHASE is measured on the
    // immutable `created_at`. Phasing on `last_attempted_at` — which every
    // attempt rewrites — would reset the computed age on every poll and the row
    // would never reach a longer interval.
    expect(sql).toMatch(/NOW\(\)\s*-\s*lg\.created_at\s*<\s*interval '5 minutes'/);
    expect(sql).toMatch(/NOW\(\)\s*-\s*lg\.created_at\s*<\s*interval '15 minutes'/);
    expect(sql).toContain("interval '30 seconds'");
    expect(sql).toContain("interval '60 seconds'");
    expect(sql).toContain("interval '5 minutes'");
  });

  it("a row never attempted is due immediately — the gate slows repeats, not first looks", async () => {
    await buildProductionBridgeRepairDeps().listSweepCandidates(25);

    expect(mockQuery.mock.calls[0]![0]).toContain("lg.last_attempted_at IS NULL");
  });

  it("carries the stored verification reason into the read model", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: 7,
        protocol_execution_id: 70,
        protocol: "khalani",
        wallet_address: "0xwallet",
        created_at: new Date("2026-08-03T09:00:00.000Z"),
        last_verification_reason: "fill_not_mined",
      },
    ]);

    const [row] = await buildProductionBridgeRepairDeps().listSweepCandidates(25);

    // Without this column on the narrow read model the sweep cannot tell a
    // reason CHANGE from a repeat, and warn-on-change is not implementable.
    expect(row?.lastVerificationReason).toBe("fill_not_mined");
  });

  it("maps an absent reason to null rather than the string 'null'", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: 7,
        protocol_execution_id: 70,
        protocol: "khalani",
        wallet_address: "0xwallet",
        created_at: new Date("2026-08-03T09:00:00.000Z"),
        last_verification_reason: null,
      },
    ]);

    const [row] = await buildProductionBridgeRepairDeps().listSweepCandidates(25);

    expect(row?.lastVerificationReason).toBeNull();
  });
});

describe("the order-id recovery queue claims the same way", () => {
  it("locks and stamps its candidates too — it performs a provider lookup and an attach CAS", async () => {
    await buildProductionBridgeRepairDeps().listOrderIdRecoveryCandidates(25);

    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toMatch(/SET\s+last_attempted_at\s*=\s*NOW\(\)/);
    expect(sql).toContain("lg.provider_order_id IS NULL");
  });
});

describe("an unresolvable row stops shouting", () => {
  const row = {
    id: 7,
    protocolExecutionId: 70,
    protocol: "khalani",
    lastVerificationReason: "fill_not_mined" as string | null,
  };

  it("logs DEBUG when the reason is unchanged — the hundredth identical line carries nothing", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const debugSpy = vi.spyOn(logger, "debug");

    logInconclusiveVerification({ event: "bridge.repair.fill_unverified", logical: row, reason: "fill_not_mined" });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("logs WARN when the reason CHANGES — a state change is news", () => {
    const warnSpy = vi.spyOn(logger, "warn");

    logInconclusiveVerification({ event: "bridge.repair.fill_unverified", logical: row, reason: "rpc_unreachable" });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.at(0)?.at(1)).toMatchObject({
      reason: "rpc_unreachable",
      previousReason: "fill_not_mined",
    });
    warnSpy.mockRestore();
  });

  it("logs WARN on the FIRST inconclusive check, when there is no previous reason", () => {
    const warnSpy = vi.spyOn(logger, "warn");

    logInconclusiveVerification({
      event: "bridge.repair.fill_unverified",
      logical: { ...row, lastVerificationReason: null },
      reason: "fill_not_mined",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
