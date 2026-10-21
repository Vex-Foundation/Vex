/**
 * The agent deposit owner, the recorded execution owner and the auto top-up
 * poller over the REAL shared deposit core (every pre-sign and final check),
 * with a scripted chain port that walks the real hook order and an in-memory
 * store implementing the repository contract.
 *
 * Proves: which authority executes and which raises a card; that a rule's
 * caps are shared by the poller and the agent and count unknown outcomes;
 * that an unknown outcome is never re-sent; that recovery, quit, a paused
 * rule and a wallet scope change refuse before anything is signed; that one
 * prepared intent is single use and session bound.
 *
 * Does not prove the Postgres lock or index (migration 178), nor the chain
 * (see `agent-deposit-anvil-fork.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { __resetDepositCoreForTests } = await import("../funding/deposit-core.js");
const { __resetAgentDepositsForTests, confirmAgentDeposit, peekAgentDeposit, prepareAgentDeposit } = await import("../funding/agent-deposit.js");
const { __resetExecutorForTests, markRecoveryComplete } = await import("../auto-top-up/executor.js");
const { createAutoTopUpPoller } = await import("../auto-top-up/poller.js");
const { accountWith, ACCOUNT_ID, depositWorld, E18, MemoryFundingStore, NOW, OTHER_WALLET, TX_HASH, WALLET } = await import("./support/funding-fakes.js");
import type { AgentDepositRuntimeAuthority } from "@vex-agent/tools/internal/vex-inference/host.js";
import type { LiveConditions } from "../runtime.js";

const SESSION = "session-a";
const signal = (): AbortSignal => new AbortController().signal;

function setup() {
  const world = depositWorld();
  const store = new MemoryFundingStore();
  const live: { quitting: boolean; signedInAccountId: string | null } = { quitting: false, signedInAccountId: ACCOUNT_ID };
  const conditions = (): LiveConditions => ({
    now: world.now,
    vaultUnlocked: world.vaultUnlocked,
    quitting: live.quitting,
    executionReady: world.executionReady,
    signedInAccountId: live.signedInAccountId,
  });
  const agent = { deposit: world.deps, store, conditions };
  return { world, store, live, agent };
}

async function prepared(h: ReturnType<typeof setup>, amount = "6000", wallet: string = WALLET) {
  const outcome = await prepareAgentDeposit(h.agent, { sessionId: SESSION, walletAddress: wallet, amount: { unit: "VEX", value: amount } }, signal());
  if (!outcome.ok) throw new Error(`prepare refused: ${outcome.refusal.kind}: ${outcome.refusal.detail}`);
  return outcome.value;
}

function confirm(h: ReturnType<typeof setup>, intentId: string, authority: AgentDepositRuntimeAuthority, allowed: (a: string) => string | null = () => null) {
  return confirmAgentDeposit(h.agent, { sessionId: SESSION, intentId, authority, sourceWalletStillAllowed: allowed }, signal());
}

beforeEach(async () => {
  __resetDepositCoreForTests();
  __resetAgentDepositsForTests();
  __resetExecutorForTests();
  await markRecoveryComplete(new MemoryFundingStore(), NOW);
});

describe("prepare", () => {
  it("binds the pinned destination, VEX on 4663, every fee bound, and reports no rule coverage", async () => {
    const h = setup();
    const intent = await prepared(h);
    expect(intent).toMatchObject({
      chainId: 4663,
      token: { symbol: "VEX", decimals: 18 },
      amount: { wei: String(6_000n * E18), vex: "6000", usdEstimate: "6" },
      from: WALLET,
      autoTopUp: { covered: false, reason: "no auto top-up rule exists" },
    });
    expect(intent.depositAddress.toLowerCase()).toBe(h.world.pinned?.toLowerCase());
    expect(BigInt(intent.networkFee.maxNetworkFeeWei)).toBeGreaterThan(0n);
    expect(intent.intentId).toMatch(/^vxdep-[0-9a-f-]{36}$/);
  });

  it("converts USD at the backend rate rounding UP to whole wei", async () => {
    const h = setup();
    const outcome = await prepareAgentDeposit(h.agent, { sessionId: SESSION, walletAddress: WALLET, amount: { unit: "USD", value: "5.000001" } }, signal());
    if (!outcome.ok) throw new Error(outcome.refusal.detail);
    // 5,000,001 micro-USD at 10^15 wei per micro-USD.
    expect(outcome.value.amount.wei).toBe(String(5_000_001n * 10n ** 15n));
  });

  it("refuses an unlinked wallet, a mismatched backend deposit address and an amount under the minimum, before any intent exists", async () => {
    const h = setup();
    h.world.account = accountWith({ linked: [] });
    expect((await prepareAgentDeposit(h.agent, { sessionId: SESSION, walletAddress: WALLET, amount: { unit: "VEX", value: "6000" } }, signal()))).toMatchObject({ ok: false, refusal: { kind: "sender_not_linked" } });
    h.world.account = accountWith({ depositAddress: OTHER_WALLET });
    expect((await prepareAgentDeposit(h.agent, { sessionId: SESSION, walletAddress: WALLET, amount: { unit: "VEX", value: "6000" } }, signal()))).toMatchObject({ ok: false, refusal: { kind: "deposit_address_mismatch" } });
    h.world.account = accountWith();
    expect((await prepareAgentDeposit(h.agent, { sessionId: SESSION, walletAddress: WALLET, amount: { unit: "VEX", value: "4999.999" } }, signal()))).toMatchObject({ ok: false, refusal: { kind: "below_minimum" } });
    expect(h.world.keyLoads).toBe(0);
  });
});

describe("authority", () => {
  it("restricted with no rule: needs_user_approval, nothing signed, the intent kept for the approved resume", async () => {
    const h = setup();
    const intent = await prepared(h);
    const asked = await confirm(h, intent.intentId, { kind: "none" });
    expect(asked).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.keyLoads).toBe(0);
    expect(h.store.executions).toHaveLength(0);
    expect(peekAgentDeposit(h.agent, SESSION, intent.intentId).ok).toBe(true);

    const approved = await confirm(h, intent.intentId, { kind: "approved_card", approvalId: "approval-1" });
    expect(approved).toMatchObject({ ok: true, value: { kind: "executed", status: "confirmed", transferProven: true, authority: "approved_card", ruleId: null } });
    expect(h.store.executions).toEqual([expect.objectContaining({ authority: "agent_card", status: "confirmed", txHash: TX_HASH, ruleId: null })]);
    expect(h.world.notified).toEqual([TX_HASH]);
  });

  it("an intent is single use and invisible to another session", async () => {
    const h = setup();
    const intent = await prepared(h);
    expect(peekAgentDeposit(h.agent, "session-b", intent.intentId)).toMatchObject({ ok: false, refusal: { kind: "proposal_missing" } });
    expect(await confirm(h, intent.intentId, { kind: "full_permission" })).toMatchObject({ ok: true, value: { kind: "executed", authority: "full_permission" } });
    expect(await confirm(h, intent.intentId, { kind: "full_permission" })).toMatchObject({ ok: false, refusal: { kind: "proposal_missing" } });
    expect(h.world.port.signed).toBe(1);
  });

  it("an active rule covers the agent without a card, and its daily count is shared with the poller", async () => {
    const h = setup();
    const r = h.store.seedRule({ maxPerDay: 2 });
    const first = await confirm(h, (await prepared(h)).intentId, { kind: "none" });
    expect(first).toMatchObject({ ok: true, value: { kind: "executed", authority: "auto_top_up_rule", ruleId: r.ruleId } });

    // The poller spends the second slot of the day.
    h.world.account = accountWith({ availableWei: 0n });
    h.store.watch.set(ACCOUNT_ID, { accountId: ACCOUNT_ID, referenceWei: 1_000n * E18, lastBalanceWei: 1_000n * E18, belowAlert: false, lastCreditedDepositId: null });
    const poller = createAutoTopUpPoller({ deposit: h.world.deps, store: h.store, conditions: h.agent.conditions, api: { readAccount: h.world.deps.api.readAccount, listDeposits: async () => ({ ok: true, value: { items: [], next_cursor: null } }) }, watch: { store: h.store, emitCrossing: () => undefined }, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t) });
    expect(await poller.tickNow()).toBe("executed");

    const third = await confirm(h, (await prepared(h)).intentId, { kind: "none" });
    expect(third).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(2);
    expect(h.store.executions.map((row) => row.authority)).toEqual(["auto_top_up_agent", "auto_top_up_poller"]);
  });

  it("a rule never covers more than its per-top-up amount or another wallet", async () => {
    const h = setup();
    h.store.seedRule({ amountWei: 6_000n * E18 });
    h.world.account = accountWith({ linked: [WALLET.toLowerCase(), OTHER_WALLET.toLowerCase()] });
    expect(await confirm(h, (await prepared(h, "6000.000000000000000001")).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(await confirm(h, (await prepared(h, "6000", OTHER_WALLET)).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(0);
  });
});

describe("unknown outcomes and the signing boundary", () => {
  it("an ambiguous broadcast is pending, recorded unknown, counted against the cap, and never re-sent", async () => {
    const h = setup();
    h.store.seedRule({ maxPerDay: 1 });
    h.world.port.outcome = "ambiguous";
    const first = await confirm(h, (await prepared(h)).intentId, { kind: "none" });
    expect(first).toMatchObject({ ok: true, value: { kind: "executed", status: "pending" } });
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "unknown", txHash: TX_HASH })]);
    expect(h.world.port.signed).toBe(1);
    h.world.port.outcome = "confirmed";
    expect(await confirm(h, (await prepared(h)).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(h.world.port.signed).toBe(1);
  });

  it("a rule paused after admission refuses at the pre-sign gate: no key, nothing signed, the row refused and not counted", async () => {
    const h = setup();
    const r = h.store.seedRule();
    h.world.port.beforeGate = () => {
      const current = h.store.rules.get(r.ruleId);
      if (current !== undefined) h.store.rules.set(r.ruleId, { ...current, status: "paused", version: current.version + 1 });
    };
    const outcome = await confirm(h, (await prepared(h)).intentId, { kind: "none" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "rule_not_active" } });
    expect(h.world.keyLoads).toBe(0);
    expect(h.world.port.signed).toBe(0);
    expect(h.store.executions).toEqual([expect.objectContaining({ status: "refused", refusalKind: "rule_not_active" })]);
    expect(await h.store.readRuleUsage(r.ruleId, NOW)).toEqual({ countLastDay: 0, sumLast30DaysWei: 0n });
  });

  it("a quit or a wallet scope change arriving after the key refuses in the final check, nothing signed", async () => {
    const h = setup();
    h.store.seedRule();
    h.world.port.beforeFinalCheck = () => {
      h.live.quitting = true;
    };
    expect(await confirm(h, (await prepared(h)).intentId, { kind: "none" })).toMatchObject({ ok: false, refusal: { kind: "execution_not_ready" } });
    h.live.quitting = false;
    h.world.port.beforeFinalCheck = null;
    const scope = await confirm(h, (await prepared(h)).intentId, { kind: "approved_card", approvalId: null }, () => "The wallet selected for this session changed before signing.");
    expect(scope).toMatchObject({ ok: false, refusal: { kind: "wallet_not_in_inventory" } });
    expect(h.world.port.signed).toBe(0);
  });

  it("until recovery ran, no recorded execution is admitted", async () => {
    __resetExecutorForTests();
    const h = setup();
    const outcome = await confirm(h, (await prepared(h)).intentId, { kind: "full_permission" });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "execution_not_ready" } });
    expect(h.store.executions).toHaveLength(0);
  });

  it("recovery marks a previous process's undecided rows unknown, and they still count", async () => {
    __resetExecutorForTests();
    const h = setup();
    const r = h.store.seedRule({ maxPerDay: 1 });
    await h.store.askExecution({ executionId: "vxexec-00000000-0000-4000-8000-000000000009", ruleId: r.ruleId, authority: "auto_top_up_poller", sessionId: null, sourceWallet: WALLET, depositAddress: WALLET, amountWei: 6_000n * E18 }, null, NOW);
    await markRecoveryComplete(h.store, NOW);
    expect(h.store.executions[0]).toMatchObject({ status: "unknown", refusalKind: "process_restarted" });
    expect(await confirm(h, (await prepared(h)).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
  });
});

describe("poller", () => {
  function poller(h: ReturnType<typeof setup>) {
    return createAutoTopUpPoller({
      deposit: h.world.deps,
      store: h.store,
      conditions: h.agent.conditions,
      api: { readAccount: h.world.deps.api.readAccount, listDeposits: async () => ({ ok: true, value: { items: [], next_cursor: null } }) },
      watch: { store: h.store, emitCrossing: () => undefined },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
    });
  }

  it("tops up once when the balance is below the alert, and not when it is above", async () => {
    const h = setup();
    h.store.seedRule();
    const p = poller(h);
    h.world.account = accountWith({ availableWei: 100_000n * E18 });
    expect(await p.tickNow()).toBe("not_triggered");
    h.world.account = accountWith({ availableWei: 10_000n * E18 });
    expect(await p.tickNow()).toBe("executed");
    expect(h.store.executions).toEqual([expect.objectContaining({ authority: "auto_top_up_poller", status: "confirmed", amountWei: 6_000n * E18 })]);
  });

  it("a concurrent tick joins the running one instead of signing twice", async () => {
    const h = setup();
    h.store.seedRule({ maxPerDay: 5 });
    h.store.watch.set(ACCOUNT_ID, { accountId: ACCOUNT_ID, referenceWei: 100_000n * E18, lastBalanceWei: 100_000n * E18, belowAlert: false, lastCreditedDepositId: null });
    h.world.account = accountWith({ availableWei: 1_000n * E18 });
    const p = poller(h);
    const [a, b] = await Promise.all([p.tickNow(), p.tickNow()]);
    expect([a, b]).toEqual(["executed", "executed"]);
    expect(h.world.port.signed).toBe(1);
  });

  it("does nothing while the vault is locked, and a failing balance read sends nothing", async () => {
    const h = setup();
    h.store.seedRule();
    const p = poller(h);
    h.world.vaultUnlocked = false;
    expect(await p.tickNow()).toBe("skipped_not_ready");
    h.world.vaultUnlocked = true;
    const failing = createAutoTopUpPoller({
      deposit: h.world.deps,
      store: h.store,
      conditions: h.agent.conditions,
      api: { readAccount: async () => ({ ok: false, failure: { kind: "unavailable", status: 503 } }), listDeposits: async () => ({ ok: true, value: { items: [], next_cursor: null } }) },
      watch: { store: h.store, emitCrossing: () => undefined },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
    });
    expect(await failing.tickNow()).toBe("balance_read_failing");
    expect(failing.snapshot().balanceReadFailing).toBe(true);
    expect(h.world.port.signed).toBe(0);
  });

  it("stop closes admission and drains an in-flight tick", async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const p = poller(h);
      p.start();
      await p.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(p.snapshot()).toMatchObject({ running: false, lastTickAt: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
