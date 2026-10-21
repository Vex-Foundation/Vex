/**
 * The "withdrawal you did not start" owner (`funding/withdrawal-origins.ts`)
 * against a scripted withdrawals list and the in-memory record.
 *
 * WHAT IT PINS:
 *  - only a COOLING withdrawal (`debited`, release ahead) whose id this app
 *    never recorded is a notice; a recorded one, a released one, a signed one
 *    and a dismissed one are not;
 *  - exactly one engine notice per id, across repeated scans;
 *  - the create race: while a create is open, or when a record landed after
 *    the scan's durable read, no NEW notice is raised;
 *  - a lost-answer withdrawal recorded later stops being a notice;
 *  - the bounded scan: pages, the horizon stop, and `complete: false` at the
 *    page bound;
 *  - the agent status read lists pending withdrawals (cooling and in flight)
 *    with `releaseAt`, `cancellable` and `startedInThisApp`.
 *
 * Does not prove the SQL (the studio-postgres suite) or the HTTP mapping
 * (the funding IPC suite).
 */

import { describe, expect, it, vi } from "vitest";
import type { VexCloudApi, WithdrawalView, WithdrawalsPage } from "../api-client.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { SCAN_HORIZON_MS, SCAN_MAX_PAGES, SCAN_PAGE_LIMIT } = await import("../funding/withdrawal-origins.js");
const { ACCOUNT_ID, accountWith, DEPOSIT, E18, MemoryFundingStore, memoryWithdrawalOrigins, NOW, WALLET } = await import("./support/funding-fakes.js");
const { readVexInferenceStatus } = await import("../status.js");
const { createObservationGenerations } = await import("../balance-watch.js");

const BEARER = "vxs_test_bearer_000000000001";
const HOUR = 3_600_000;

function withdrawal(id: string, overrides: Partial<WithdrawalView> = {}): WithdrawalView {
  return {
    id,
    status: "debited",
    amount_wei: String(6_000n * E18),
    destination: WALLET,
    tx_hash: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    release_at: new Date(NOW.getTime() + 12 * HOUR).toISOString(),
    cancellable: true,
    ...overrides,
  };
}

/** A list endpoint over `items` (newest first), paged by an index cursor. */
function listOf(items: () => readonly WithdrawalView[]): Pick<VexCloudApi, "listWithdrawals"> & { readonly reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    listWithdrawals: async (_bearer, page) => {
      reads += 1;
      const all = items();
      const start = page.cursor === null ? 0 : Number(page.cursor);
      const limit = page.limit ?? 50;
      const value: WithdrawalsPage = {
        items: all.slice(start, start + limit),
        next_cursor: start + limit < all.length ? String(start + limit) : null,
      };
      return { ok: true, value };
    },
  };
}

const signal = new AbortController().signal;

describe("what is a notice", () => {
  it("only a cooling withdrawal this app never recorded; recorded, released, signed and dismissed ones are not", async () => {
    const { guard, store, emitted } = memoryWithdrawalOrigins();
    await store.recordCreatedHere(ACCOUNT_ID, "wd_mine");
    await store.flagForeign(ACCOUNT_ID, "wd_dismissed");
    await store.dismissForeign(ACCOUNT_ID, "wd_dismissed");
    const api = listOf(() => [
      withdrawal("wd_foreign"),
      withdrawal("wd_mine"),
      withdrawal("wd_released", { release_at: new Date(NOW.getTime() - HOUR).toISOString() }),
      withdrawal("wd_signed", { status: "signed", cancellable: false }),
      withdrawal("wd_dismissed"),
      withdrawal("wd_old_backend", { release_at: undefined, cancellable: undefined }),
    ]);
    const scan = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    if (!scan.ok) throw new Error("scan failed");
    expect(scan.value.notices.map((n) => n.withdrawalId)).toEqual(["wd_foreign"]);
    expect(emitted.map((n) => n.withdrawalId)).toEqual(["wd_foreign"]);
    expect(scan.value.notices[0]).toEqual({
      withdrawalId: "wd_foreign",
      amountWei: String(6_000n * E18),
      destination: WALLET,
      releaseAt: new Date(NOW.getTime() + 12 * HOUR).toISOString(),
      cancellable: true,
      createdAt: NOW.toISOString(),
    });
  });

  it("raises exactly one engine notice per id across scans, and keeps showing it until it stops cooling", async () => {
    const { guard, emitted } = memoryWithdrawalOrigins();
    let items = [withdrawal("wd_foreign")];
    const api = listOf(() => items);
    for (let i = 0; i < 3; i += 1) {
      const scan = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
      expect(scan.ok && scan.value.notices.map((n) => n.withdrawalId)).toEqual(["wd_foreign"]);
    }
    expect(emitted).toHaveLength(1);
    items = [withdrawal("wd_foreign", { status: "cancelled", cancellable: false })];
    const after = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(after.ok && after.value.notices).toEqual([]);
  });

  it("a withdrawal whose create answer was lost is a notice until this app records it", async () => {
    const { guard } = memoryWithdrawalOrigins();
    const api = listOf(() => [withdrawal("wd_lost")]);
    expect((await guard.scan(api, BEARER, ACCOUNT_ID, signal)).ok).toBe(true);
    await guard.recordCreatedHere(ACCOUNT_ID, "wd_lost");
    const scan = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(scan.ok && scan.value.notices).toEqual([]);
    expect(scan.ok && scan.value.origins.get("wd_lost")?.origin).toBe("created_here");
  });
});

