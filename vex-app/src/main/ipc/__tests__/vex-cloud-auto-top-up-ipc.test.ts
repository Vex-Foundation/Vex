/**
 * The low-balance alert and auto top-up channels through `registerHandler`:
 * strict schemas, sender validation, the execution gate on the one channel
 * that creates authority, cancellation, and the form-is-the-approval round
 * trip (prepare mints every bound, submit refuses an echo that differs).
 *
 * REAL: the handlers, the rule owner, the policy, the deposit core's reads.
 * FAKED: Electron, the gateway (a fixed account), the store (in memory, the
 * repository contract).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

const assertTrustedSender = vi.fn<(event: unknown) => void>(() => undefined);
vi.mock("../sender-validation.js", () => ({
  assertTrustedSender: (event: unknown) => assertTrustedSender(event),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../vex-cloud/production.js", () => ({
  productionVexCloudDeps: () => {
    throw new Error("production deps must not be used in this suite");
  },
}));

const { CH } = await import("@shared/ipc/channels.js");
const { openExecutionGate } = await import("../../lifecycle/execution-gate.js");
const { registerVexCloudHandlers } = await import("../vex-cloud.js");
const { getCancelController } = await import("../register-handler.js");
const { composeVexInferenceRuntime } = await import("../../vex-cloud/runtime.js");
const { __resetRuleProposalsForTests } = await import("../../vex-cloud/auto-top-up/rule-proposals.js");
const { ACCOUNT_ID, accountWith, depositWorld, E18, MemoryFundingStore, NOW, WALLET } = await import("../../vex-cloud/__tests__/support/funding-fakes.js");
import type { VexCloudApi, VexCloudCall, VexCloudAccountResponse } from "../../vex-cloud/api-client.js";
import type { VexCloudDeps } from "../../vex-cloud/production.js";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

/** The Result envelope `registerHandler` answers with, read loosely (the strict schemas are main's). */
const resultSchema = z.object({
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
});

function mount() {
  const world = depositWorld();
  const store = new MemoryFundingStore();
  let accountGate: Promise<void> | null = null;
  let accountCalls = 0;
  let backendDown = false;
  const notUsed = async (): Promise<never> => {
    throw new Error("not used in this suite");
  };
  const api: VexCloudApi = {
    issueNonce: notUsed,
    verify: notUsed,
    readAccount: async (_bearer, signal): Promise<VexCloudCall<VexCloudAccountResponse>> => {
      accountCalls += 1;
      if (accountGate !== null) await accountGate;
      if (backendDown) return { ok: false, failure: { kind: "unavailable", status: 503 } };
      if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };
      return { ok: true, value: world.account };
    },
    listActivity: notUsed,
    listUsage: notUsed,
    listDeposits: notUsed,
    listModels: notUsed,
    notifyDeposit: notUsed,
    createWithdrawal: notUsed,
    readWithdrawal: notUsed,
    claimCashbackToBalance: notUsed,
  };
  const deps: VexCloudDeps = {
    api,
    signIn: { listEvmWallets: () => [], isVaultUnlocked: () => true, signMessage: notUsed, binding: () => {
      throw new Error("not used in this suite");
    }, storeSession: notUsed, now: () => NOW },
    account: { readSession: world.deps.readSession, clearSession: world.deps.clearSession, localWallets: () => [WALLET], pinnedDepositAddress: world.deps.pinnedDepositAddress, now: () => NOW },
    clearSession: world.deps.clearSession,
    deposit: {
      chain: world.deps.chain,
      listEvmWallets: world.deps.listEvmWallets,
      isVaultUnlocked: world.deps.isVaultUnlocked,
      isExecutionReady: world.deps.isExecutionReady,
      pinnedDepositAddress: world.deps.pinnedDepositAddress,
      loadPrivateKey: world.deps.loadPrivateKey,
      now: world.deps.now,
    },
  };
  const runtime = composeVexInferenceRuntime(deps, {
    store,
    conditions: () => ({ now: NOW, vaultUnlocked: true, quitting: false, executionReady: true, signedInAccountId: ACCOUNT_ID }),
  });
  for (const teardown of registerVexCloudHandlers(deps, runtime)) void teardown;
  return {
    world,
    store,
    holdAccount: (gate: Promise<void>) => {
      accountGate = gate;
    },
    accountCalls: () => accountCalls,
    takeBackendDown: () => {
      backendDown = true;
    },
  };
}

