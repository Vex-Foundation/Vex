/**
 * The bounded receipt-wait retry (`receipt-guard.ts`).
 *
 * A single `waitForTransactionReceipt` throw used to be enough to declare a
 * broadcast ambiguous — which is how a KyberSwap swap that had ALREADY
 * confirmed on-chain ended up recorded `pending` after one RPC hiccup. The
 * wait is a READ, so retrying it is safe; the broadcast itself is never
 * retried anywhere in this flow (rule 90 — a re-send can double-spend).
 */

import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import {
  waitForReceiptWithRetry,
  waitForSuccessfulReceipt,
  RECEIPT_WAIT_ATTEMPTS,
} from "@tools/evm-chains/receipt-guard.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const RECEIPT = { status: "success" as const, logs: [] };

const context = { code: ErrorCodes.SWAP_FAILED, what: "Swap transaction", hint: "Re-quote and retry." };

describe("waitForReceiptWithRetry", () => {
  it("returns the receipt on the first attempt without waiting", async () => {
    const client = { waitForTransactionReceipt: vi.fn().mockResolvedValue(RECEIPT) };

    await expect(waitForReceiptWithRetry(client as never, HASH)).resolves.toBe(RECEIPT);
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it("recovers a transient wait failure — the swap is NOT ambiguous", async () => {
    const client = {
      waitForTransactionReceipt: vi.fn()
        .mockRejectedValueOnce(new Error("HTTP request failed"))
        .mockResolvedValue(RECEIPT),
    };

    await expect(waitForReceiptWithRetry(client as never, HASH, { delayMs: 0 })).resolves.toBe(RECEIPT);
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it("rethrows the LAST error after a bounded number of attempts", async () => {
    const client = {
      waitForTransactionReceipt: vi.fn()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValue(new Error("last")),
    };

    await expect(waitForReceiptWithRetry(client as never, HASH, { delayMs: 0 })).rejects.toThrow("last");
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(RECEIPT_WAIT_ATTEMPTS);
  });

  it("does not retry a MINED revert — a receipt that resolved is a definitive answer", async () => {
    const client = { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted", logs: [] }) };

    await expect(waitForReceiptWithRetry(client as never, HASH, { delayMs: 0 })).resolves.toMatchObject({
      status: "reverted",
    });
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });
});

describe("waitForSuccessfulReceipt — retry is applied at the confirmation boundary too", () => {
  it("returns the receipt after a transient wait failure instead of CONFIRMATION_UNKNOWN", async () => {
    const client = {
      waitForTransactionReceipt: vi.fn()
        .mockRejectedValueOnce(new VexError(ErrorCodes.RPC_ERROR, "rpc token=secret"))
        .mockResolvedValue(RECEIPT),
    };

    await expect(
      waitForSuccessfulReceipt(client as never, HASH, context, { delayMs: 0 }),
    ).resolves.toBe(RECEIPT);
  });

  it("still reports CONFIRMATION_UNKNOWN once the bound is exhausted", async () => {
    const client = {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new VexError(ErrorCodes.RPC_ERROR, "rpc token=secret")),
    };

    await expect(
      waitForSuccessfulReceipt(client as never, HASH, context, { delayMs: 0 }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_UNKNOWN", message: expect.stringContaining(HASH) });
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(RECEIPT_WAIT_ATTEMPTS);
  });
});
