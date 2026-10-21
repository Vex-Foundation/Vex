/**
 * A standing rule's authority at the signing boundary, over the REAL shared
 * deposit core, the recorded execution owner, the rule owner (its real
 * submit path for pause, revoke and edit) and a scripted chain port that
 * walks the real hook order: the pre-sign gate, the key, an AWAITED window
 * standing for the pending-nonce read, then the local final check.
 *
 * Proves: a rule that expires, or is paused, revoked or edited, while a
 * top-up is between its gate and its signature signs nothing and is recorded
 * `refused` (never `unknown`, never counted); the network fee ceiling is
 * enforced for the poller (refused, rule suspended "Network fee above your
 * limit", no retry every tick) and for the agent (no coverage: the card is
 * raised instead) and on the request about to be signed; a retired agent
 * intent can never be signed.
 *
 * Does not prove the Postgres lock and index (the integration suite) nor
 * the chain (the Anvil fork test).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { __resetDepositCoreForTests } = await import("../funding/deposit-core.js");
const { __resetAgentDepositsForTests, confirmAgentDeposit, peekAgentDeposit, prepareAgentDeposit, retireAgentDeposit } = await import("../funding/agent-deposit.js");
const { __resetExecutorForTests, markRecoveryComplete } = await import("../auto-top-up/executor.js");
const { createAutoTopUpPoller, FEE_RETRY_AFTER_MS, feeSuspended } = await import("../auto-top-up/poller.js");
const { createObservationGenerations } = await import("../balance-watch.js");
const { __resetRuleAuthorityForTests, ruleMutationPending } = await import("../auto-top-up/rule-authority.js");
const { __resetRuleProposalsForTests, prepareAutoTopUp, ruleView, submitAutoTopUp } = await import("../auto-top-up/rule-proposals.js");
const { accountWith, ACCOUNT_ID, depositWorld, E18, MemoryFundingStore, NOW, WALLET } = await import("./support/funding-fakes.js");
import type { AgentDepositRuntimeAuthority } from "@vex-agent/tools/internal/vex-inference/host.js";
import type { LiveConditions } from "../runtime.js";
import type { RuleOwnerDeps } from "../auto-top-up/rule-proposals.js";

const SESSION = "session-a";
const signal = (): AbortSignal => new AbortController().signal;

function setup() {
  const world = depositWorld();
  const store = new MemoryFundingStore();
  const live: { signedInAccountId: string | null } = { signedInAccountId: ACCOUNT_ID };
  const conditions = (): LiveConditions => ({
    now: world.now,
    vaultUnlocked: world.vaultUnlocked,
    quitting: false,
    executionReady: world.executionReady,
    signedInAccountId: live.signedInAccountId,
  });
  const agent = { deposit: world.deps, store, conditions };
  const poller = createAutoTopUpPoller({
    deposit: world.deps,
    store,
    conditions,
    api: { readAccount: world.deps.api.readAccount, listDeposits: async () => ({ ok: true, value: { items: [], next_cursor: null } }) },
    watch: { store, generations: createObservationGenerations(), emitCrossing: () => undefined },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  });
  const owner: RuleOwnerDeps = {
    readSession: world.deps.readSession,
    clearSession: world.deps.clearSession,
    api: { readAccount: world.deps.api.readAccount },
    store,
    listEvmWallets: world.deps.listEvmWallets,
    pinnedDepositAddress: world.deps.pinnedDepositAddress,
    conditions,
    balanceReadFailing: () => false,
    networkFeeAboveLimit: (rule) => feeSuspended(poller.snapshot(), rule),
    now: () => world.now,
    newRuleId: () => "vxrule-00000000-0000-4000-8000-0000000000aa",
  };
  return { world, store, live, agent, poller, owner };
}

type Harness = ReturnType<typeof setup>;

async function prepared(h: Harness, amount = "6000") {
  const outcome = await prepareAgentDeposit(h.agent, { sessionId: SESSION, walletAddress: WALLET, amount: { unit: "VEX", value: amount } }, signal());
  if (!outcome.ok) throw new Error(`prepare refused: ${outcome.refusal.kind}: ${outcome.refusal.detail}`);
  return outcome.value;
}

function confirm(h: Harness, intentId: string, authority: AgentDepositRuntimeAuthority) {
  return confirmAgentDeposit(h.agent, { sessionId: SESSION, intentId, authority, sourceWalletStillAllowed: () => null }, signal());
}

/** Apply a pause, revoke or edit through the rule owner's REAL prepare and submit. */
async function userChanges(h: Harness, action: "pause" | "revoke" | "edit"): Promise<void> {
  const rule = await h.store.readLiveRule(ACCOUNT_ID);
  if (rule === null) throw new Error("no live rule");
  const input = action === "edit"
    ? { action, ruleId: rule.ruleId, expectedVersion: rule.version, fields: { sourceWallet: WALLET, amountText: "5000", maxPerDay: 2, monthlyCapText: "12000", maxNetworkFeeText: "0.0001", expiresInDays: 30 } } as const
    : { action, ruleId: rule.ruleId, expectedVersion: rule.version } as const;
  const proposal = await prepareAutoTopUp(h.owner, input, signal());
  if (!proposal.ok) throw new Error(`change not prepared: ${proposal.refusal.kind}`);
  const applied = await submitAutoTopUp(h.owner, { proposalId: proposal.value.proposalId, action: proposal.value.action, bounds: proposal.value.bounds }, signal(), "corr-1");
  if (!applied.ok) throw new Error(`change not applied: ${applied.refusal.kind}`);
}

