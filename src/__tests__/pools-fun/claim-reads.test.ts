/**
 * Reading a creator-fee claim: the simulation is the answer, the mappings are
 * not.
 *
 * The defect this suite exists to prevent is a quiet one and it was measured
 * live: `claimableToken` / `claimablePaired` both read 0 while an `eth_call` of
 * `collectAndClaim` returned 0 / 599999999999, because the mappings hold fees
 * ALREADY COLLECTED into the locker rather than fees the pool owes. A tool that
 * showed the mappings as "claimable" would tell a user there is nothing to claim
 * while real money was waiting.
 *
 * The other half is decline-over-guess: a token the locker never registered, a
 * decimals read that does not answer, and a simulation the node cannot run are
 * three DIFFERENT facts, and none of them may be reported as "nothing to claim".
 */

import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, getAddress, type Address } from "viem";

import { POOLS_LOCKER_ADDRESS } from "@tools/pools-fun/constants.js";
import {
  readPoolsClaimContext,
  simulatePoolsClaim,
} from "@tools/pools-fun/claim/read-claim.js";

const LOCKER = getAddress(POOLS_LOCKER_ADDRESS);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const BLOCK = 39_620_464n;

/** The measured shape: mappings at 0/0 while the pool still owes real fees. */
function client(over: {
  poolInfo?: unknown;
  tokenDecimals?: unknown;
  claimableToken?: unknown;
  claimablePaired?: unknown;
  pairedDecimals?: number | null;
} = {}) {
  const ok = (result: unknown) => ({ status: "success", result });
  const results = [
    over.poolInfo === undefined ? ok([USDG, POOL, WALLET, WALLET, []]) : over.poolInfo,
    over.tokenDecimals === undefined ? ok(18) : over.tokenDecimals,
    over.claimableToken === undefined ? ok(0n) : over.claimableToken,
    over.claimablePaired === undefined ? ok(0n) : over.claimablePaired,
  ];
  return {
    getBlockNumber: async () => BLOCK,
    multicall: async () => results,
    readContract: async () => {
      if (over.pairedDecimals === null) throw new Error("no answer");
      return over.pairedDecimals ?? 6;
    },
  } as never;
}

describe("the already-collected mappings are never presented as claimable", () => {
  it("reports them under their own label, with each leg's asset and decimals", async () => {
    const result = await readPoolsClaimContext(client(), TOKEN, WALLET, LOCKER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const context = result.context;
    expect(context.alreadyCollected.token.amountRaw).toBe(0n);
    expect(context.alreadyCollected.paired.amountRaw).toBe(0n);
    // Every leg carries WHICH asset and at WHAT scale - USDG is 6, the launched
    // token is 18, and a bare number pair would be unreadable.
    expect(context.alreadyCollected.token.assetAddress).toBe(TOKEN);
    expect(context.alreadyCollected.token.decimals).toBe(18);
    expect(context.alreadyCollected.paired.assetAddress).toBe(USDG);
    expect(context.alreadyCollected.paired.decimals).toBe(6);
  });

  it("reads the paired asset from getPoolInfo, which is what the floor must match", async () => {
    const result = await readPoolsClaimContext(client(), TOKEN, WALLET, LOCKER);
    expect(result.ok && result.context.pairedAsset).toBe(USDG);
  });
});

describe("three outcomes, never two", () => {
  it("refuses a token the locker never registered, by name", async () => {
    const result = await readPoolsClaimContext(
      client({ poolInfo: { status: "success", result: [ZERO, ZERO, ZERO, ZERO, []] } }),
      TOKEN,
      WALLET,
      LOCKER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not registered");
    expect(result.reason).toContain("sushi");
  });

  it("refuses when the locker call did not answer at all - silence is not a denial", async () => {
    const result = await readPoolsClaimContext(
      client({ poolInfo: { status: "failure" } }),
      TOKEN,
      WALLET,
      LOCKER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("did not answer");
  });

  it("refuses when the paired asset will not report its decimals", async () => {
    const result = await readPoolsClaimContext(client({ pairedDecimals: null }), TOKEN, WALLET, LOCKER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("does not guess a scale");
  });

  it("refuses when a mapping did not answer, rather than showing it as zero", async () => {
    const result = await readPoolsClaimContext(
      client({ claimablePaired: { status: "failure" } }),
      TOKEN,
      WALLET,
      LOCKER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("already-collected");
  });
});

describe("the simulation is what answers 'what would I receive'", () => {
  it("returns both legs when the pool owes fees, even with the mappings at zero", async () => {
    // THE MEASURED CASE: mappings 0/0, simulation 0 / 599999999999.
    const publicClient = {
      simulateContract: async () => ({ result: [0n, 599_999_999_999n] }),
    } as never;
    const result = await simulatePoolsClaim(publicClient, {
      account: WALLET,
      token: TOKEN,
      blockNumber: BLOCK,
      lockerAddress: LOCKER,
    });
    expect(result).toEqual({ kind: "would_pay", tokenAmountRaw: 0n, pairedAmountRaw: 599_999_999_999n });
  });

  it.each(["NothingToClaim", "NotClaimable"])(
    "reads the locker's %s revert as a FACT about the pool, not a failure",
    async (errorName) => {
      const revert = new ContractFunctionRevertedError({
        abi: [{ inputs: [], name: errorName, type: "error" }],
        data: `0x${"00".repeat(4)}`,
        functionName: "collectAndClaim",
      } as never);
      // The decoded name is what the classifier reads; construct it directly so
      // the test does not depend on viem's selector arithmetic.
      Object.defineProperty(revert, "data", { value: { errorName, args: [] } });
      const wrapped = new BaseError("reverted", { cause: revert });

      const publicClient = {
        simulateContract: async () => {
          throw wrapped;
        },
      } as never;
      const result = await simulatePoolsClaim(publicClient, {
        account: WALLET,
        token: TOKEN,
        blockNumber: BLOCK,
        lockerAddress: LOCKER,
      });
      expect(result).toEqual({ kind: "nothing_to_claim", revert: errorName });
    },
  );

  it("reports an unanswerable call as UNAVAILABLE, which is not 'nothing to claim'", async () => {
    const publicClient = {
      simulateContract: async () => {
        throw Object.assign(new Error("x"), { shortMessage: "HTTP request failed" });
      },
    } as never;
    const result = await simulatePoolsClaim(publicClient, {
      account: WALLET,
      token: TOKEN,
      blockNumber: BLOCK,
      lockerAddress: LOCKER,
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toContain("HTTP request failed");
  });

  it("simulates AS THE CLAIMING ACCOUNT - anyone else answers a different question", async () => {
    const seen: { account?: unknown } = {};
    const publicClient = {
      simulateContract: async (args: { account: unknown }) => {
        seen.account = args.account;
        return { result: [1n, 2n] };
      },
    } as never;
    await simulatePoolsClaim(publicClient, {
      account: WALLET,
      token: TOKEN,
      blockNumber: BLOCK,
      lockerAddress: LOCKER,
    });
    expect(seen.account).toBe(WALLET);
  });
});
