/**
 * The withdrawal owner's COMMIT OUTCOMES and its approval deadline, against
 * a scripted Vex Cloud API (the HTTP mapping itself is pinned by
 * `api-client.test.ts` and the IPC suite).
 *
 * WHAT IT PINS:
 *  - F3: an answer that does not prove a refusal (a body this build cannot
 *    read, a timeout, a 503 without a known reason) is an UNKNOWN outcome:
 *    the proposal and its idempotency key are kept, and the next submit of
 *    the same proposal ("Check status") replays the SAME key; a definitive
 *    refusal (409 `insufficient_withdrawable`) retires them;
 *  - F4: an approval that lapses while the fresh account read runs is
 *    refused before any POST; a replay of an ALREADY-SENT proposal is not a
 *    new approval and still runs after the deadline;
 *  - R1: a REPLAY's refusal retires the key only when it proves the original
 *    was not created (`replayVerdict`): a 401 or `withdrawals_unavailable`
 *    (both raised before the backend's key lookup) keeps it, a refusal
 *    raised after the lookup resolves it as `not_created`;
 *  - R2: the held key is bound to its account: it survives a sign-out and a
 *    sign-in, and is never replayed under another account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccountResponse, VexCloudCall, VexCloudCallFailure, WithdrawalResponse } from "../api-client.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prepareWithdrawal, submitWithdrawal, WITHDRAWAL_PROPOSAL_TTL_MS, __resetWithdrawStateForTests } = await import(
  "../funding/withdraw.js"
);
type WithdrawDeps = import("../funding/withdraw.js").WithdrawDeps;

const W1 = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const E18 = 10n ** 18n;

const ACCOUNT_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const BEARER = "vxs_test_bearer_000000000001";

function account(accountId: string = ACCOUNT_A): VexCloudAccountResponse {
  const amount = { wei: String(20_000n * E18), usd_micro_estimate: null };
  return {
    account_id: accountId,
    status: { paused: false, drain_mode: false },
    wallets: [{ address: W1, linked_at: NOW.toISOString() }],
    deposit_address: "0x00000000000000000000000000000000000D3905",
    balances: { available: amount, provisional: amount, reserved: amount, pending_withdrawal: amount, claimable: amount },
    withdrawable_wei: String(10_000n * E18),
    rate: {
      available: true,
      source: "twap",
      vex_wei_per_micro_usd: "1000000000000000",
      observed_at: NOW.toISOString(),
      age_seconds: 1,
      valid_until: new Date(NOW.getTime() + 600_000).toISOString(),
    },
    limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
  };
}

const WITHDRAWAL: WithdrawalResponse = {
  withdrawal: {
    id: "wd_1",
    status: "debited",
    amount_wei: String(6_000n * E18),
    destination: W1,
    tx_hash: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  },
};

interface Script {
  now: Date;
  /** The answers to the next POSTs, in order; past the end every POST succeeds. */
  readonly answers: Array<VexCloudCallFailure | "ok">;
  readonly keys: string[];
  /** Runs inside the account read, to move the clock while it is pending. */
  duringRead: (() => void) | null;
  minted: number;
  /** The stored bearer; `clearSession` empties it, as main does on a 401. */
  session: string | null;
  /** The account the stored session belongs to. */
  accountId: string;
  /** The account reads seen. */
  reads: number;
  /** When set, the account read fails with it. */
  readFailure: VexCloudCallFailure | null;
}

function world(): { readonly deps: WithdrawDeps; readonly script: Script } {
  const script: Script = { now: NOW, answers: [], keys: [], duringRead: null, minted: 0, session: BEARER, accountId: ACCOUNT_A, reads: 0, readFailure: null };
  const deps: WithdrawDeps = {
    readSession: async () => ({ ok: true, data: script.session }),
    clearSession: async () => {
      script.session = null;
      return { ok: true, data: undefined };
    },
    localWallets: () => [W1],
    now: () => script.now,
    mintIdempotencyKey: () => {
      script.minted += 1;
      return `vxw_test_key_${script.minted}`;
    },
    api: {
      readAccount: async (): Promise<VexCloudCall<VexCloudAccountResponse>> => {
        script.reads += 1;
        if (script.readFailure !== null) return { ok: false, failure: script.readFailure };
        script.duringRead?.();
        return { ok: true, value: account(script.accountId) };
      },
      createWithdrawal: async (_bearer, key): Promise<VexCloudCall<WithdrawalResponse>> => {
        script.keys.push(key);
        const answer = script.answers.shift() ?? "ok";
        return answer === "ok" ? { ok: true, value: WITHDRAWAL } : { ok: false, failure: answer };
      },
      readWithdrawal: async () => ({ ok: true, value: WITHDRAWAL }),
    },
  };
  return { deps, script };
}

const signal = (): AbortSignal => new AbortController().signal;