/** Hold every rule status write (pause, resume, revoke) until released: the mutation stays PENDING. */
function holdStatusWrites(h: Harness): { readonly release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.store.setRuleStatus.bind(h.store);
  h.store.setRuleStatus = async (input) => {
    await gate;
    return original(input);
  };
  return { release: () => release() };
}

beforeEach(async () => {
  __resetDepositCoreForTests();
  __resetAgentDepositsForTests();
  __resetExecutorForTests();
  __resetRuleAuthorityForTests();
  __resetRuleProposalsForTests();
  await markRecoveryComplete(new MemoryFundingStore(), NOW);
});

describe("a rule withdrawn between the gate and the signature (R2)", () => {
  it("expiry during the nonce await: nothing signed, recorded refused, not counted", async () => {
    const h = setup();
    const r = h.store.seedRule({ expiresAt: new Date(NOW.getTime() + 10_000) });
    const intent = await prepared(h);
    h.world.port.beforeFinalCheck = () => {
      h.world.now = new Date(NOW.getTime() + 20_000);
    };
    const outcome = await confirm(h, intent.intentId, { kind: "none" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "rule_not_active" } });
    expect(outcome.ok ? "" : outcome.refusal.detail).toMatch(/expired while this top-up was being signed/);
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "refused", refusalKind: "rule_not_active", txHash: null })]);
    expect(await h.store.readRuleUsage(r.ruleId, h.world.now)).toEqual({ countLastDay: 0, sumLast30DaysWei: 0n });
  });

  it.each(["pause", "revoke", "edit"] as const)("%s committed during the nonce await: nothing signed, recorded refused, not unknown", async (action) => {
    const h = setup();
    const r = h.store.seedRule();
    const intent = await prepared(h, "5000");
    h.world.port.beforeFinalCheck = () => userChanges(h, action);
    const outcome = await confirm(h, intent.intentId, { kind: "none" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "rule_changed" } });
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "refused", refusalKind: "rule_changed" })]);
    expect(h.store.executions.some((row) => row.status === "unknown")).toBe(false);
    expect(await h.store.readRuleUsage(r.ruleId, NOW)).toEqual({ countLastDay: 0, sumLast30DaysWei: 0n });
  });

  it("the poller's execution obeys the same boundary: a revoke during the await refuses it", async () => {
    const h = setup();
    h.store.seedRule();
    h.world.account = accountWith({ availableWei: 1_000n * E18 });
    h.store.watch.set(ACCOUNT_ID, { accountId: ACCOUNT_ID, referenceWei: 100_000n * E18, lastBalanceWei: 100_000n * E18, belowAlert: false, lastCreditedDepositId: null, lastCreditedFinalizedAt: null });
    h.world.port.beforeFinalCheck = () => userChanges(h, "revoke");
    expect(await h.poller.tickNow()).toBe("refused");
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ authority: "auto_top_up_poller", status: "refused", refusalKind: "rule_changed" })]);
  });

  it("a change that lands AFTER the signature applies to the next top-up, not to the one already signed", async () => {
    const h = setup();
    h.store.seedRule({ maxPerDay: 5 });
    const intent = await prepared(h);
    expect(await confirm(h, intent.intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "executed", status: "confirmed" } });
    await userChanges(h, "pause");
    expect(await confirm(h, (await prepared(h)).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(1);
  });
});

