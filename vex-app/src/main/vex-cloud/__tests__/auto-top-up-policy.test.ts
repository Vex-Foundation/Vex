/**
 * The auto top-up rule policy and the low-balance watch as pure decisions
 * (backend plan 4.4, D12): caps over rolling windows that count unknown and
 * in-flight outcomes, agent coverage, the derived `suspended` state, the
 * approvable bounds, and one notice per crossing of the alert line.
 *
 * Does not prove the durable transaction (the per-rule lock and the partial
 * unique index live in Postgres, migration 178).
 */

import { describe, expect, it } from "vitest";
import { capsAllow, capsStillHold, effectiveRuleState, ruleCoversAgentDeposit, validateRuleBounds, type RuleConditions } from "../auto-top-up/rule-policy.js";
import { createObservationGenerations, nextWatchRow, observeBalance, thresholdOf, type BalanceObservation } from "../balance-watch.js";
import { ACCOUNT_ID, DEFAULT_FEE_CEILING_WEI, E18, MemoryFundingStore, NOW, OTHER_WALLET, WALLET } from "./support/funding-fakes.js";

const LIVE: RuleConditions = {
  now: NOW,
  vaultUnlocked: true,
  quitting: false,
  executionReady: true,
  signedInAccountId: ACCOUNT_ID,
  depositAddressMatches: true,
  balanceReadFailing: false,
  networkFeeAboveLimit: false,
};
const FEE = 10n ** 13n;

function rule() {
  return new MemoryFundingStore().seedRule({ amountWei: 6_000n * E18, maxPerDay: 2, monthlyCapWei: 12_000n * E18 });
}

describe("caps", () => {
  it("one more execution must fit both the 24 hour count and the 30 day VEX cap", () => {
    const r = rule();
    expect(capsAllow(r, { countLastDay: 1, sumLast30DaysWei: 6_000n * E18 }, 6_000n * E18)).toEqual({ ok: true });
    expect(capsAllow(r, { countLastDay: 2, sumLast30DaysWei: 0n }, 6_000n * E18)).toEqual({ ok: false, which: "daily_count" });
    expect(capsAllow(r, { countLastDay: 0, sumLast30DaysWei: 6_000n * E18 + 1n }, 6_000n * E18)).toEqual({ ok: false, which: "monthly_cap" });
  });

  it("the gate's check counts the in-flight execution itself, so equal to the cap still holds and one wei over does not", () => {
    const r = rule();
    expect(capsStillHold(r, { countLastDay: 2, sumLast30DaysWei: 12_000n * E18 })).toBe(true);
    expect(capsStillHold(r, { countLastDay: 2, sumLast30DaysWei: 12_000n * E18 + 1n })).toBe(false);
    expect(capsStillHold(r, { countLastDay: 3, sumLast30DaysWei: 0n })).toBe(false);
  });

  it("unknown outcomes count: the memory store's usage includes every row that was not refused", async () => {
    const store = new MemoryFundingStore();
    const r = store.seedRule();
    const statuses = ["unknown", "refused", "confirmed"] as const;
    for (const [index, status] of statuses.entries()) {
      const asked = await store.askExecution(
        { executionId: `vxexec-00000000-0000-4000-8000-00000000000${index}`, ruleId: r.ruleId, authority: "auto_top_up_poller", sessionId: null, sourceWallet: WALLET, depositAddress: WALLET, amountWei: E18 },
        null,
        NOW,
      );
      if (!asked.admitted) throw new Error("not admitted");
      await store.decideExecution({ executionId: asked.row.executionId, status, txHash: null, refusalKind: null, decidedAt: NOW });
    }
    expect(await store.readRuleUsage(r.ruleId, NOW)).toEqual({ countLastDay: 2, sumLast30DaysWei: 2n * E18 });
  });
});

