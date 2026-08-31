/**
 * The per-chain L1 data-fee capability table, and the fail-closed rule around it.
 *
 * ## What these tests pin
 *
 * A rollup's posting cost is invisible to `gasLimit * gasPrice`, so a debit
 * computed without it is short by exactly the amount that decides whether the
 * last leg of a swap can be paid. Two failure shapes matter and they are
 * different:
 *
 *   - a chain nobody measured must REFUSE, not price at zero. Rabby's
 *     `CAN_ESTIMATE_L1_FEE_CHAINS` allowlist treats every chain outside it as
 *     free, which is an inference about economics drawn from the absence of a
 *     contract;
 *   - a chain whose oracle read FAILS must refuse too, for the same reason: an
 *     unknown fee is not a zero fee.
 *
 * The coverage test is the one that keeps this honest over time: it walks the
 * venue registries themselves, so a chain added to KyberSwap or Uniswap without
 * a measured row fails here rather than under-charging a wallet in production.
 */

import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { getKyberChains } from "@tools/kyberswap/chains.js";
import {
  estimateL1DataFee,
  getL1DataFeeCapability,
  listL1DataFeeCapabilities,
  OP_STACK_GAS_PRICE_ORACLE_ADDRESS,
} from "@tools/evm-chains/l1-data-fee.js";
import { listLocalChains } from "@tools/evm-chains/registry.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;

function transaction() {
  return {
    to: WALLET,
    gas: 21_000n,
    nonce: 7,
    maxFeePerGasWei: 5_000_000_000n,
    maxPriorityFeePerGasWei: 1_000_000_000n,
  };
}

describe("the capability table covers every chain a swap venue serves", () => {
  it("has a measured row for each KyberSwap aggregator chain", () => {
    const missing = getKyberChains()
      .filter((chain) => chain.aggregator)
      .filter((chain) => getL1DataFeeCapability(chain.chainId) === undefined)
      .map((chain) => `${chain.slug} (${chain.chainId})`);

    expect(missing).toEqual([]);
  });

  it("has a measured row for each locally registered chain", () => {
    const missing = listLocalChains("eip155")
      .filter((chain) => getL1DataFeeCapability(chain.id) === undefined)
      .map((chain) => `${chain.name} (${chain.id})`);

    expect(missing).toEqual([]);
  });

  it("states the measurement behind every row, never a convention", () => {
    for (const capability of listL1DataFeeCapabilities()) {
      expect(capability.evidence).toContain("measured live");
      expect(capability.evidence.length).toBeGreaterThan(40);
    }
  });

  it("marks the chains whose oracle answered as oracle chains", () => {
    // Measured 2026-08-31: getL1Fee returned a non-zero wei figure on each.
    for (const chainId of [10, 8453, 5000, 2020, 130, 4326]) {
      expect(getL1DataFeeCapability(chainId)?.mechanism).toBe("op_stack_oracle");
    }
    // Arbitrum and its Orbit chain fold the posting cost into the gas UNITS,
    // so an oracle figure added on top would be counted twice.
    for (const chainId of [42161, 4663]) {
      expect(getL1DataFeeCapability(chainId)?.mechanism).toBe("in_gas_estimate");
    }
  });
});

describe("pricing one transaction's L1 component", () => {
  it("asks the real predeploy and returns the wei it answered", async () => {
    const readContract = vi.fn(async () => 1_373_207_605n);

    const estimate = await estimateL1DataFee({ readContract }, {
      chainId: 8453,
      transaction: transaction(),
    });

    expect(estimate).toMatchObject({ kind: "priced", additionalWei: 1_373_207_605n });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: OP_STACK_GAS_PRICE_ORACLE_ADDRESS,
      functionName: "getL1Fee",
    }));
  });

  it("prices the bytes a SIGNED transaction would post, not a shorter unsigned one", async () => {
    // Typed by what it RECEIVES, so the serialized payload can be read off the
    // mock without a cast.
    const readContract = vi.fn(async (_parameters: { args: readonly [`0x${string}`] }) => 1n);

    await estimateL1DataFee({ readContract }, { chainId: 8453, transaction: transaction() });

    const call = readContract.mock.calls[0]?.[0];
    if (call === undefined) throw new Error("getL1Fee was never called");
    const serialized = call.args[0];
    // viem's own estimator serializes unsigned, which understates the payload by
    // the signature. A reserve computed from too few bytes is a reserve that is
    // short, so the stub signature is present and its bytes are the expensive
    // (non-zero) kind.
    expect(serialized).toContain("ff".repeat(32));
  });

  it("adds nothing for a chain that already charges the cost inside its gas estimate", async () => {
    const readContract = vi.fn(async () => 999n);

    const estimate = await estimateL1DataFee({ readContract }, {
      chainId: 42161,
      transaction: transaction(),
    });

    expect(estimate).toEqual({
      kind: "priced",
      capability: getL1DataFeeCapability(42161),
      additionalWei: 0n,
    });
    // The point of the mechanism: no oracle is consulted at all, so a stray
    // contract at that address on an Orbit chain could not double-charge us.
    expect(readContract).not.toHaveBeenCalled();
  });

  it("REFUSES for a chain nobody measured instead of pricing it at zero", async () => {
    const readContract = vi.fn(async () => 0n);

    const estimate = await estimateL1DataFee({ readContract }, {
      chainId: 424_242,
      transaction: transaction(),
    });

    expect(estimate).toEqual({
      kind: "unavailable",
      chainId: 424_242,
      cause: "l1_data_fee_capability_unknown",
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("REFUSES when the oracle read fails, and keeps the provider's text out of it", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("HTTP 500 from https://node.example/key-abcdef");
    });

    const estimate = await estimateL1DataFee({ readContract }, {
      chainId: 8453,
      transaction: transaction(),
    });

    expect(estimate).toEqual({
      kind: "unavailable",
      chainId: 8453,
      cause: "l1_data_fee_oracle_read_failed",
    });
    if (estimate.kind !== "unavailable") throw new Error("expected a refusal");
    expect(estimate.cause).not.toContain("node.example");
  });

  it("forwards the caller's cancellation signal to the oracle read", async () => {
    const controller = new AbortController();
    const readContract = vi.fn(async () => 1n);

    await estimateL1DataFee({ readContract }, {
      chainId: 8453,
      transaction: transaction(),
      signal: controller.signal,
    });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      requestOptions: { signal: controller.signal },
    }));
  });
});
