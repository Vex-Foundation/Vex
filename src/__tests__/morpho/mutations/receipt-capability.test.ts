/**
 * The check that asks about the NODE rather than the transaction: will this RPC
 * answer `eth_getTransactionReceipt` at all.
 *
 * WHY THIS TEST EXISTS. The funded live probe of 2026-08-17 ran the whole Morpho
 * write path against real Base state and real funds. Everything worked. The
 * approval was built, decoded, bounded, staged, signed and MINED in the head
 * block, and it still ended `unproven`, because the pinned endpoint refused that
 * ONE method with -32602 "Archive requests require a personal token" while
 * serving `eth_call`, `eth_estimateGas` and even `eth_getTransactionByHash` for
 * the very same hash. Real gas bought a result nothing in the system could read.
 *
 * The three cases below are the three that decide whether funds move:
 *
 *   a stated refusal   - must be a refusal, so the execution stops before the
 *                        first signature and NOTHING is spent.
 *   a served receipt   - must not stop anything.
 *   an inconclusive    - must NOT be reported as a refusal. An empty block or a
 *   probe                transport that did not answer proves nothing about the
 *                        method, and blocking a healthy deposit on a momentary
 *                        blip would be a defect of its own.
 *
 * The transport doubles answer only the two methods the probe uses, so a future
 * edit that starts depending on a third method fails here rather than silently.
 */

import { describe, it, expect } from "vitest";

import { probeMorphoReceiptCapability, prepareMorphoVaultExecution } from "@tools/morpho/mutations.js";
import { getMorphoActionClient } from "../../../tools/morpho/mutations/client.js";

const BASE_CHAIN_ID = 8453;

const WALLET = "0x00000000000000000000000000000000000000a1" as const;
const VAULT = "0x00000000000000000000000000000000000000be" as const;
const HEAD_TX = "0x8709ecb8c9e84e0a7b81bc2ce9580e45172bad63b45dfd840f8a7ebe6af0eff8" as const;

/** The verbatim refusal the live probe recorded from `base-rpc.publicnode.com`. */
const PUBLICNODE_REFUSAL = new Error(
  "Invalid parameters were provided to the RPC method. Details: Archive requests require a personal token. "
  + "Get one at: https://www.allnodes.com/publicnode",
);

/**
 * The REAL Morpho action client with only the probe's two methods replaced, so
 * the double's type is the contract's own rather than a hand-written stand-in
 * that a type escape had to force into position.
 */
function clientWith(
  block: { transactions: readonly string[] } | Error,
  receipt: unknown | Error,
) {
  return Object.assign(getMorphoActionClient(BASE_CHAIN_ID), {
    getBlock: () => (block instanceof Error ? Promise.reject(block) : Promise.resolve(block)),
    getTransactionReceipt: () =>
      receipt instanceof Error ? Promise.reject(receipt) : Promise.resolve(receipt),
  });
}

const headBlock = { transactions: [HEAD_TX] };

describe("probing whether an RPC will serve receipts", () => {
  it("calls a stated method-level refusal what it is", async () => {
    const capability = await probeMorphoReceiptCapability(clientWith(headBlock, PUBLICNODE_REFUSAL));

    expect(capability.verdict).toBe("refuses");
    expect(capability.probedTxHash).toBe(HEAD_TX);
    expect(capability.detail).toContain("Archive requests require a personal token");
  });

  it("recognises a plain JSON-RPC method-not-found refusal too", async () => {
    const capability = await probeMorphoReceiptCapability(
      clientWith(headBlock, new Error("RPC error -32601: the method eth_getTransactionReceipt does not exist")),
    );

    expect(capability.verdict).toBe("refuses");
  });

  it("reports a served receipt as served", async () => {
    const capability = await probeMorphoReceiptCapability(
      clientWith(headBlock, { transactionHash: HEAD_TX, status: "success" }),
    );

    expect(capability.verdict).toBe("serves");
    expect(capability.detail).toBeNull();
  });

  // Absence of evidence, not evidence of refusal.
  it("stays UNPROVEN when the latest block carries no transaction to probe with", async () => {
    const capability = await probeMorphoReceiptCapability(clientWith({ transactions: [] }, PUBLICNODE_REFUSAL));

    expect(capability.verdict).toBe("unproven");
    expect(capability.probedTxHash).toBeNull();
  });

  it("stays UNPROVEN when the receipt read merely timed out", async () => {
    const capability = await probeMorphoReceiptCapability(
      clientWith(headBlock, new Error("The request took too long to respond")),
    );

    expect(capability.verdict).toBe("unproven");
  });
});

describe("what a refusing node does to an execution", () => {
  it("aborts the whole preparation before any spending, and says no funds were spent", async () => {
    const client = clientWith(headBlock, PUBLICNODE_REFUSAL);

    await expect(
      prepareMorphoVaultExecution(
        {
          chainId: 8453,
          vaultAddress: VAULT,
          direction: "deposit",
          amountRaw: 200_000n,
          slippageBps: 100,
          walletAddress: WALLET,
        },
        { client },
      ),
    ).rejects.toMatchObject({
      code: "MORPHO_RPC_ERROR",
      message: expect.stringContaining("will not answer eth_getTransactionReceipt"),
    });
  });

  it("does not read the vault at all once the node has refused", async () => {
    let vaultReads = 0;
    const client = Object.assign(getMorphoActionClient(BASE_CHAIN_ID), {
      getBlock: () => Promise.resolve(headBlock),
      getTransactionReceipt: () => Promise.reject(PUBLICNODE_REFUSAL),
      readContract: () => {
        vaultReads += 1;
        return Promise.resolve(0n);
      },
      multicall: () => {
        vaultReads += 1;
        return Promise.resolve([]);
      },
    });

    await expect(
      prepareMorphoVaultExecution(
        {
          chainId: 8453,
          vaultAddress: VAULT,
          direction: "deposit",
          amountRaw: 200_000n,
          slippageBps: 100,
          walletAddress: WALLET,
        },
        { client },
      ),
    ).rejects.toThrow();

    expect(vaultReads).toBe(0);
  });
});