describe("effective state (plan 4.4)", () => {
  const usage = { countLastDay: 0, sumLast30DaysWei: 0n };

  it("is active only when every live condition holds", () => {
    expect(effectiveRuleState(rule(), usage, LIVE)).toEqual({ state: "active" });
  });

  it.each([
    ["vault_locked", { vaultUnlocked: false }],
    ["app_quitting", { quitting: true }],
    ["execution_not_ready", { executionReady: false }],
    ["account_changed", { signedInAccountId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }],
    ["account_changed", { signedInAccountId: null }],
    ["deposit_address_mismatch", { depositAddressMatches: false }],
    // `null` = the backend could not be read: the pin was not compared, so the honest reason is the failing read.
    ["balance_read_failing", { depositAddressMatches: null }],
    ["balance_read_failing", { balanceReadFailing: true }],
    ["network_fee_above_limit", { networkFeeAboveLimit: true }],
  ] as const)("is suspended (%s)", (reason, patch) => {
    expect(effectiveRuleState(rule(), usage, { ...LIVE, ...patch })).toEqual({ state: "suspended", reason });
  });

  it("is suspended when the caps are used up, paused by the user, and expired past its expiry whatever the stored status", () => {
    expect(effectiveRuleState(rule(), { countLastDay: 2, sumLast30DaysWei: 0n }, LIVE)).toEqual({ state: "suspended", reason: "cap_reached" });
    expect(effectiveRuleState({ ...rule(), status: "paused" }, usage, LIVE)).toEqual({ state: "suspended", reason: "user_paused" });
    expect(effectiveRuleState({ ...rule(), expiresAt: NOW }, usage, LIVE)).toEqual({ state: "expired" });
    expect(effectiveRuleState({ ...rule(), status: "revoked" }, usage, LIVE)).toEqual({ state: "revoked" });
  });

  it("a rule approved without a network fee ceiling (before migration 179) spends nothing: suspended for its fee", () => {
    expect(effectiveRuleState({ ...rule(), maxNetworkFeeWei: null }, usage, LIVE)).toEqual({ state: "suspended", reason: "network_fee_above_limit" });
  });
});

describe("agent coverage", () => {
  const usage = { countLastDay: 0, sumLast30DaysWei: 0n };

  it("covers the same wallet at or under the per-top-up amount within the caps", () => {
    expect(ruleCoversAgentDeposit(rule(), usage, LIVE, { from: WALLET, amountWei: 6_000n * E18, maxNetworkFeeWei: FEE })).toEqual({ covered: true });
    expect(ruleCoversAgentDeposit(rule(), usage, LIVE, { from: WALLET.toLowerCase(), amountWei: 5_000n * E18, maxNetworkFeeWei: DEFAULT_FEE_CEILING_WEI })).toEqual({ covered: true });
  });

  it("never covers another wallet, a larger amount, a used-up cap or a suspended rule", () => {
    expect(ruleCoversAgentDeposit(rule(), usage, LIVE, { from: OTHER_WALLET, amountWei: E18, maxNetworkFeeWei: FEE }).covered).toBe(false);
    expect(ruleCoversAgentDeposit(rule(), usage, LIVE, { from: WALLET, amountWei: 6_000n * E18 + 1n, maxNetworkFeeWei: FEE }).covered).toBe(false);
    expect(ruleCoversAgentDeposit(rule(), { countLastDay: 1, sumLast30DaysWei: 7_000n * E18 }, LIVE, { from: WALLET, amountWei: 6_000n * E18, maxNetworkFeeWei: FEE }).covered).toBe(false);
    expect(ruleCoversAgentDeposit(rule(), usage, { ...LIVE, vaultUnlocked: false }, { from: WALLET, amountWei: E18, maxNetworkFeeWei: FEE }).covered).toBe(false);
  });

  it("never covers a fee bound one wei above the rule's network fee ceiling, nor any fee on a rule without one", () => {
    expect(ruleCoversAgentDeposit(rule(), usage, LIVE, { from: WALLET, amountWei: E18, maxNetworkFeeWei: DEFAULT_FEE_CEILING_WEI + 1n })).toEqual({
      covered: false,
      reason: "the network fee bound is above the auto top-up rule's network fee limit",
    });
    expect(ruleCoversAgentDeposit({ ...rule(), maxNetworkFeeWei: null }, usage, LIVE, { from: WALLET, amountWei: E18, maxNetworkFeeWei: 1n }).covered).toBe(false);
  });
});

describe("approvable bounds", () => {
  const minimumWei = 5_000n * E18;
  const ok = { sourceWallet: WALLET, amountWei: 5_000n * E18, maxPerDay: 1, monthlyCapWei: 5_000n * E18, maxNetworkFeeWei: DEFAULT_FEE_CEILING_WEI, expiresAt: new Date(NOW.getTime() + 90 * 86_400_000) };

  it("accepts the minimum amount, a cap of one top-up and exactly 90 days", () => {
    expect(validateRuleBounds(ok, { now: NOW, minimumWei })).toEqual({ ok: true });
  });

  it.each([
    ["amountWei", { amountWei: 5_000n * E18 - 1n }],
    ["maxPerDay", { maxPerDay: 0 }],
    ["maxPerDay", { maxPerDay: 25 }],
    ["monthlyCapWei", { monthlyCapWei: 5_000n * E18 - 1n }],
    ["expiresAt", { expiresAt: new Date(NOW.getTime() + 90 * 86_400_000 + 1) }],
    ["expiresAt", { expiresAt: NOW }],
    ["maxNetworkFeeWei", { maxNetworkFeeWei: 0n }],
    ["maxNetworkFeeWei", { maxNetworkFeeWei: 10n ** 16n + 1n }],
  ] as const)("refuses %s out of bounds", (field, patch) => {
    const verdict = validateRuleBounds({ ...ok, ...patch }, { now: NOW, minimumWei });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.field).toBe(field);
  });
});

