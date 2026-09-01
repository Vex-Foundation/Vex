/**
 * The Uniswap spendability lane on a chain whose `pending` tag subtracts
 * nothing.
 *
 * WHY THIS SUITE EXISTS SEPARATELY from the compensation's own unit tests: the
 * policy being correct is worth nothing if the venue never asks it. Both
 * spendability windows go through `observeUniswapSwapSpendability`, so this
 * drives that seam directly - the real observer, the real evaluator, the real
 * shortfall vocabulary - and changes only the chain and the durable answer.
 *
 * The pairing is the point. Base (8453) was measured assembling a real, unsealed
 * pending block, so nothing about it changes. Arbitrum (42161) answers `pending`
 * with a block that is already mined, so there the read is only as good as Vex's
 * own record of what it has broadcast.
 */

import { describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";

import { PENDING_COMPENSATION_CAUSES } from "@vex-agent/tools/protocols/quote-authority/pending-debit-compensation.js";
import {
  observeUniswapSwapSpendability,
  judgeUniswapSpendability,
} from "@vex-agent/tools/protocols/uniswap/handlers/swap/quote-spendability.js";
import type { UniswapSpendabilityClient } from "@vex-agent/tools/protocols/uniswap/handlers/swap/native-debit-plan.js";
import type { QuoteEligibility } from "@vex-agent/tools/protocols/quote-authority/eligibility.js";

import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";

/**
 * The shared fake, presented through the client interface the lane declares.
 *
 * Written as a delegating literal rather than a cast: each method is checked
 * against the real seam, so a change to `UniswapSpendabilityClient` fails here
 * instead of being waved through by an assertion.
 */
function spendabilityClient(): UniswapSpendabilityClient {
  const fake = uniswapSpendabilityFake();
  return {
    readContract: (parameters) => fake.readContract(parameters),
    getBalance: (parameters) => fake.getBalance(parameters),
    estimateGas: (parameters) => fake.estimateGas(parameters),
    estimateFeesPerGas: () => fake.estimateFeesPerGas(),
    getGasPrice: () => fake.getGasPrice(),
    getTransactionCount: (parameters) => fake.getTransactionCount(parameters),
  };
}

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");

/** Base: a distinct pending state - the pending block came back unsealed. */
const PENDING_REAL_CHAIN = 8453;
/** Arbitrum: `pending` answered with a block already canonical at that height. */
const PENDING_DEAD_CHAIN = 42161;

const ROUTE_EXECUTABLE: QuoteEligibility = {
  kind: "executable",
  priceImpactFraction: 0,
  adverse: false,
};

/** A debit the wallet can comfortably pay, so only the tag question decides. */
const AFFORDABLE_DEBIT = {
  ok: true as const,
  totalWei: 1_000n,
  totalRaw: "1000",
  legs: [],
  reserveWei: 100n,
  conservativeRoles: [],
};

const TOKEN_IN = {
  address: TOKEN,
  symbol: "TKN",
  decimals: 18,
  isNative: false,
} as const;

async function observe(chainId: number, inFlight: boolean): Promise<QuoteEligibility> {
  const client = spendabilityClient();
  const observation = await observeUniswapSwapSpendability({
    client,
    chainId,
    wallet: WALLET,
    tokenIn: TOKEN_IN,
    sourceRequiredRaw: 1n,
    debit: AFFORDABLE_DEBIT,
    readInFlightBroadcast: async () => inFlight,
  });
  return judgeUniswapSpendability(observation, ROUTE_EXECUTABLE).eligibility;
}

describe("uniswap spendability on a chain with a real pending state", () => {
  it("is unchanged: the tag did the subtraction, so the durable record is not consulted", async () => {
    const readInFlight = vi.fn(async () => true);
    const client = spendabilityClient();

    const observation = await observeUniswapSwapSpendability({
      client,
      chainId: PENDING_REAL_CHAIN,
      wallet: WALLET,
      tokenIn: TOKEN_IN,
      sourceRequiredRaw: 1n,
      debit: AFFORDABLE_DEBIT,
      readInFlightBroadcast: readInFlight,
    });

    expect(judgeUniswapSpendability(observation, ROUTE_EXECUTABLE).eligibility.kind)
      .toBe("executable");
    expect(observation.source.read.ok).toBe(true);
    expect(readInFlight).not.toHaveBeenCalled();
  });
});

describe("uniswap spendability on a chain whose pending tag subtracts nothing", () => {
  it("still answers executable when Vex has broadcast nothing that is unresolved", async () => {
    // The `latest` read IS current for every spend this application can know
    // about, so refusing here would refuse a swap for a fact that is not true.
    expect((await observe(PENDING_DEAD_CHAIN, false)).kind).toBe("executable");
  });

  it("refuses by name while one of this wallet's own broadcasts is unresolved", async () => {
    const eligibility = await observe(PENDING_DEAD_CHAIN, true);

    // NOT `insufficient_balance`: nothing is known to be missing. The read
    // simply cannot prove spendability, which is the state contract C2.3 keeps
    // separate precisely so an agent is not told to "trade a smaller size".
    expect(eligibility.kind).toBe("balance_unavailable");
    if (eligibility.kind !== "balance_unavailable") return;
    expect(eligibility.cause).toBe(PENDING_COMPENSATION_CAUSES.inFlightBroadcast);
  });

  it("refuses both legs together, so no half-verdict can be published", async () => {
    const client = spendabilityClient();

    const observation = await observeUniswapSwapSpendability({
      client,
      chainId: PENDING_DEAD_CHAIN,
      wallet: WALLET,
      tokenIn: TOKEN_IN,
      sourceRequiredRaw: 1n,
      debit: AFFORDABLE_DEBIT,
      readInFlightBroadcast: async () => true,
    });

    // A source leg that stayed `ok` would let a later reader conclude the token
    // balance was proven at a tag that proved nothing.
    expect(observation.source.read.ok).toBe(false);
    expect(observation.native.read.ok).toBe(false);
  });
});