describe("the create race", () => {
  it("while a create is open no NEW notice is raised; one already raised still shows", async () => {
    const { guard, emitted } = memoryWithdrawalOrigins();
    let items = [withdrawal("wd_earlier")];
    const api = listOf(() => items);
    await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    const end = guard.beginCreate();
    items = [withdrawal("wd_new"), withdrawal("wd_earlier")];
    const during = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(during.ok && during.value.notices.map((n) => n.withdrawalId)).toEqual(["wd_earlier"]);
    await guard.recordCreatedHere(ACCOUNT_ID, "wd_new");
    end();
    end(); // idempotent
    const after = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(after.ok && after.value.notices.map((n) => n.withdrawalId)).toEqual(["wd_earlier"]);
    expect(emitted.map((n) => n.withdrawalId)).toEqual(["wd_earlier"]);
  });

  it("a record that lands after the scan's durable read stops that scan from raising", async () => {
    const { guard, store, emitted } = memoryWithdrawalOrigins();
    const api = listOf(() => [withdrawal("wd_racing")]);
    const realRead = store.readOrigins.bind(store);
    // The create's record commits while the scan's read is in flight.
    store.readOrigins = async (accountId, ids) => {
      const read = await realRead(accountId, ids);
      await guard.recordCreatedHere(ACCOUNT_ID, "wd_racing");
      return read;
    };
    const scan = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(scan.ok && scan.value.notices).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe("the bounded scan", () => {
  it("stops at the page bound and says it is not complete", async () => {
    const { guard } = memoryWithdrawalOrigins();
    const many = Array.from({ length: SCAN_PAGE_LIMIT * SCAN_MAX_PAGES + 1 }, (_, i) => withdrawal(`wd_${i}`, { status: "completed", cancellable: false }));
    const api = listOf(() => many);
    const scan = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(scan.ok && scan.value.complete).toBe(false);
    expect(api.reads()).toBe(SCAN_MAX_PAGES);
  });

  it("stops early, complete, once a page reaches withdrawals older than the horizon", async () => {
    const { guard } = memoryWithdrawalOrigins();
    const old = new Date(NOW.getTime() - SCAN_HORIZON_MS - HOUR).toISOString();
    const items = Array.from({ length: SCAN_PAGE_LIMIT * 3 }, (_, i) =>
      withdrawal(`wd_${i}`, { status: "completed", cancellable: false, created_at: i < SCAN_PAGE_LIMIT ? NOW.toISOString() : old }),
    );
    const api = listOf(() => items);
    const scan = await guard.scan(api, BEARER, ACCOUNT_ID, signal);
    expect(scan.ok && scan.value.complete).toBe(true);
    expect(api.reads()).toBe(2);
  });

  it("a failed page is the failure, never an empty scan", async () => {
    const { guard } = memoryWithdrawalOrigins();
    const scan = await guard.scan(
      { listWithdrawals: async () => ({ ok: false, failure: { kind: "unavailable", status: 503 } }) },
      BEARER,
      ACCOUNT_ID,
      signal,
    );
    expect(scan).toEqual({ ok: false, failure: { kind: "unavailable", status: 503 } });
  });
});

describe("the agent status read", () => {
  it("lists pending withdrawals (cooling and in flight) with releaseAt, cancellable and startedInThisApp; final ones are left out", async () => {
    const store = new MemoryFundingStore();
    const origins = memoryWithdrawalOrigins();
    await origins.store.recordCreatedHere(ACCOUNT_ID, "wd_mine");
    const list = listOf(() => [
      withdrawal("wd_mine"),
      withdrawal("wd_foreign"),
      withdrawal("wd_sending", { status: "broadcast", cancellable: false }),
      withdrawal("wd_done", { status: "completed", cancellable: false }),
      withdrawal("wd_cancelled", { status: "cancelled", cancellable: false }),
    ]);
    const notUsed = async (): Promise<never> => {
      throw new Error("not used in this suite");
    };
    const report = await readVexInferenceStatus(
      {
        api: {
          readAccount: async () => ({ ok: true, value: accountWith() }),
          listUsage: async () => ({ ok: true, value: { items: [], next_cursor: null } }),
          listDeposits: async () => ({ ok: true, value: { items: [], next_cursor: null } }),
          listModels: notUsed,
          listWithdrawals: list.listWithdrawals,
        },
        origins: origins.guard,
        readSession: async () => ({ ok: true, data: BEARER }),
        clearSession: async () => ({ ok: true, data: undefined }),
        store,
        watch: { store, generations: createObservationGenerations(), emitCrossing: () => undefined },
        pinnedDepositAddress: () => DEPOSIT,
        conditions: () => ({ now: NOW, vaultUnlocked: true, quitting: false, executionReady: true, signedInAccountId: ACCOUNT_ID }),
        networkFeeAboveLimit: () => false,
        now: () => NOW,
      },
      { modelId: null, effort: null, usageLimit: 5, usageCursor: null },
      signal,
    );
    if (!report.ok) throw new Error(report.refusal.detail);
    const withdrawals = report.value.withdrawals;
    if (withdrawals.state !== "read") throw new Error("withdrawals unavailable");
    expect(withdrawals.complete).toBe(true);
    expect(withdrawals.pending.map((p) => [p.id, p.cooling, p.cancellable, p.startedInThisApp])).toEqual([
      ["wd_mine", true, true, true],
      ["wd_foreign", true, true, false],
      ["wd_sending", false, false, false],
    ]);
    expect(withdrawals.pending[0]).toMatchObject({ releaseAt: new Date(NOW.getTime() + 12 * HOUR).toISOString(), amount: { vex: "6000" } });
    // The status read is a scan like any other: the foreign one raised its notice.
    expect(origins.emitted.map((n) => n.withdrawalId)).toEqual(["wd_foreign"]);
  });
});