describe("low-balance watch", () => {
  it("the reference is the high-water mark, and a new credited deposit resets it to the balance after it", () => {
    let row = nextWatchRow(null, { accountId: ACCOUNT_ID, balanceWei: 100n * E18, newestCreditedDepositId: "dep_1", alertPercent: 20 });
    expect(row.referenceWei).toBe(100n * E18);
    row = nextWatchRow(row, { accountId: ACCOUNT_ID, balanceWei: 150n * E18, newestCreditedDepositId: "dep_1", alertPercent: 20 });
    expect(row.referenceWei).toBe(150n * E18);
    row = nextWatchRow(row, { accountId: ACCOUNT_ID, balanceWei: 40n * E18, newestCreditedDepositId: "dep_1", alertPercent: 20 });
    expect(row.referenceWei).toBe(150n * E18);
    row = nextWatchRow(row, { accountId: ACCOUNT_ID, balanceWei: 60n * E18, newestCreditedDepositId: "dep_2", alertPercent: 20 });
    expect(row.referenceWei).toBe(60n * E18);
    expect(thresholdOf(150n * E18, 20)).toBe(30n * E18);
  });

  it("emits ONE notice per crossing: not on the way down a second time, again only after recovering", async () => {
    const store = new MemoryFundingStore();
    const crossings: BalanceObservation[] = [];
    const deps = { store, generations: createObservationGenerations(), emitCrossing: (o: BalanceObservation) => crossings.push(o) };
    const observe = (vex: bigint) => observeBalance(deps, { accountId: ACCOUNT_ID, balanceWei: vex * E18, newestCreditedDepositId: "dep_1", generation: deps.generations.next() });
    await observe(100n);
    expect((await observe(19n)).crossed).toBe(true);
    expect((await observe(10n)).crossed).toBe(false);
    expect((await observe(25n)).belowAlert).toBe(false);
    expect((await observe(15n)).crossed).toBe(true);
    expect(crossings.map((o) => o.balanceWei)).toEqual([19n * E18, 15n * E18]);
    expect(crossings[0]).toMatchObject({ alertPercent: 20, thresholdWei: 20n * E18, referenceWei: 100n * E18 });
  });

  it("exactly at the threshold is not below it", async () => {
    const store = new MemoryFundingStore();
    const deps = { store, generations: createObservationGenerations(), emitCrossing: () => undefined };
    const at = (wei: bigint) => observeBalance(deps, { accountId: ACCOUNT_ID, balanceWei: wei, newestCreditedDepositId: null, generation: deps.generations.next() });
    await at(100n * E18);
    expect((await at(20n * E18)).belowAlert).toBe(false);
    expect((await at(20n * E18 - 1n)).belowAlert).toBe(true);
  });

  it("a stalled read that lands after a newer one is discarded: 1,000 VEX at 20%, a 200 VEX read stalls past a 19 VEX notice, exactly one notice", async () => {
    const store = new MemoryFundingStore();
    const crossings: BalanceObservation[] = [];
    const deps = { store, generations: createObservationGenerations(), emitCrossing: (o: BalanceObservation) => crossings.push(o) };
    const observe = (vex: bigint, generation: number) =>
      observeBalance(deps, { accountId: ACCOUNT_ID, balanceWei: vex * E18, newestCreditedDepositId: "dep_1", generation });
    await observe(1_000n, deps.generations.next());
    // The poller's read STARTS (generation taken) while the balance is 200 VEX, then stalls.
    const stalledGeneration = deps.generations.next();
    // Meanwhile a status read sees 19 VEX: below 200, the notice fires.
    expect((await observe(19n, deps.generations.next())).crossed).toBe(true);
    // The stalled 200 VEX answer lands now. It must not clear the latch.
    const late = await observe(200n, stalledGeneration);
    expect(late).toMatchObject({ stale: true, crossed: false, belowAlert: true, balanceWei: 19n * E18 });
    // The next fresh read still sees the same dip: no second notice.
    expect((await observe(18n, deps.generations.next())).crossed).toBe(false);
    expect(crossings).toHaveLength(1);
    expect(store.watch.get(ACCOUNT_ID)).toMatchObject({ belowAlert: true, lastBalanceWei: 18n * E18, referenceWei: 1_000n * E18 });
  });
});
