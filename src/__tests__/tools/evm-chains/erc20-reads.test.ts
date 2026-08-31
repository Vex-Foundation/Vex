import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readErc20Balance,
  readErc20Decimals,
  readErc20Symbol,
  type Erc20ReadClient,
} from "@tools/evm-chains/erc20-reads.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const readContract = vi.fn<Erc20ReadClient["readContract"]>();
const client: Erc20ReadClient = { readContract };

beforeEach(() => {
  readContract.mockReset();
});

describe("single-token ERC-20 reads", () => {
  it("reads balanceOf with owner and forwards the exact cancellation signal", async () => {
    const controller = new AbortController();
    readContract.mockResolvedValueOnce(123n);

    await expect(readErc20Balance(client, TOKEN, OWNER, { signal: controller.signal })).resolves.toBe(123n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: TOKEN,
      functionName: "balanceOf",
      args: [OWNER],
      requestOptions: { signal: controller.signal },
    }));
  });

  it("converts decimals to number and forwards cancellation", async () => {
    const controller = new AbortController();
    readContract.mockResolvedValueOnce(6);

    await expect(readErc20Decimals(client, TOKEN, { signal: controller.signal })).resolves.toBe(6);
    const call = readContract.mock.calls[0]?.[0];
    expect(call).toEqual(expect.objectContaining({
      address: TOKEN,
      functionName: "decimals",
      requestOptions: { signal: controller.signal },
    }));
  });

  it("returns the contract symbol and forwards cancellation", async () => {
    const controller = new AbortController();
    readContract.mockResolvedValueOnce("USDC");

    await expect(readErc20Symbol(client, TOKEN, { signal: controller.signal })).resolves.toBe("USDC");
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: TOKEN,
      functionName: "symbol",
      requestOptions: { signal: controller.signal },
    }));
  });

  it("omits requestOptions when the caller supplies no signal", async () => {
    readContract.mockResolvedValueOnce(0n);

    await readErc20Balance(client, TOKEN, OWNER);
    expect(readContract.mock.calls[0]?.[0]).not.toHaveProperty("requestOptions");
  });
});