async function call(channel: string, payload: unknown): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  const result = await fn({ sender: {} }, { requestId: REQUEST_ID, payload });
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) throw new Error("not a Result envelope");
  return parsed.data;
}

const FIELDS = { sourceWallet: WALLET, amountText: "6000", maxPerDay: 2, monthlyCapText: "12000", maxNetworkFeeText: "0.0001", expiresInDays: 30 };

beforeEach(() => {
  handlers.clear();
  __resetRuleProposalsForTests();
  assertTrustedSender.mockImplementation(() => undefined);
  openExecutionGate();
});

describe("alert", () => {
  it("defaults to 20, saves a valid percent, and refuses one outside 1 to 90 by schema", async () => {
    mount();
    expect(await call(CH.vexCloud.alertGet, {})).toMatchObject({ ok: true, data: { alertPercent: 20, observation: null } });
    expect(await call(CH.vexCloud.alertSet, { alertPercent: 35 })).toMatchObject({ ok: true, data: { alertPercent: 35 } });
    for (const bad of [0, 91, 12.5, "30"]) {
      expect(await call(CH.vexCloud.alertSet, { alertPercent: bad })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    }
    expect(await call(CH.vexCloud.alertSet, { alertPercent: 30, extra: true })).toMatchObject({ ok: false });
  });
});

describe("rule round trip", () => {
  it("prepare carries every bound and the pinned destination; submit with the same echo creates the rule", async () => {
    const w = mount();
    const prepared = await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS });
    expect(prepared).toMatchObject({
      ok: true,
      data: {
        action: "create",
        chainId: 4663,
        bounds: { sourceWallet: WALLET, amountWei: String(6_000n * E18), maxPerDay: 2, monthlyCapWei: String(12_000n * E18), maxNetworkFeeWei: "100000000000000", trigger: "below_alert_percent", alertPercent: 20 },
      },
    });
    const proposal = prepared.data;
    if (proposal === undefined) throw new Error("no proposal");
    expect(String(proposal.depositAddress).toLowerCase()).toBe(w.world.pinned?.toLowerCase());
    expect(w.store.rules.size).toBe(0);
    const submitted = await call(CH.vexCloud.submitAutoTopUp, { proposalId: proposal.proposalId, action: "create", bounds: proposal.bounds });
    expect(submitted).toMatchObject({ ok: true, data: { rule: { state: "active", maxPerDay: 2, maxNetworkFeeWei: "100000000000000" } } });
    expect(w.store.rules.size).toBe(1);
    expect([...w.store.rules.values()][0]?.maxNetworkFeeWei).toBe(10n ** 14n);
  });

  it("refuses a network fee limit of zero, above 0.01 ETH, or not a decimal, and a lowered fee echo", async () => {
    const w = mount();
    for (const maxNetworkFeeText of ["0", "0.010000000000000001", "1e-4"]) {
      expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: { ...FIELDS, maxNetworkFeeText } })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    }
    const proposal = (await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS })).data;
    if (proposal === undefined || typeof proposal.bounds !== "object" || proposal.bounds === null) throw new Error("no proposal");
    const raised = { ...proposal.bounds, maxNetworkFeeWei: "1000000000000000" };
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: proposal.proposalId, action: "create", bounds: raised })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(w.store.rules.size).toBe(0);
  });

  it("pause and revoke work while Vex Inference is unreachable and has no rate: from the stored rule alone", async () => {
    const w = mount();
    const r = w.store.seedRule();
    w.world.account = { ...accountWith(), rate: { available: false, reason: "no_price" } };
    w.takeBackendDown();
    // A change that ENABLES spending still needs the backend.
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS })).toMatchObject({ ok: false, error: { code: "provider.unavailable" } });
    const callsBefore = w.accountCalls();

    const pause = (await call(CH.vexCloud.prepareAutoTopUp, { action: "pause", ruleId: r.ruleId, expectedVersion: 1 })).data;
    if (pause === undefined) throw new Error("pause not prepared");
    expect(pause).toMatchObject({ action: "pause", minimumWei: null, minimumMicroUsd: null, amountUsdMicroEstimate: null });
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: pause.proposalId, action: "pause", bounds: pause.bounds })).toMatchObject({ ok: true, data: { rule: { state: "suspended", suspendedReason: "user_paused", version: 2 } } });

    const revoke = (await call(CH.vexCloud.prepareAutoTopUp, { action: "revoke", ruleId: r.ruleId, expectedVersion: 2 })).data;
    if (revoke === undefined) throw new Error("revoke not prepared");
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: revoke.proposalId, action: "revoke", bounds: revoke.bounds })).toMatchObject({ ok: true, data: { rule: { state: "revoked" } } });
    expect(w.store.rules.get(r.ruleId)?.status).toBe("revoked");
    expect(w.accountCalls()).toBe(callsBefore);

    // The tab still shows the rule from local state while the backend is down.
    w.store.seedRule({ ruleId: "vxrule-00000000-0000-4000-8000-000000000002" });
    expect(await call(CH.vexCloud.autoTopUpGet, {})).toMatchObject({ ok: true, data: { rule: { ruleId: "vxrule-00000000-0000-4000-8000-000000000002", state: "suspended", suspendedReason: "balance_read_failing" } } });
  });

  it("with the account read failing, the page's reads and stops still work and every spending change is refused", async () => {
    const w = mount();
    const r = w.store.seedRule();
    // Prime the locally known account, then the backend goes down.
    expect(await call(CH.vexCloud.account, {})).toMatchObject({ ok: true, data: { state: "signed_in" } });
    w.takeBackendDown();
    expect(await call(CH.vexCloud.account, {})).toMatchObject({ ok: false });
    expect(await call(CH.vexCloud.autoTopUpGet, {})).toMatchObject({ ok: true, data: { rule: { ruleId: r.ruleId, state: "suspended", suspendedReason: "balance_read_failing" } } });

    // Spending changes need the account: refused, nothing stored.
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "edit", ruleId: r.ruleId, expectedVersion: 1, fields: FIELDS })).toMatchObject({ ok: false, error: { code: "provider.unavailable" } });
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS })).toMatchObject({ ok: false, error: { code: "provider.unavailable" } });

    const pause = (await call(CH.vexCloud.prepareAutoTopUp, { action: "pause", ruleId: r.ruleId, expectedVersion: 1 })).data;
    if (pause === undefined) throw new Error("pause not prepared");
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: pause.proposalId, action: "pause", bounds: pause.bounds })).toMatchObject({ ok: true, data: { rule: { suspendedReason: "user_paused", version: 2 } } });
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "resume", ruleId: r.ruleId, expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: "provider.unavailable" } });
    expect(w.store.rules.get(r.ruleId)).toMatchObject({ status: "paused", version: 2 });

    const revoke = (await call(CH.vexCloud.prepareAutoTopUp, { action: "revoke", ruleId: r.ruleId, expectedVersion: 2 })).data;
    if (revoke === undefined) throw new Error("revoke not prepared");
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: revoke.proposalId, action: "revoke", bounds: revoke.bounds })).toMatchObject({ ok: true, data: { rule: { state: "revoked" } } });
    expect(w.store.rules.get(r.ruleId)?.status).toBe("revoked");
  });

  it("a submit whose echoed bounds differ from the card changes nothing", async () => {
    const w = mount();
    const prepared = await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS });
    const proposal = prepared.data;
    if (proposal === undefined || typeof proposal.bounds !== "object" || proposal.bounds === null) throw new Error("no proposal");
    const widened = { ...proposal.bounds, monthlyCapWei: String(1_000_000n * E18) };
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: proposal.proposalId, action: "create", bounds: widened })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(w.store.rules.size).toBe(0);
  });

  it("refuses an unlinked source wallet, an amount under the $5 minimum and an expiry past 90 days", async () => {
    const w = mount();
    w.world.account = accountWith({ linked: [] });
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS })).toMatchObject({ ok: false, error: { code: "permissions.denied" } });
    w.world.account = accountWith();
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: { ...FIELDS, amountText: "4999" } })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: { ...FIELDS, expiresInDays: 91 } })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
  });

  it("pause, then a stale version is refused, then resume and revoke each need their own card", async () => {
    const w = mount();
    const r = w.store.seedRule();
    const pause = await call(CH.vexCloud.prepareAutoTopUp, { action: "pause", ruleId: r.ruleId, expectedVersion: 1 });
    const p = pause.data;
    if (p === undefined) throw new Error("no proposal");
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: p.proposalId, action: "pause", bounds: p.bounds })).toMatchObject({ ok: true, data: { rule: { state: "suspended", suspendedReason: "user_paused", version: 2 } } });
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "resume", ruleId: r.ruleId, expectedVersion: 1 })).toMatchObject({ ok: false });
    const revoke = (await call(CH.vexCloud.prepareAutoTopUp, { action: "revoke", ruleId: r.ruleId, expectedVersion: 2 })).data;
    if (revoke === undefined) throw new Error("no proposal");
    expect(await call(CH.vexCloud.submitAutoTopUp, { proposalId: revoke.proposalId, action: "revoke", bounds: revoke.bounds })).toMatchObject({ ok: true, data: { rule: { state: "revoked" } } });
  });
});