async function prepared(deps: WithdrawDeps): Promise<{ proposalId: string; destination: string; amountWei: string }> {
  const outcome = await prepareWithdrawal(deps, { destination: W1, amountText: "6000" }, signal());
  if (!outcome.ok) throw new Error(`prepare refused: ${outcome.refusal.kind}`);
  return { proposalId: outcome.value.proposalId, destination: outcome.value.destination, amountWei: outcome.value.amountWei };
}

beforeEach(() => {
  __resetWithdrawStateForTests();
});

describe("F3: a mutation whose answer does not prove refusal keeps its key", () => {
  it.each<[string, VexCloudCallFailure]>([
    ["an invalid success body", { kind: "invalid_response" }],
    ["a timeout or network error after the send", { kind: "unavailable", status: null }],
    ["a 503 without a known reason", { kind: "unavailable", status: 503 }],
  ])("%s is an unknown outcome, and Check status replays the SAME key", async (_name, failure) => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.answers.push(failure);
    const first = await submitWithdrawal(deps, input, signal(), "c1");
    expect(first).toEqual({
      ok: true,
      value: { outcome: "unknown", proposalId: input.proposalId, amountWei: input.amountWei, destination: W1 },
    });
    const replay = await submitWithdrawal(deps, input, signal(), "c2");
    expect(replay.ok && replay.value.outcome).toBe("accepted");
    expect(script.keys).toEqual(["vxw_test_key_1", "vxw_test_key_1"]);
  });

  it("a definitive refusal (409 insufficient_withdrawable) retires the proposal and its key", async () => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.answers.push({ kind: "rejected", status: 409, reason: "insufficient_withdrawable", address: null });
    const refused = await submitWithdrawal(deps, input, signal(), "c1");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.kind).toBe("insufficient_withdrawable");
    const again = await submitWithdrawal(deps, input, signal(), "c2");
    expect(again.ok === false && again.refusal.kind).toBe("proposal_missing");
    expect(script.keys).toEqual(["vxw_test_key_1"]);
  });
});

describe("F4: the approval deadline is checked again right before the POST", () => {
  it("an approval that lapses during the fresh account read is refused before any POST", async () => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.duringRead = () => {
      script.now = new Date(NOW.getTime() + WITHDRAWAL_PROPOSAL_TTL_MS);
    };
    const outcome = await submitWithdrawal(deps, input, signal(), "c1");
    expect(outcome.ok === false && outcome.refusal.kind).toBe("proposal_expired");
    expect(script.keys).toEqual([]);
  });

  it("a replay of an ALREADY-SENT proposal is not a new approval and still runs after the deadline", async () => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.answers.push({ kind: "invalid_response" });
    const first = await submitWithdrawal(deps, input, signal(), "c1");
    expect(first.ok && first.value.outcome).toBe("unknown");
    script.now = new Date(NOW.getTime() + WITHDRAWAL_PROPOSAL_TTL_MS + 60_000);
    const replay = await submitWithdrawal(deps, input, signal(), "c2");
    expect(replay.ok && replay.value.outcome).toBe("accepted");
    expect(script.keys).toEqual(["vxw_test_key_1", "vxw_test_key_1"]);
  });

  it("a proposal that was never sent is refused after the deadline, with no POST", async () => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.now = new Date(NOW.getTime() + WITHDRAWAL_PROPOSAL_TTL_MS + 1);
    const outcome = await submitWithdrawal(deps, input, signal(), "c1");
    expect(outcome.ok === false && outcome.refusal.kind).toBe("proposal_expired");
    expect(script.keys).toEqual([]);
  });
});

const UNAUTHORIZED: VexCloudCallFailure = { kind: "unauthorized", reason: "session_invalid", address: null };

/** Prepare, then send once with an unreadable answer: the proposal is held as an unknown outcome. */
async function heldUnknown(deps: WithdrawDeps, script: Script): Promise<{ proposalId: string; destination: string; amountWei: string }> {
  const input = await prepared(deps);
  script.answers.push({ kind: "invalid_response" });
  const first = await submitWithdrawal(deps, input, signal(), "c1");
  expect(first.ok && first.value.outcome).toBe("unknown");
  return input;
}