describe("a rule mutation that is still pending (its durable write not settled)", () => {
  it("an admission while a pause is pending is refused before anything is recorded or signed", async () => {
    const h = setup();
    const r = h.store.seedRule();
    const intent = await prepared(h, "5000");
    const hold = holdStatusWrites(h);
    const pausing = userChanges(h, "pause");
    await vi.waitFor(() => expect(ruleMutationPending(r.ruleId)).toBe(true));
    // The stored row still reads active: only the pending mark can refuse here.
    expect(h.store.rules.get(r.ruleId)?.status).toBe("active");

    const outcome = await confirm(h, intent.intentId, { kind: "none" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "rule_changed" } });
    expect(outcome.ok ? "" : outcome.refusal.detail).toMatch(/being edited, paused or revoked right now/);
    expect(h.world.port.signed).toBe(0);
    expect(h.world.keyLoads).toBe(0);
    expect(h.store.executions).toHaveLength(0);

    hold.release();
    await pausing;
    expect(h.store.rules.get(r.ruleId)?.status).toBe("paused");
    expect(ruleMutationPending(r.ruleId)).toBe(false);
  });

  it("a final check while a revoke is pending is refused: nothing signed, recorded refused, not counted", async () => {
    const h = setup();
    const r = h.store.seedRule();
    const intent = await prepared(h, "5000");
    const hold = holdStatusWrites(h);
    let revoking: Promise<void> | null = null;
    h.world.port.beforeFinalCheck = async () => {
      revoking = userChanges(h, "revoke");
      await vi.waitFor(() => expect(ruleMutationPending(r.ruleId)).toBe(true));
    };
    const outcome = await confirm(h, intent.intentId, { kind: "none" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "rule_changed" } });
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "refused", refusalKind: "rule_changed", txHash: null })]);
    expect(await h.store.readRuleUsage(r.ruleId, NOW)).toEqual({ countLastDay: 0, sumLast30DaysWei: 0n });

    hold.release();
    await revoking;
    expect(h.store.rules.get(r.ruleId)?.status).toBe("revoked");
  });

  it("a pause that begins after the final check passed does not block or undo that top-up, and applies to the next one", async () => {
    const h = setup();
    const r = h.store.seedRule({ maxPerDay: 5 });
    const intent = await prepared(h, "5000");
    const hold = holdStatusWrites(h);
    let pausing: Promise<void> | null = null;
    h.world.port.afterSign = () => {
      pausing = userChanges(h, "pause");
    };
    // The execution finishes while the pause is still pending: neither waits for the other.
    expect(await confirm(h, intent.intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "executed", status: "confirmed" } });
    h.world.port.afterSign = null;
    await vi.waitFor(() => expect(ruleMutationPending(r.ruleId)).toBe(true));

    // While it is pending, the next top-up is refused before admission.
    expect(await confirm(h, (await prepared(h, "5000")).intentId, { kind: "none" })).toMatchObject({ ok: false, refusal: { kind: "rule_changed" } });

    hold.release();
    await pausing;
    expect(h.store.rules.get(r.ruleId)?.status).toBe("paused");
    // Once it committed, the next top-up is no longer covered by the rule: the card is raised.
    expect(await confirm(h, (await prepared(h, "5000")).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(1);
  });
});

