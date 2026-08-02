import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import { waitForSuccessfulReceipt } from "@tools/evm-chains/receipt-guard.js";

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