describe("R1: a replay refusal is judged by what it proves about the original", () => {
  it("401 on a replay clears the session but keeps the key; after sign-in the replay sends the SAME key and resolves", async () => {
    const { deps, script } = world();
    const input = await heldUnknown(deps, script);
    script.answers.push(UNAUTHORIZED);
    const expired = await submitWithdrawal(deps, input, signal(), "c2");
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.refusal.kind).toBe("not_signed_in");
    expect(expired.refusal.detail).toContain("Vex still holds the same request");
    expect(script.session).toBeNull();
    // Signed out: the check is refused locally and still keeps the request.
    const signedOut = await submitWithdrawal(deps, input, signal(), "c3");
    expect(signedOut.ok === false && signedOut.refusal.kind).toBe("not_signed_in");
    script.session = "vxs_test_bearer_000000000002";
    const resolved = await submitWithdrawal(deps, input, signal(), "c4");
    expect(resolved.ok && resolved.value.outcome).toBe("accepted");
    expect(script.keys).toEqual(["vxw_test_key_1", "vxw_test_key_1", "vxw_test_key_1"]);
  });

  it("withdrawals_unavailable (raised before the key lookup) on a replay keeps the key", async () => {
    const { deps, script } = world();
    const input = await heldUnknown(deps, script);
    script.answers.push({ kind: "unavailable", status: 503, reason: "withdrawals_unavailable" });
    const check = await submitWithdrawal(deps, input, signal(), "c2");
    expect(check).toEqual({ ok: true, value: { outcome: "unknown", proposalId: input.proposalId, amountWei: input.amountWei, destination: W1 } });
    const again = await submitWithdrawal(deps, input, signal(), "c3");
    expect(again.ok && again.value.outcome).toBe("accepted");
    expect(script.keys).toEqual(["vxw_test_key_1", "vxw_test_key_1", "vxw_test_key_1"]);
  });

  it("a refusal raised after the key lookup (409 insufficient_withdrawable) on a replay resolves as not_created and retires the key", async () => {
    const { deps, script } = world();
    const input = await heldUnknown(deps, script);
    script.answers.push({ kind: "rejected", status: 409, reason: "insufficient_withdrawable", address: null });
    const check = await submitWithdrawal(deps, input, signal(), "c2");
    expect(check.ok).toBe(true);
    if (!check.ok || check.value.outcome !== "not_created") throw new Error("expected not_created");
    expect(check.value.proposalId).toBe(input.proposalId);
    expect(check.value.detail).toContain("Nothing was moved");
    const after = await submitWithdrawal(deps, input, signal(), "c3");
    expect(after.ok === false && after.refusal.kind).toBe("proposal_missing");
    expect(script.keys).toEqual(["vxw_test_key_1", "vxw_test_key_1"]);
  });

  it("a success on a replay returns the withdrawal and retires the key", async () => {
    const { deps, script } = world();
    const input = await heldUnknown(deps, script);
    const check = await submitWithdrawal(deps, input, signal(), "c2");
    expect(check).toEqual({ ok: true, value: { outcome: "accepted", withdrawal: expect.objectContaining({ id: "wd_1", status: "debited" }) } });
    const after = await submitWithdrawal(deps, input, signal(), "c3");
    expect(after.ok === false && after.refusal.kind).toBe("proposal_missing");
  });

  it("a FIRST send keeps its semantics: 401 at auth retires the key (nothing could have been created)", async () => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.answers.push(UNAUTHORIZED);
    const first = await submitWithdrawal(deps, input, signal(), "c1");
    expect(first.ok === false && first.refusal.kind).toBe("not_signed_in");
    script.session = BEARER;
    const again = await submitWithdrawal(deps, input, signal(), "c2");
    expect(again.ok === false && again.refusal.kind).toBe("proposal_missing");
    expect(script.keys).toEqual(["vxw_test_key_1"]);
  });
});

describe("R2: the held key is bound to its account", () => {
  it("a replay under another account is refused with no POST and keeps the key for the original account", async () => {
    const { deps, script } = world();
    const input = await heldUnknown(deps, script);
    script.accountId = ACCOUNT_B;
    const other = await submitWithdrawal(deps, input, signal(), "c2");
    expect(other.ok === false && other.refusal.kind).toBe("account_changed");
    expect(script.keys).toEqual(["vxw_test_key_1"]);
    script.accountId = ACCOUNT_A;
    const back = await submitWithdrawal(deps, input, signal(), "c3");
    expect(back.ok && back.value.outcome).toBe("accepted");
    expect(script.keys).toEqual(["vxw_test_key_1", "vxw_test_key_1"]);
  });

  it("a 401 on the replay's account read keeps the key too", async () => {
    const { deps, script } = world();
    const input = await heldUnknown(deps, script);
    script.readFailure = UNAUTHORIZED;
    const check = await submitWithdrawal(deps, input, signal(), "c2");
    expect(check.ok === false && check.refusal.detail).toContain("Vex still holds the same request");
    expect(script.session).toBeNull();
    expect(script.keys).toEqual(["vxw_test_key_1"]);
  });

  it("a proposal reviewed under one account is not sent under another", async () => {
    const { deps, script } = world();
    const input = await prepared(deps);
    script.accountId = ACCOUNT_B;
    const outcome = await submitWithdrawal(deps, input, signal(), "c1");
    expect(outcome.ok === false && outcome.refusal.kind).toBe("account_changed");
    expect(script.keys).toEqual([]);
  });
});
