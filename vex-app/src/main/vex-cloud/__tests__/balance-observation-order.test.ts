/**
 * The low-balance watch's observation order over the REAL status read
 * (`readVexInferenceStatus`), the real watch and generations, and a scripted
 * backend whose deposits page can be held.
 *
 * Proves: an observation (a deposits page plus a balance read) is ordered as
 * a WHOLE, for both observers (the status read and the poller's tick). An
 * observation whose deposits page is delayed, and which therefore
 * carries an older credited deposit A, landing after another read already
 * recorded the newer credit B, is discarded: the marker stays B and the
 * reference is not reset to the lower current balance. Normal progression
 * (a newer credit C) still resets the reference.
 *
 * Does not prove the Postgres row lock (the integration suite) nor the
 * backend's page ordering (no backend is reachable from this suite).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { readVexInferenceStatus } = await import("../status.js");
const { createAutoTopUpPoller } = await import("../auto-top-up/poller.js");
const { __resetExecutorForTests } = await import("../auto-top-up/executor.js");
const { createObservationGenerations } = await import("../balance-watch.js");
const { accountWith, ACCOUNT_ID, DEPOSIT, depositWorld, E18, MemoryFundingStore, NOW, WALLET } = await import("./support/funding-fakes.js");
import type { DepositsPage, VexCloudApi } from "../api-client.js";
import type { StatusDeps } from "../status.js";

type DepositItem = DepositsPage["items"][number];

function creditedDeposit(id: string, minutesAfterNow: number): DepositItem {
  const at = new Date(NOW.getTime() + minutesAfterNow * 60_000).toISOString();
  return {
    id,
    tx_hash: `0x${id.slice(-1).repeat(64)}`,
    log_index: 0,
    from: WALLET.toLowerCase(),
    amount_wei: String(5_000n * E18),
    status: "credited",
    spendable_now_wei: String(5_000n * E18),
    observed_at: at,
    finalized_at: at,
  };
}

const A = creditedDeposit("dep_a", 1);
const B = creditedDeposit("dep_b", 2);
const C = creditedDeposit("dep_c", 3);

interface Backend {
  balanceWei: bigint;
  /** Each deposits read takes the next scripted answer: a page, or a held promise of one. */
  readonly pages: Array<Promise<readonly DepositItem[]>>;
  depositReads: number;
}

function harness() {
  const store = new MemoryFundingStore();
  const backend: Backend = { balanceWei: 0n, pages: [], depositReads: 0 };
  const notUsed = async (): Promise<never> => {
    throw new Error("not used in this suite");
  };
  const api: Pick<VexCloudApi, "readAccount" | "listUsage" | "listDeposits" | "listModels"> = {
    readAccount: async () => ({ ok: true, value: accountWith({ availableWei: backend.balanceWei }) }),
    listUsage: async () => ({ ok: true, value: { items: [], next_cursor: null } }),
    listDeposits: async () => {
      backend.depositReads += 1;
      const next = backend.pages.shift();
      if (next === undefined) throw new Error("no scripted deposits page");
      return { ok: true, value: { items: [...(await next)], next_cursor: null } };
    },
    listModels: notUsed,
  };
  const deps: StatusDeps = {
    api,
    readSession: async () => ({ ok: true, data: "vxs_test_bearer_000000000001" }),
    clearSession: async () => ({ ok: true, data: undefined }),
    store,
    watch: { store, generations: createObservationGenerations(), emitCrossing: () => undefined },
    pinnedDepositAddress: () => DEPOSIT,
    conditions: () => ({ now: NOW, vaultUnlocked: true, quitting: false, executionReady: true, signedInAccountId: ACCOUNT_ID }),
    networkFeeAboveLimit: () => false,
    now: () => NOW,
  };
  const read = () => readVexInferenceStatus(deps, { modelId: null, effort: null, usageLimit: 5, usageCursor: null }, new AbortController().signal);
  const poller = createAutoTopUpPoller({
    deposit: depositWorld().deps,
    store,
    conditions: deps.conditions,
    api: { readAccount: api.readAccount, listDeposits: api.listDeposits },
    watch: deps.watch,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  });
  return { store, backend, read, tick: () => poller.tickNow() };
}

describe("a deposits-plus-balance observation is ordered as a whole", () => {
  it.each(["status read", "poller tick"] as const)("a delayed page with the older credit A (the %s), landing after B was recorded, leaves marker B and the reference unchanged", async (slowObserver) => {
    __resetExecutorForTests();
    const h = harness();
    h.backend.balanceWei = 1_000n * E18;
    h.backend.pages.push(Promise.resolve([A]));
    expect(await h.read()).toMatchObject({ ok: true });
    expect(h.store.watch.get(ACCOUNT_ID)).toMatchObject({ lastCreditedDepositId: "dep_a", referenceWei: 1_000n * E18 });

    // Read 1 starts; its deposits page (still showing only A) is held.
    let releaseSlow: (items: readonly DepositItem[]) => void = () => undefined;
    h.backend.pages.push(new Promise((resolve) => {
      releaseSlow = resolve;
    }));
    const slow: Promise<unknown> = slowObserver === "status read" ? h.read() : h.tick();
    // The slow observer has STARTED its deposits read (and taken its generation) before read 2 begins.
    await vi.waitFor(() => expect(h.backend.depositReads).toBe(2));

    // Read 2 starts after it, sees B credited and the balance after it.
    h.backend.balanceWei = 6_000n * E18;
    h.backend.pages.push(Promise.resolve([B, A]));
    expect(await h.read()).toMatchObject({ ok: true });
    expect(h.store.watch.get(ACCOUNT_ID)).toMatchObject({ lastCreditedDepositId: "dep_b", referenceWei: 6_000n * E18 });

    // Inference spends; read 1's page lands now, followed by its balance read of the lower balance.
    h.backend.balanceWei = 900n * E18;
    releaseSlow([A]);
    await slow;
    expect(h.store.watch.get(ACCOUNT_ID)).toMatchObject({
      lastCreditedDepositId: "dep_b",
      lastCreditedFinalizedAt: new Date(B.finalized_at ?? ""),
      referenceWei: 6_000n * E18,
      lastBalanceWei: 6_000n * E18,
    });

    // Normal progression: a fresh read still moves on, and a newer credit C resets the reference.
    h.backend.pages.push(Promise.resolve([B, A]));
    await h.read();
    expect(h.store.watch.get(ACCOUNT_ID)).toMatchObject({ lastCreditedDepositId: "dep_b", referenceWei: 6_000n * E18, lastBalanceWei: 900n * E18 });
    h.backend.balanceWei = 5_900n * E18;
    h.backend.pages.push(Promise.resolve([C, B, A]));
    await h.read();
    expect(h.store.watch.get(ACCOUNT_ID)).toMatchObject({ lastCreditedDepositId: "dep_c", referenceWei: 5_900n * E18 });
  });
});
