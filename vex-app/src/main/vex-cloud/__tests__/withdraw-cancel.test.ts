/**
 * The withdrawal cancel owner's ANSWER TABLE and its key, against a scripted
 * Vex Cloud API (the HTTP mapping and the fake backend's own cancel are in
 * the funding IPC suite).
 *
 * WHAT IT PINS:
 *  - `cancelAnswerOf`: what each answer proves about the cancel, for a first
 *    send and for a replay (a pre-handler refusal proves something only on a
 *    first send);
 *  - the key: held before the send, replayed while the answer is unknown,
 *    retired by an answer about the withdrawal, and bound to the account
 *    (another account mints its own);
 *  - a replay's 401 keeps the key and says how to finish the check.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccountResponse, VexCloudCall, VexCloudCallFailure, WithdrawalResponse } from "../api-client.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { cancelAnswerOf, cancelWithdrawal, __resetCancelStateForTests } = await import("../funding/withdraw-cancel.js");
const { accountWith, NOW, WALLET } = await import("./support/funding-fakes.js");
type CancelDeps = import("../funding/withdraw-cancel.js").CancelDeps;

const BEARER = "vxs_test_bearer_000000000001";
const ACCOUNT_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function view(status: WithdrawalResponse["withdrawal"]["status"]): WithdrawalResponse {
  return {
    withdrawal: {
      id: "wd_1",
      status,
      amount_wei: "6000000000000000000000",
      destination: WALLET,
      tx_hash: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      release_at: new Date(NOW.getTime() + 43_200_000).toISOString(),
      cancellable: status === "debited",
    },
  };
}

const rejected = (status: number, reason: string | null): VexCloudCallFailure => ({ kind: "rejected", status, reason, address: null });
const fail = (failure: VexCloudCallFailure) => ({ ok: false as const, failure });

describe("cancelAnswerOf: what each answer proves", () => {
  it.each([
    ["200 cancelled", { ok: true as const, value: view("cancelled") }, "cancelled", "cancelled"],
    ["200 not cancelled (off contract)", { ok: true as const, value: view("debited") }, "unknown", "unknown"],
    ["409 withdrawal_in_flight", fail(rejected(409, "withdrawal_in_flight")), "not_cancelled", "not_cancelled"],
    ["404 withdrawal_not_found", fail(rejected(404, "withdrawal_not_found")), "not_cancelled", "not_cancelled"],
    ["409 withdrawal_final", fail(rejected(409, "withdrawal_final")), "settle_by_read", "settle_by_read"],
    ["409 withdrawal_in_flight under a wrong status", fail(rejected(400, "withdrawal_in_flight")), "unknown", "unknown"],
    ["401", fail({ kind: "unauthorized", reason: "session_invalid", address: null }), "refused", "unknown"],
    ["404 with no reason (no cancel route)", fail(rejected(404, null)), "refused", "unknown"],
    ["400 invalid_idempotency_key", fail(rejected(400, "invalid_idempotency_key")), "refused", "unknown"],
    ["400 invalid_field", fail(rejected(400, "invalid_field")), "refused", "unknown"],
    ["503 withdrawals_unavailable", fail({ kind: "unavailable", status: 503, reason: "withdrawals_unavailable" }), "refused", "unknown"],
    ["502", fail({ kind: "unavailable", status: 502 }), "unknown", "unknown"],
    ["timeout", fail({ kind: "unavailable", status: null }), "unknown", "unknown"],
    ["429 throttle", fail({ kind: "unavailable", status: 429, reason: "rate_limited" }), "unknown", "unknown"],
    ["unreadable body", fail({ kind: "invalid_response" }), "unknown", "unknown"],
    ["cancelled in flight", fail({ kind: "cancelled" }), "unknown", "unknown"],
    ["an unknown reason", fail(rejected(409, "brand_new_reason")), "unknown", "unknown"],
  ])("%s: first send %s, replay %s", (_name, answer, first, replay) => {
    expect(cancelAnswerOf(answer, "first")).toBe(first);
    expect(cancelAnswerOf(answer, "replay")).toBe(replay);
  });
});

interface Script {
  accountId: string;
  session: string | null;
  readonly answers: Array<VexCloudCall<WithdrawalResponse>>;
  readonly keys: string[];
  minted: number;
  statusRead: VexCloudCall<WithdrawalResponse> | null;
}

function world(): { readonly deps: CancelDeps; readonly script: Script } {
  const script: Script = { accountId: accountWith().account_id, session: BEARER, answers: [], keys: [], minted: 0, statusRead: null };
  const deps: CancelDeps = {
    readSession: async () => ({ ok: true, data: script.session }),
    clearSession: async () => {
      script.session = null;
      return { ok: true, data: undefined };
    },
    now: () => NOW,
    mintIdempotencyKey: () => {
      script.minted += 1;
      return `vxc_test_key_${script.minted}`;
    },
    api: {
      readAccount: async (): Promise<VexCloudCall<VexCloudAccountResponse>> => ({ ok: true, value: accountWith({ accountId: script.accountId }) }),
      cancelWithdrawal: async (_bearer, key) => {
        script.keys.push(key);
        return script.answers.shift() ?? { ok: true, value: view("cancelled") };
      },
      readWithdrawal: async () => script.statusRead ?? { ok: false, failure: { kind: "unavailable", status: null } },
    },
  };
  return { deps, script };
}

const signal = new AbortController().signal;

beforeEach(() => {
  __resetCancelStateForTests();
});

describe("the cancel key", () => {
  it("an unknown answer keeps the key and the next cancel replays it until an answer about the withdrawal", async () => {
    const { deps, script } = world();
    script.answers.push(fail({ kind: "unavailable", status: 502 }), fail({ kind: "unavailable", status: null }));
    expect(await cancelWithdrawal(deps, "wd_1", signal, "c1")).toEqual({ ok: true, value: { outcome: "unknown", withdrawalId: "wd_1" } });
    expect(await cancelWithdrawal(deps, "wd_1", signal, "c2")).toEqual({ ok: true, value: { outcome: "unknown", withdrawalId: "wd_1" } });
    const done = await cancelWithdrawal(deps, "wd_1", signal, "c3");
    expect(done.ok && done.value.outcome).toBe("cancelled");
    expect(script.keys).toEqual(["vxc_test_key_1", "vxc_test_key_1", "vxc_test_key_1"]);
    // Retired by the answer: a new intent gets a new key.
    await cancelWithdrawal(deps, "wd_1", signal, "c4");
    expect(script.keys[3]).toBe("vxc_test_key_2");
  });

  it("is bound to the account: the same withdrawal id under another account mints its own key", async () => {
    const { deps, script } = world();
    script.answers.push(fail({ kind: "unavailable", status: 502 }));
    await cancelWithdrawal(deps, "wd_1", signal, "c1");
    script.accountId = ACCOUNT_B;
    await cancelWithdrawal(deps, "wd_1", signal, "c2");
    expect(script.keys).toEqual(["vxc_test_key_1", "vxc_test_key_2"]);
  });

  it("a replay's 401 keeps the key and says how to finish the check", async () => {
    const { deps, script } = world();
    script.answers.push(fail({ kind: "unavailable", status: 502 }), fail({ kind: "unauthorized", reason: "session_invalid", address: null }));
    await cancelWithdrawal(deps, "wd_1", signal, "c1");
    const signedOut = await cancelWithdrawal(deps, "wd_1", signal, "c2");
    expect(signedOut.ok).toBe(false);
    if (!signedOut.ok) expect(signedOut.refusal.detail).toMatch(/Check status/);
    expect(script.session).toBeNull();
    script.session = BEARER;
    await cancelWithdrawal(deps, "wd_1", signal, "c3");
    expect(script.keys).toEqual(["vxc_test_key_1", "vxc_test_key_1", "vxc_test_key_1"]);
  });

  it("withdrawal_final is settled by reading the withdrawal; an unreadable status keeps the key", async () => {
    const { deps, script } = world();
    script.answers.push(fail(rejected(409, "withdrawal_final")), fail(rejected(409, "withdrawal_final")));
    expect(await cancelWithdrawal(deps, "wd_1", signal, "c1")).toEqual({ ok: true, value: { outcome: "unknown", withdrawalId: "wd_1" } });
    script.statusRead = { ok: true, value: view("cancelled") };
    const settled = await cancelWithdrawal(deps, "wd_1", signal, "c2");
    expect(settled.ok && settled.value.outcome).toBe("cancelled");
    expect(script.keys).toEqual(["vxc_test_key_1", "vxc_test_key_1"]);
  });

  it("an old backend without the cancel route refuses by name and retires the key", async () => {
    const { deps, script } = world();
    script.answers.push(fail(rejected(404, null)));
    const refused = await cancelWithdrawal(deps, "wd_1", signal, "c1");
    expect(refused.ok === false && refused.refusal.kind).toBe("cancel_unsupported");
    await cancelWithdrawal(deps, "wd_1", signal, "c2");
    expect(script.keys).toEqual(["vxc_test_key_1", "vxc_test_key_2"]);
  });
});