describe("boundary", () => {
  it.each([
    [CH.vexCloud.alertGet, {}],
    [CH.vexCloud.alertSet, { alertPercent: 30 }],
    [CH.vexCloud.autoTopUpGet, {}],
    [CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS }],
    [CH.vexCloud.submitAutoTopUp, { proposalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", action: "create", bounds: { sourceWallet: WALLET, amountWei: "1", maxPerDay: 1, monthlyCapWei: "1", maxNetworkFeeWei: "1", trigger: "below_alert_percent", alertPercent: 20, expiresAt: NOW.toISOString() } }],
  ] as const)("%s refuses an untrusted sender before any work", async (channel, payload) => {
    const w = mount();
    assertTrustedSender.mockImplementation(() => {
      throw new Error("Untrusted IPC sender: subframe of https://evil.example/frame");
    });
    const result = await call(channel, payload);
    expect(result).toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    expect(result.error?.message).not.toContain("evil.example");
    expect(w.accountCalls()).toBe(0);
    expect(w.store.rules.size).toBe(0);
  });

  it("a prepare carrying a destination field is refused by schema", async () => {
    mount();
    expect(await call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: { ...FIELDS, depositAddress: WALLET } })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
  });

  it("a cancelled prepare is cancelled and mints nothing", async () => {
    const w = mount();
    let release: () => void = () => undefined;
    w.holdAccount(new Promise<void>((resolve) => {
      release = resolve;
    }));
    const pending = call(CH.vexCloud.prepareAutoTopUp, { action: "create", fields: FIELDS });
    await vi.waitFor(() => expect(w.accountCalls()).toBe(1));
    getCancelController(REQUEST_ID)?.abort();
    release();
    expect(await pending).toMatchObject({ ok: false, error: { code: "internal.cancelled" } });
  });

  it("submitAutoTopUp is execution-gated", async () => {
    const { EXECUTION_GATED_CHANNELS } = await import("../../lifecycle/execution-gate.js");
    expect(EXECUTION_GATED_CHANNELS.has(CH.vexCloud.submitAutoTopUp)).toBe(true);
    expect(EXECUTION_GATED_CHANNELS.has(CH.vexCloud.alertSet)).toBe(false);
  });
});