describe("the network fee ceiling (R3)", () => {
  it("the poller refuses a plan above the ceiling, the rule reads suspended, and it does not retry every tick", async () => {
    const h = setup();
    // The scripted plan's fee bound is 180,000 gas at 0.04 gwei = 7.2e12 wei; the ceiling is lower.
    const r = h.store.seedRule({ maxNetworkFeeWei: 5n * 10n ** 12n });
    h.world.account = accountWith({ availableWei: 1_000n * E18 });
    h.store.watch.set(ACCOUNT_ID, { accountId: ACCOUNT_ID, referenceWei: 100_000n * E18, lastBalanceWei: 100_000n * E18, belowAlert: false, lastCreditedDepositId: null, lastCreditedFinalizedAt: null });

    expect(await h.poller.tickNow()).toBe("refused");
    expect(h.world.port.signed).toBe(0);
    expect(h.world.keyLoads).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "refused", refusalKind: "network_fee_above_limit" })]);
    const view = await ruleView(h.owner, await h.store.readRule(r.ruleId).then((row) => {
      if (row === null) throw new Error("rule gone");
      return row;
    }), true);
    expect(view).toMatchObject({ state: "suspended", suspendedReason: "network_fee_above_limit", maxNetworkFeeWei: String(5n * 10n ** 12n) });

    // Within the retry interval: no new attempt, no new row.
    expect(await h.poller.tickNow()).toBe("suspended");
    expect(h.store.executions).toHaveLength(1);

    // After it, with the fee back under the ceiling, it tops up and the suspension clears.
    h.world.now = new Date(NOW.getTime() + FEE_RETRY_AFTER_MS + 1);
    h.store.rules.set(r.ruleId, { ...r, maxNetworkFeeWei: 10n ** 14n, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000) });
    expect(await h.poller.tickNow()).toBe("executed");
    expect(h.poller.snapshot().networkFeeAboveLimit).toBeNull();
  });

  it("an agent deposit whose fee bound is above the ceiling is not covered: the card is raised, nothing signed", async () => {
    const h = setup();
    h.store.seedRule({ maxNetworkFeeWei: 5n * 10n ** 12n });
    const intent = await prepared(h);
    expect(intent.autoTopUp).toEqual({ covered: false, reason: "the network fee bound is above the auto top-up rule's network fee limit" });
    expect(await confirm(h, intent.intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toHaveLength(0);
  });

  it("the request about to be signed is held to the ceiling too: a node-filled fee above it refuses at the gate, before the key", async () => {
    const h = setup();
    h.store.seedRule({ maxNetworkFeeWei: 10n ** 13n });
    const intent = await prepared(h);
    // 90,000 gas at 0.2 gwei = 1.8e13 wei, above the 1e13 ceiling (the plan's 7.2e12 bound fitted).
    h.world.port.signedMaxFeePerGas = 200_000_000n;
    const outcome = await confirm(h, intent.intentId, { kind: "none" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "network_fee_above_limit" } });
    expect(outcome.ok ? "" : outcome.refusal.detail).toMatch(/^The network fee is above your auto top-up limit/);
    expect(h.world.keyLoads).toBe(0);
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "refused", refusalKind: "network_fee_above_limit" })]);
  });

  it("a rule without a ceiling (approved before migration 179) spends nothing", async () => {
    const h = setup();
    h.store.seedRule({ maxNetworkFeeWei: null });
    h.world.account = accountWith({ availableWei: 1_000n * E18 });
    h.store.watch.set(ACCOUNT_ID, { accountId: ACCOUNT_ID, referenceWei: 100_000n * E18, lastBalanceWei: 100_000n * E18, belowAlert: false, lastCreditedDepositId: null, lastCreditedFinalizedAt: null });
    expect(await h.poller.tickNow()).toBe("suspended");
    expect(await confirm(h, (await prepared(h)).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(0);
  });
});

describe("a retired intent (R1, the main-process half)", () => {
  it("once its card was rejected it can never be signed, under any authority", async () => {
    const h = setup();
    h.store.seedRule();
    const intent = await prepared(h);
    retireAgentDeposit(h.agent, "session-b", intent.intentId);
    expect(peekAgentDeposit(h.agent, SESSION, intent.intentId).ok).toBe(true);
    retireAgentDeposit(h.agent, SESSION, intent.intentId);
    expect(peekAgentDeposit(h.agent, SESSION, intent.intentId)).toMatchObject({ ok: false, refusal: { kind: "proposal_missing" } });
    for (const authority of [{ kind: "none" }, { kind: "full_permission" }, { kind: "approved_card", approvalId: "approval-1" }] as const) {
      expect(await confirm(h, intent.intentId, authority)).toMatchObject({ ok: false, refusal: { kind: "proposal_missing" } });
    }
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toHaveLength(0);
  });
});
