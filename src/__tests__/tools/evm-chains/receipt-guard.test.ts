import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import {
  waitForReceiptWithReplacementEvidence,
  waitForSuccessfulReceipt,
} from "@tools/evm-chains/receipt-guard.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;

function clientFor(receipt: { status: "success" | "reverted" }) {
  return {
    waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  };
}

const context = {
  code: ErrorCodes.SWAP_FAILED,
  what: "Swap transaction",
  hint: "Re-quote and retry.",
};

describe("waitForSuccessfulReceipt", () => {
  it("returns the mined successful receipt unchanged", async () => {
    const receipt = { status: "success" as const, logs: [] };
    await expect(waitForSuccessfulReceipt(clientFor(receipt) as never, HASH, context)).resolves.toBe(receipt);
  });

  it("maps a mined reverted receipt to the domain failure with its hash", async () => {
    await expect(
      waitForSuccessfulReceipt(clientFor({ status: "reverted" }) as never, HASH, context),
    ).rejects.toMatchObject({
      code: ErrorCodes.SWAP_FAILED,
      message: expect.stringContaining(HASH),
    });
  });

  it("maps any post-broadcast receipt-wait rejection to CONFIRMATION_UNKNOWN without raw RPC text", async () => {
    const client = {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new VexError(ErrorCodes.RPC_ERROR, "rpc token=secret")),
    };

    await expect(waitForSuccessfulReceipt(client as never, HASH, context, { delayMs: 0 })).rejects.toMatchObject({
      code: "CONFIRMATION_UNKNOWN",
      message: expect.stringContaining(HASH),
    });
    await expect(waitForSuccessfulReceipt(client as never, HASH, context, { delayMs: 0 })).rejects.not.toThrow("rpc token=secret");
  });
});

describe("waitForReceiptWithReplacementEvidence", () => {
  it("preserves a same-nonce repricing instead of silently attributing its receipt to the old hash", async () => {
    const replacementHash = `0x${"cd".repeat(32)}` as Hex;
    const receipt = { status: "success" as const, transactionHash: replacementHash, logs: [] };
    const client = {
      waitForTransactionReceipt: vi.fn(async (params: {
        onReplaced?: (value: Record<string, unknown>) => void;
      }) => {
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
      }),
    };

    await expect(
      waitForReceiptWithReplacementEvidence(client as never, HASH),
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
