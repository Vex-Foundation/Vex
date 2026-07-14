/**
 * Relay bridge executor — FAIL-CLOSED two-phase ordering (Item 1, fund safety).
 *
 * `executeRelayBridge` MUST pre-validate the WHOLE quote before broadcasting any
 * step: a single invalid step — even the LAST one — aborts the bridge with ZERO
 * `sendTransaction` calls, so a valid early step can never leave funds mid-bridge
 * on a quote that is rejected further down. A fully-valid quote broadcasts every
 * transaction strictly in order.
 *
 * No live network: the inclusive chain resolver + local client factory are mocked
 * so `sendTransaction` is a spy. Quotes carry NO `requestId`, so the bounded
 * status poll never runs (finalStatus = "pending").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress } from "viem";

const sendTransaction = vi.fn();
const waitForTransactionReceipt = vi.fn();

const resolveInclusiveEvmChain = vi.fn();
vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: (...a: unknown[]) => resolveInclusiveEvmChain(...a),
}));

const getLocalEvmClients = vi.fn();
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalEvmClients: (...a: unknown[]) => getLocalEvmClients(...a),
}));

// Khalani client factories are only hit on the non-local branch — stub so the
// import resolves without pulling the real viem clients.
vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: vi.fn(),
  createDynamicWalletClient: vi.fn(),
}));

// getRelayClient is used only by the terminal-status poll; quotes without a
// requestId never poll, so a bare stub suffices.
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: vi.fn(() => ({ getIntentStatus: vi.fn() })),
}));

import { executeRelayBridge } from "@tools/relay/execute.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const ORIGIN = 8453; // Base
const DESTINATION = 4663; // Robinhood Chain
const APPROVE_TO = "0x2222222222222222222222222222222222222222";
const DEPOSIT_TO = "0x3333333333333333333333333333333333333333";

const signer = {
  family: "eip155",
  address: "0x1111111111111111111111111111111111111111",
  privateKey: `0x${"22".repeat(32)}`,
} as unknown as ChainWallet;

function step(id: string, chainId: number, to: string, value = "0", data = "0x") {
  return { id, kind: "transaction", items: [{ data: { to, value, data, chainId } }] };
}

beforeEach(() => {
  sendTransaction.mockReset();
  waitForTransactionReceipt.mockReset();
  resolveInclusiveEvmChain.mockReset();
  getLocalEvmClients.mockReset();

  waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  resolveInclusiveEvmChain.mockImplementation(async (input: string) => ({
    source: "local",
    family: "eip155",
    chainId: Number(input),
    config: { chainId: Number(input) },
  }));
  getLocalEvmClients.mockReturnValue({
    publicClient: { waitForTransactionReceipt },
    walletClient: { account: { address: signer.address }, chain: { id: ORIGIN }, sendTransaction },
  });
});

describe("executeRelayBridge — fail-closed pre-validation (PHASE 1)", () => {
  it("(a) LAST step invalid (chainId outside origin/destination) → ZERO broadcasts", async () => {
    const quote = {
      steps: [
        step("approve", ORIGIN, APPROVE_TO), // valid first step
        step("deposit", 999, DEPOSIT_TO, "1000", "0xabcd"), // INVALID last step
      ],
    } as unknown as RelayQuoteResponse;

    await expect(
      executeRelayBridge({ quote, signer, originChainId: ORIGIN, destinationChainId: DESTINATION }),
    ).rejects.toMatchObject({ code: "RELAY_STEP_CHAIN_MISMATCH" });

    // The whole point: the valid first step must NOT have broadcast.
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("(a2) LAST step is a non-transaction (signature) kind → ZERO broadcasts", async () => {
    const quote = {
      steps: [
        step("approve", ORIGIN, APPROVE_TO),
        { id: "permit", kind: "signature", items: [{}] }, // unsupported LAST step
      ],
    } as unknown as RelayQuoteResponse;

    await expect(
      executeRelayBridge({ quote, signer, originChainId: ORIGIN, destinationChainId: DESTINATION }),
    ).rejects.toMatchObject({ code: "RELAY_UNSUPPORTED_STEP" });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("(a3) LAST step sender != selected wallet → ZERO broadcasts", async () => {
    const quote = {
      steps: [
        step("approve", ORIGIN, APPROVE_TO),
        {
          id: "deposit",
          kind: "transaction",
          items: [{ data: { from: "0x9999999999999999999999999999999999999999", to: DEPOSIT_TO, value: "1000", data: "0xabcd", chainId: DESTINATION } }],
        },
      ],
    } as unknown as RelayQuoteResponse;

    await expect(
      executeRelayBridge({ quote, signer, originChainId: ORIGIN, destinationChainId: DESTINATION }),
    ).rejects.toMatchObject({ code: "RELAY_BRIDGE_FAILED" });
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe("executeRelayBridge — ordered broadcast (PHASE 2)", () => {
  it("(b) valid multi-step quote → every tx broadcast strictly in order", async () => {
    sendTransaction.mockResolvedValueOnce("0xaaa").mockResolvedValueOnce("0xbbb");
    const quote = {
      steps: [
        step("approve", ORIGIN, APPROVE_TO, "0", "0x"),
        step("deposit", DESTINATION, DEPOSIT_TO, "1000", "0xabcd"),
      ],
    } as unknown as RelayQuoteResponse;

    const result = await executeRelayBridge({
      quote,
      signer,
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
    });

    expect(sendTransaction).toHaveBeenCalledTimes(2);
    // Order preserved: approve leg first, deposit leg second.
    expect(sendTransaction.mock.calls[0]![0].to).toBe(getAddress(APPROVE_TO));
    expect(sendTransaction.mock.calls[1]![0].to).toBe(getAddress(DEPOSIT_TO));
    expect(sendTransaction.mock.calls[1]![0].value).toBe(1000n);
    // Each broadcast waits for its receipt before the next.
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(result.txHashes).toEqual(["0xaaa", "0xbbb"]);
    // Per-hop records pair each hash with the chain it broadcast on (origin
    // approve → ORIGIN, deposit → DESTINATION); txHashes[i] === transactions[i].hash.
    expect(result.transactions).toEqual([
      { chainId: ORIGIN, hash: "0xaaa" },
      { chainId: DESTINATION, hash: "0xbbb" },
    ]);
    expect(result.finalStatus).toBe("pending"); // no requestId → no poll
  });

  it("aborts before the next broadcast when a mined step reverted", async () => {
    sendTransaction.mockResolvedValueOnce("0xaaa").mockResolvedValueOnce("0xbbb");
    waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    const quote = {
      steps: [
        step("approve", ORIGIN, APPROVE_TO, "0", "0x"),
        step("deposit", DESTINATION, DEPOSIT_TO, "1000", "0xabcd"),
      ],
    } as unknown as RelayQuoteResponse;

    await expect(
      executeRelayBridge({ quote, signer, originChainId: ORIGIN, destinationChainId: DESTINATION }),
    ).rejects.toMatchObject({ code: "RELAY_BRIDGE_FAILED" });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});
