import { describe, expect, it, vi } from "vitest";
import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";
import { checkLighterNonceRecovery, type LighterNonceRecoveryDeps } from "@vex-agent/tools/protocols/lighter/nonce-recovery.js";
import { lifecycleIntent, ocoExecutionIntent, orderExecutionIntent } from "../../helpers/lighter-intents.js";

const scope = { environment: "rhc" as const, accountIndex: 42 };
function reservation(prefix = "lighter-order", overrides: Partial<LighterNonceStateRow> = {}): LighterNonceStateRow {
  return {
    ...scope, apiKeyIndex: 7, providerNonce: "9", publicKey: "public-key",
    providerTransactionTime: null, status: "reserved", reservedNonce: "9",
    reservationId: `${prefix}:intent-1`, source: "live_lighter_public_api",
    observedAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", ...overrides,
  };
}
function harness(row = reservation()) {
  const owner = {
    ...scope, intentId: "intent-1", apiKeyIndex: 7, sessionId: "older-session",
    nonceReservationId: row.reservationId, nonceValue: row.reservedNonce,
  };
  const deps = {
    nonces: { listBlockedForAccount: vi.fn().mockResolvedValue([row]) },
    orders: { findByIntentIdAnySession: vi.fn().mockResolvedValue(orderExecutionIntent(owner)) },
    oco: { findByIntentIdAnySession: vi.fn().mockResolvedValue(ocoExecutionIntent(owner)) },
    lifecycle: { findByIntentIdAnySession: vi.fn().mockResolvedValue(lifecycleIntent(owner)) },
    repairOrder: vi.fn(async () => ({ resolution: "expired_unsubmitted" })),
    repairOco: vi.fn(async () => ({ resolution: "expired_unsubmitted" })),
    repairLifecycle: vi.fn(async () => ({ resolution: "expired_unsubmitted" })),
  } satisfies LighterNonceRecoveryDeps;
  return deps;
}

describe("Lighter nonce recovery targets", () => {
  it.each([
    ["lighter-order", "orders", "repairOrder"],
    ["lighter-oco", "oco", "repairOco"],
    ["lighter-lifecycle", "lifecycle", "repairLifecycle"],
  ] as const)("checks the exact %s owner across sessions", async (prefix, repo, repair) => {
    const d = harness(reservation(prefix));
    d.nonces.listBlockedForAccount.mockResolvedValueOnce([reservation(prefix)]).mockResolvedValueOnce([]);

    const result = await checkLighterNonceRecovery(scope, d);

    expect(d[repo].findByIntentIdAnySession).toHaveBeenCalledExactlyOnceWith("intent-1");
    expect(d[repair]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "older-session" }));
    expect(d.nonces.listBlockedForAccount).toHaveBeenNthCalledWith(1, "rhc", 42);
    expect(d.nonces.listBlockedForAccount).toHaveBeenNthCalledWith(2, "rhc", 42);
    expect(result.status).toBe("ready");
    expect(result.checkedReservations).toBe(1);
  });

  it.each([
    { environment: "core" as const }, { accountIndex: 43 }, { apiKeyIndex: 8 },
    { nonceReservationId: "other" }, { nonceValue: "10" },
  ])("preserves a reservation whose owner scope does not match %j", async (mismatch) => {
    const d = harness();
    d.orders.findByIntentIdAnySession.mockResolvedValueOnce(orderExecutionIntent({
      ...scope, nonceReservationId: "lighter-order:intent-1", nonceValue: "9", ...mismatch,
    }));
    expect((await checkLighterNonceRecovery(scope, d)).status).toBe("blocked");
    expect(d.repairOrder).not.toHaveBeenCalled();
  });

  it("preserves missing and unsupported owners instead of clearing by absence", async () => {
    const d = harness();
    d.nonces.listBlockedForAccount.mockResolvedValue([reservation(), reservation("lighter-fees", { apiKeyIndex: 8 })]);
    d.orders.findByIntentIdAnySession.mockResolvedValue(null);
    const result = await checkLighterNonceRecovery(scope, d);
    expect(result.status).toBe("blocked");
    expect(result.remainingReservations).toBe(2);
    expect(d.repairOrder).not.toHaveBeenCalled();
    expect(d.repairOco).not.toHaveBeenCalled();
    expect(d.repairLifecycle).not.toHaveBeenCalled();
  });

  it("does not report ready if a new reservation appears after repair", async () => {
    const d = harness();
    d.nonces.listBlockedForAccount.mockResolvedValueOnce([reservation()])
      .mockResolvedValueOnce([reservation("lighter-order", { reservationId: "lighter-order:new-intent" })]);
    expect((await checkLighterNonceRecovery(scope, d)).status).toBe("blocked");
  });

  it("reports unavailable without retrying a failed repair or clearing anything", async () => {
    const d = harness();
    d.repairOrder.mockRejectedValueOnce(new Error("provider unavailable"));
    const result = await checkLighterNonceRecovery(scope, d);
    expect(result.status).toBe("unavailable");
    expect(d.repairOrder).toHaveBeenCalledOnce();
    expect(result.message).toContain("do not repeat the trade");
  });

  it("checks all of this account's blocked keys instead of a five-order page", async () => {
    const d = harness();
    const rows = Array.from({ length: 7 }, (_, index) => reservation("lighter-order", { apiKeyIndex: 7 + index }));
    d.nonces.listBlockedForAccount.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    for (const row of rows) d.orders.findByIntentIdAnySession.mockResolvedValueOnce(orderExecutionIntent({
      ...scope, apiKeyIndex: row.apiKeyIndex, nonceReservationId: row.reservationId, nonceValue: row.reservedNonce,
    }));
    expect((await checkLighterNonceRecovery(scope, d)).status).toBe("ready");
    expect(d.repairOrder).toHaveBeenCalledTimes(7);
  });
});
