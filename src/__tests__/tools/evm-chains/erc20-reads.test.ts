import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readErc20Balance,
  readErc20Decimals,
  readErc20Symbol,
  readNativeBalance,
  type Erc20ReadClient,
  type NativeReadClient,
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

describe("the explicit block tag", () => {
  it("is OMITTED unless the caller names one, so no existing consumer moves block", async () => {
    readContract.mockResolvedValueOnce(1n);

    await readErc20Balance(client, TOKEN, OWNER);

    expect(readContract.mock.calls[0]?.[0]).not.toHaveProperty("blockTag");
  });

  it("reaches the read verbatim when the caller names pending", async () => {
    readContract.mockResolvedValueOnce(1n);

    await readErc20Balance(client, TOKEN, OWNER, { blockTag: "pending" });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockTag: "pending" }));
  });

  it("carries the tag and the cancellation signal together", async () => {
    const controller = new AbortController();
    readContract.mockResolvedValueOnce(1n);

    await readErc20Balance(client, TOKEN, OWNER, {
      blockTag: "latest",
      signal: controller.signal,
    });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      blockTag: "latest",
      requestOptions: { signal: controller.signal },
    }));
  });
});

describe("the native sibling read", () => {
  it("reads the ACCOUNT balance at the named tag", async () => {
    const getBalance = vi.fn<NativeReadClient["getBalance"]>();
    getBalance.mockResolvedValueOnce(7n);

    await expect(
      readNativeBalance({ getBalance }, OWNER, { blockTag: "pending" }),
    ).resolves.toBe(7n);
    expect(getBalance).toHaveBeenCalledWith({ address: OWNER, blockTag: "pending" });
  });

  it("omits the tag when the caller names none", async () => {
    const getBalance = vi.fn<NativeReadClient["getBalance"]>();
    getBalance.mockResolvedValueOnce(0n);

    await readNativeBalance({ getBalance }, OWNER);

    expect(getBalance).toHaveBeenCalledWith({ address: OWNER });
  });
});
