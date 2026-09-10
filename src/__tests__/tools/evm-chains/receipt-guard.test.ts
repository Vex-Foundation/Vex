import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { mainnet } from "viem/chains";

import { testPublicClient } from "../../helpers/viem-public-client.js";

import { ErrorCodes, VexError } from "../../../errors.js";
import {
  waitForReceiptWithReplacementEvidence,
  waitForSuccessfulReceipt,
  type ReceiptWaitClient,
} from "@tools/evm-chains/receipt-guard.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;

/**
 * A real viem client whose only replaced method is the one this module calls.
 *
 * The replacement DECLARES the three fields the module actually passes
 * (`hash`, `timeout`, `onReplaced`), so each test reads what the guard asked
 * for; production keeps calling viem's own declared signature.
 */
function receiptClient(
  waitForTransactionReceipt: (params: {
    readonly hash: Hex;
    readonly timeout?: number;
    readonly onReplaced?: (value: Record<string, unknown>) => void;
  }) => Promise<unknown>,
): ReceiptWaitClient {
  return testPublicClient(mainnet, { waitForTransactionReceipt });
}

function clientFor(receipt: { status: "success" | "reverted" }): ReceiptWaitClient {
  return receiptClient(async () => receipt);
}

const context = {
  code: ErrorCodes.SWAP_FAILED,
  what: "Swap transaction",
  hint: "Re-quote and retry.",
};

describe("waitForSuccessfulReceipt", () => {
  it("returns the mined successful receipt unchanged", async () => {
    const receipt = { status: "success" as const, logs: [] };
    await expect(waitForSuccessfulReceipt(clientFor(receipt), HASH, context)).resolves.toBe(receipt);
  });

  it("maps a mined reverted receipt to the domain failure with its hash", async () => {
    await expect(
      waitForSuccessfulReceipt(clientFor({ status: "reverted" }), HASH, context),
    ).rejects.toMatchObject({
      code: ErrorCodes.SWAP_FAILED,
      message: expect.stringContaining(HASH),
    });
  });

  it("maps any post-broadcast receipt-wait rejection to CONFIRMATION_UNKNOWN without raw RPC text", async () => {
    const client = receiptClient(async () => {
      throw new VexError(ErrorCodes.RPC_ERROR, "rpc token=secret");
    });

    await expect(waitForSuccessfulReceipt(client, HASH, context, { delayMs: 0 })).rejects.toMatchObject({
      code: "CONFIRMATION_UNKNOWN",
      message: expect.stringContaining(HASH),
    });
    await expect(waitForSuccessfulReceipt(client, HASH, context, { delayMs: 0 })).rejects.not.toThrow("rpc token=secret");
  });
});

describe("waitForReceiptWithReplacementEvidence", () => {
  it("preserves a same-nonce repricing instead of silently attributing its receipt to the old hash", async () => {
    const replacementHash = `0x${"cd".repeat(32)}` as Hex;
    const receipt = { status: "success" as const, transactionHash: replacementHash, logs: [] };
    const client = receiptClient(async (params) => {
      params.onReplaced?.({
        reason: "repriced",
        replacedTransaction: { hash: HASH },
        transaction: {
          hash: replacementHash,
          from: "0x1111111111111111111111111111111111111111",
          nonce: 7,
          to: "0x2222222222222222222222222222222222222222",
          input: "0x1234",
          value: 0n,
          gas: 200000n,
          maxFeePerGas: 20000000000n,
          maxPriorityFeePerGas: 2000000000n,
        },
        transactionReceipt: receipt,
      });
      return receipt;
    });

    await expect(
      waitForReceiptWithReplacementEvidence(client, HASH),
    ).resolves.toEqual({
      receipt,
      replacement: {
        reason: "repriced",
        replacedTxHash: HASH,
        replacementTxHash: replacementHash,
        fromAddress: "0x1111111111111111111111111111111111111111",
        nonce: 7,
        to: "0x2222222222222222222222222222222222222222",
        data: "0x1234",
        value: 0n,
        gas: 200000n,
        maxFeePerGas: 20000000000n,
        maxPriorityFeePerGas: 2000000000n,
      },
    });
  });
});

it("bounds the whole receipt wait even when the client never settles its promise", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const wait = vi.fn(() => new Promise<never>(() => {}));
    const pending = waitForReceiptWithReplacementEvidence(receiptClient(wait), HASH, { timeoutMs: 50 });
    const refused = expect(pending).rejects.toMatchObject({ name: "ReceiptWaitDeadlineError", message: expect.stringContaining("awaiting inclusion") });
    await vi.advanceTimersByTimeAsync(50);
    await refused;
    expect(wait).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(["repriced", "cancelled", "replaced"] as const)("does not attribute a %s replacement to the original transaction", async reason => {
  const replacementHash = `0x${"cd".repeat(32)}` as const;
  const wait = vi.fn(async (params: { onReplaced?: (value: Record<string, unknown>) => void }) => {
    params.onReplaced?.({ reason, replacedTransaction: { hash: HASH }, transaction: {
      hash: replacementHash, from: "0x1111111111111111111111111111111111111111", nonce: 7,
      to: "0x2222222222222222222222222222222222222222", input: "0x", value: 0n,
      gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
    }, transactionReceipt: { status: "success", transactionHash: replacementHash } });
    return { status: "success", transactionHash: replacementHash };
  });
  await expect(waitForSuccessfulReceipt(receiptClient(wait), HASH, context, { delayMs: 0 }))
    .rejects.toMatchObject({ code: "CONFIRMATION_UNKNOWN", message: expect.stringContaining("replacement receipt"), cause: { name: "UnattributedReceiptReplacementError" } });
  expect(wait).toHaveBeenCalledOnce();
});
