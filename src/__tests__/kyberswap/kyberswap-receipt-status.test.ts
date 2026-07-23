/**
 * `sendKyberTransactionWithReceipt` receipt-status coverage (Agent Scan plan
 * §4.2 rewrite — this test previously also covered `ensureKyberAllowance`,
 * which was replaced by the read-only `planKyberAllowance`; see
 * `kyberswap-allowance.test.ts`). Preserved as the receipt-truth primitive's
 * dedicated behavior test per the card ("generalize as your receipt-truth
 * primitive; rewrite its test, don't delete").
 */

import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import { ErrorCodes } from "../../errors.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";
import { sendKyberTransactionWithReceipt } from "@tools/kyberswap/evm/erc20.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const HASH = `0x${"cd".repeat(32)}` as Hex;

function clients(status: "success" | "reverted", logs: Array<{ address: string; topics: string[]; data: string }> = []) {
  return {
    publicClient: {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status, logs }),
    },
    walletClient: {
      account: { address: OWNER },
      chain: { id: 1 },
      sendTransaction: vi.fn().mockResolvedValue(HASH),
    },
  };
}

describe("sendKyberTransactionWithReceipt", () => {
  it("returns hash + logs on a successful receipt", async () => {
    const logs = [{ address: "0xtoken", topics: ["0xtopic0"], data: "0x01" }];
    const { publicClient, walletClient } = clients("success", logs);

    const result = await sendKyberTransactionWithReceipt(
      publicClient as never,
      walletClient as never,
      { to: META_AGGREGATION_ROUTER_V2, data: "0x" },
    );

    expect(result.hash).toBe(HASH);
    expect(result.receipt.logs).toEqual(logs);
  });

  it("rejects a mined reverted transaction with SWAP_FAILED", async () => {
    const { publicClient, walletClient } = clients("reverted");

    await expect(
      sendKyberTransactionWithReceipt(publicClient as never, walletClient as never, {
        to: META_AGGREGATION_ROUTER_V2,
        data: "0x",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.SWAP_FAILED });
  });

  it("wraps an unrecognized send/receipt-wait throw as SWAP_FAILED", async () => {
    const { publicClient, walletClient } = clients("success");
    walletClient.sendTransaction = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      sendKyberTransactionWithReceipt(publicClient as never, walletClient as never, {
        to: META_AGGREGATION_ROUTER_V2,
        data: "0x",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.SWAP_FAILED });
  });
});
