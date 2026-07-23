import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn().mockResolvedValue(1);

vi.mock("@vex-agent/db/client.js", () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: vi.fn(),
}));

const { seedSyncJobs } = await import("../../../vex-agent/sync/seed.js");

describe("seedSyncJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts 9 sync jobs (4 global + 5 per-namespace)", async () => {
    // Agent Scan added the _global/agent_activity_repair periodic job and
    // removed the polymarket/balances post_mutation job (polymarket removed) —
    // net count is unchanged (9), just redistributed.
    await seedSyncJobs();
    expect(mockExecute).toHaveBeenCalledTimes(9);
  });

  it("uses ON CONFLICT DO NOTHING (idempotent)", async () => {
    await seedSyncJobs();
    for (const call of mockExecute.mock.calls) {
      expect(call[0]).toContain("ON CONFLICT");
      expect(call[0]).toContain("DO NOTHING");
    }
  });

  it("seeds _global periodic job with 300s interval", async () => {
    await seedSyncJobs();
    const globalCall = mockExecute.mock.calls.find(
      (call: unknown[]) => (call[1] as unknown[])[0] === "_global",
    );
    expect(globalCall).toBeDefined();
    expect((globalCall![1] as unknown[])[3]).toBe("periodic");
    expect((globalCall![1] as unknown[])[4]).toBe(300);
  });

  it("seeds per-namespace post_mutation jobs without interval", async () => {
    await seedSyncJobs();
    const postMutationCalls = mockExecute.mock.calls.filter(
      (call: unknown[]) => (call[1] as unknown[])[3] === "post_mutation",
    );
    expect(postMutationCalls).toHaveLength(5); // khalani, solana, kyberswap, pendle, hyperliquid (polymarket removed)
    for (const call of postMutationCalls) {
      expect((call[1] as unknown[])[4]).toBeNull(); // no interval
    }
  });

  it("balance jobs reference khalani.tokens.balances as readToolId", async () => {
    await seedSyncJobs();
    const balanceCalls = mockExecute.mock.calls.filter(
      (call: unknown[]) => (call[1] as unknown[])[1] === "balances",
    );
    for (const call of balanceCalls) {
      expect((call[1] as unknown[])[2]).toBe("khalani.tokens.balances");
    }
  });

  it("seeds a pendle post_mutation balances job (immediate post-trade refresh)", async () => {
    await seedSyncJobs();
    const pendleCall = mockExecute.mock.calls.find(
      (call: unknown[]) => (call[1] as unknown[])[0] === "pendle",
    );
    expect(pendleCall).toBeDefined();
    expect((pendleCall![1] as unknown[])[1]).toBe("balances"); // sync_type
    expect((pendleCall![1] as unknown[])[3]).toBe("post_mutation"); // strategy
    expect((pendleCall![1] as unknown[])[4]).toBeNull(); // no interval
  });

  it("seeds prediction_settlement periodic job", async () => {
    await seedSyncJobs();
    const settlementCall = mockExecute.mock.calls.find(
      (call: unknown[]) => (call[1] as unknown[])[1] === "prediction_settlement",
    );
    expect(settlementCall).toBeDefined();
    expect((settlementCall![1] as unknown[])[0]).toBe("_global");
    expect((settlementCall![1] as unknown[])[2]).toBeNull(); // no readToolId
    expect((settlementCall![1] as unknown[])[3]).toBe("periodic");
    expect((settlementCall![1] as unknown[])[4]).toBe(300);
  });

  it("seeds agent_activity_repair periodic job with 120s interval (Agent Scan)", async () => {
    await seedSyncJobs();
    const repairCall = mockExecute.mock.calls.find(
      (call: unknown[]) => (call[1] as unknown[])[1] === "agent_activity_repair",
    );
    expect(repairCall).toBeDefined();
    expect((repairCall![1] as unknown[])[0]).toBe("_global");
    expect((repairCall![1] as unknown[])[2]).toBeNull(); // no readToolId
    expect((repairCall![1] as unknown[])[3]).toBe("periodic");
    expect((repairCall![1] as unknown[])[4]).toBe(120);
  });

  it("no longer seeds a polymarket/balances job (Agent Scan removed Polymarket)", async () => {
    await seedSyncJobs();
    const polymarketCall = mockExecute.mock.calls.find(
      (call: unknown[]) => (call[1] as unknown[])[0] === "polymarket",
    );
    expect(polymarketCall).toBeUndefined();
  });

  it("seeds Hyperliquid reconciliation for periodic recovery and post-mutation refresh", async () => {
    await seedSyncJobs();
    const calls = mockExecute.mock.calls.filter(
      (call: unknown[]) => (call[1] as unknown[])[1] === "hyperliquid_reconcile",
    );
    expect(calls).toHaveLength(2);
    expect((calls[0]![1] as unknown[]).slice(0, 5)).toEqual(["_global", "hyperliquid_reconcile", null, "periodic", 60]);
    expect((calls[1]![1] as unknown[]).slice(0, 5)).toEqual(["hyperliquid", "hyperliquid_reconcile", null, "post_mutation", null]);
  });
});
