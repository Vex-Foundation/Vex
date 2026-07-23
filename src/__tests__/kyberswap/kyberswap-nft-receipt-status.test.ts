import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import { ErrorCodes } from "../../errors.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";
import { ensureErc721Approval, ensureErc1155ApprovalForAll } from "@tools/kyberswap/evm/nft.js";

const NFT = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const HASH = `0x${"ef".repeat(32)}` as Hex;

function clients(readResults: unknown[]) {
  return {
    publicClient: {
      readContract: vi.fn().mockResolvedValueOnce(readResults[0]).mockResolvedValueOnce(readResults[1]),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    },
    walletClient: { account: { address: OWNER }, writeContract: vi.fn().mockResolvedValue(HASH) },
  };
}

describe("Kyber NFT receipt status", () => {
  it("rejects a reverted ERC-721 approval", async () => {
    const { publicClient, walletClient } = clients([false, "0x0000000000000000000000000000000000000000"]);
    await expect(
      ensureErc721Approval(publicClient as never, walletClient as never, NFT, 1n, META_AGGREGATION_ROUTER_V2),
    ).rejects.toMatchObject({ code: ErrorCodes.APPROVAL_FAILED });
  });

  it("rejects a reverted ERC-1155 approval", async () => {
    const { publicClient, walletClient } = clients([false]);
    await expect(
      ensureErc1155ApprovalForAll(publicClient as never, walletClient as never, NFT, META_AGGREGATION_ROUTER_V2),
    ).rejects.toMatchObject({ code: ErrorCodes.APPROVAL_FAILED });
  });
});
