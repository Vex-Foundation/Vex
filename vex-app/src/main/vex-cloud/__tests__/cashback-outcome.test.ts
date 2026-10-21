/**
 * The cashback claim's COMMIT OUTCOME (F3 for the second mutation): an
 * answer that does not prove a refusal is `unknown`, never "Nothing was
 * changed", and the next claim repeats the SAME idempotency key, so it
 * reports what that claim moved instead of a fresh "0".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudCall, VexCloudCallFailure } from "../api-client.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { claimCashbackToBalance, __resetCashbackStateForTests } = await import("../funding/cashback.js");
type CashbackDeps = import("../funding/cashback.js").CashbackDeps;

function world(answers: Array<VexCloudCallFailure | "ok">): { readonly deps: CashbackDeps; readonly keys: string[] } {
  const keys: string[] = [];
  let minted = 0;
  const deps: CashbackDeps = {
    readSession: async () => ({ ok: true, data: "vxs_test_bearer_000000000001" }),
    clearSession: async () => ({ ok: true, data: undefined }),
    mintIdempotencyKey: () => {
      minted += 1;
      return `vxc_test_key_${minted}`;
    },
    api: {
      claimCashbackToBalance: async (_bearer, key): Promise<VexCloudCall<{ readonly claimedWei: string }>> => {
        keys.push(key);
        const answer = answers.shift() ?? "ok";
        return answer === "ok" ? { ok: true, value: { claimedWei: "12000000000000000000" } } : { ok: false, failure: answer };
      },
    },
  };
  return { deps, keys };
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
});
