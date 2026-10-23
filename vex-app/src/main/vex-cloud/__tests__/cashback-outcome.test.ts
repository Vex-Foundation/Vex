/**
 * The cashback claim's COMMIT OUTCOME (F3 for the second mutation): an
 * answer that does not prove a refusal is `unknown`, never "Nothing was
 * changed", and the next claim repeats the SAME idempotency key, so it
 * reports what that claim moved instead of a fresh "0". A REPLAY resolves
 * only on success (the ledger refuses nothing after its key lookup): a 401
 * or any other refusal keeps the key, and the key is held per account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccountResponse, VexCloudCall, VexCloudCallFailure } from "../api-client.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { claimCashbackToBalance, __resetCashbackStateForTests } = await import("../funding/cashback.js");
type CashbackDeps = import("../funding/cashback.js").CashbackDeps;

const ACCOUNT_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const BEARER = "vxs_test_bearer_000000000001";

interface World {
  readonly deps: CashbackDeps;
  readonly keys: string[];
  readonly state: { session: string | null; accountId: string };
}

function accountOf(accountId: string): VexCloudAccountResponse {
  const amount = { wei: "0", usd_micro_estimate: null };
  return {
    account_id: accountId,
    status: { paused: false, drain_mode: false },
    wallets: [],
    deposit_address: null,
    balances: { available: amount, provisional: amount, reserved: amount, pending_withdrawal: amount, claimable: amount },
    rate: { available: false, reason: "stale" },
    limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
  };
}

function world(answers: Array<VexCloudCallFailure | "ok">): World {
  const keys: string[] = [];
  const state: World["state"] = { session: BEARER, accountId: ACCOUNT_A };
  let minted = 0;
  const deps: CashbackDeps = {
    readSession: async () => ({ ok: true, data: state.session }),
    clearSession: async () => {
      state.session = null;
      return { ok: true, data: undefined };
    },
    mintIdempotencyKey: () => {
      minted += 1;
      return `vxc_test_key_${minted}`;
    },
    api: {
      readAccount: async (): Promise<VexCloudCall<VexCloudAccountResponse>> => ({ ok: true, value: accountOf(state.accountId) }),
      claimCashbackToBalance: async (_bearer, key): Promise<VexCloudCall<{ readonly claimedWei: string }>> => {
        keys.push(key);
        const answer = answers.shift() ?? "ok";
        return answer === "ok" ? { ok: true, value: { claimedWei: "12000000000000000000" } } : { ok: false, failure: answer };
      },
    },
  };
  return { deps, keys, state };
}

const signal = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  __resetCashbackStateForTests();
});

describe("cashback claim outcome", () => {
  it("an invalid body is unknown, and the next claim repeats the SAME key", async () => {
    const { deps, keys } = world([{ kind: "invalid_response" }]);
    expect(await claimCashbackToBalance(deps, signal(), "c1")).toEqual({ ok: true, value: { outcome: "unknown" } });
    expect(await claimCashbackToBalance(deps, signal(), "c2")).toEqual({
      ok: true,
      value: { outcome: "claimed", claimedWei: "12000000000000000000" },
    });
    expect(keys).toEqual(["vxc_test_key_1", "vxc_test_key_1"]);
  });

  it("a success or a definitive refusal retires the key: the next claim is a new one", async () => {
    const { deps, keys } = world(["ok", { kind: "rejected", status: 400, reason: "unsupported_destination", address: null }, "ok"]);
    await claimCashbackToBalance(deps, signal(), "c1");
    const refused = await claimCashbackToBalance(deps, signal(), "c2");
    expect(refused.ok === false && refused.refusal.kind).toBe("unsupported_destination");
    await claimCashbackToBalance(deps, signal(), "c3");
    expect(keys).toEqual(["vxc_test_key_1", "vxc_test_key_2", "vxc_test_key_3"]);
  });

  it("401 on a replay clears the session but keeps the key; after sign-in the replay repeats the SAME claim", async () => {
    const unauthorized: VexCloudCallFailure = { kind: "unauthorized", reason: "session_invalid", address: null };
    const { deps, keys, state } = world([{ kind: "invalid_response" }, unauthorized]);
    expect(await claimCashbackToBalance(deps, signal(), "c1")).toEqual({ ok: true, value: { outcome: "unknown" } });
    const expired = await claimCashbackToBalance(deps, signal(), "c2");
    expect(expired.ok === false && expired.refusal.kind).toBe("not_signed_in");
    expect(expired.ok === false && expired.refusal.detail).toContain("Vex still holds the same request");
    expect(state.session).toBeNull();
    state.session = "vxs_test_bearer_000000000002";
    expect(await claimCashbackToBalance(deps, signal(), "c3")).toEqual({
      ok: true,
      value: { outcome: "claimed", claimedWei: "12000000000000000000" },
    });
    expect(keys).toEqual(["vxc_test_key_1", "vxc_test_key_1", "vxc_test_key_1"]);
  });

  it("a route refusal on a replay (400 unsupported_destination, before the lookup) keeps the key", async () => {
    const { deps, keys } = world([{ kind: "invalid_response" }, { kind: "rejected", status: 400, reason: "unsupported_destination", address: null }]);
    await claimCashbackToBalance(deps, signal(), "c1");
    expect(await claimCashbackToBalance(deps, signal(), "c2")).toEqual({ ok: true, value: { outcome: "unknown" } });
    await claimCashbackToBalance(deps, signal(), "c3");
    expect(keys).toEqual(["vxc_test_key_1", "vxc_test_key_1", "vxc_test_key_1"]);
  });

  it("the held key belongs to its account: another account claims with its own key, and the first account's key is still held", async () => {
    const { deps, keys, state } = world([{ kind: "invalid_response" }]);
    await claimCashbackToBalance(deps, signal(), "c1");
    state.accountId = ACCOUNT_B;
    await claimCashbackToBalance(deps, signal(), "c2");
    state.accountId = ACCOUNT_A;
    await claimCashbackToBalance(deps, signal(), "c3");
    expect(keys).toEqual(["vxc_test_key_1", "vxc_test_key_2", "vxc_test_key_1"]);
  });
});
