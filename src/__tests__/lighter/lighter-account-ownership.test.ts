import { describe, expect, it, vi } from "vitest";

import {
  readUniqueLighterCoreMasterAccount,
  readUniqueLighterMasterAccount,
} from "@tools/lighter/wallet-funding/account-ownership.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const OTHER_WALLET = "0xF0E6c8832d8A045a579c0DeB5C33e00c67dA5cBf";

function response(
  subAccounts: Array<{ account_type: number; index: number; l1_address: string }>,
  nextCursor?: string,
) {
  return {
    code: 200,
    l1_address: WALLET,
    sub_accounts: subAccounts,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
}

describe("Lighter Core account ownership resolution", () => {
  it("reads every page and returns the one wallet-owned master account", async () => {
    const getAccountsByL1Address = vi.fn()
      .mockResolvedValueOnce(response([
        { account_type: 1, index: 43, l1_address: WALLET },
      ], "page-2"))
      .mockResolvedValueOnce(response([
        { account_type: 0, index: 42, l1_address: WALLET },
      ]));

    await expect(readUniqueLighterCoreMasterAccount(
      { getAccountsByL1Address },
      WALLET,
    )).resolves.toBe(42);
    expect(getAccountsByL1Address).toHaveBeenNthCalledWith(1, "core", {
      l1Address: WALLET,
      cursor: undefined,
    });
    expect(getAccountsByL1Address).toHaveBeenNthCalledWith(2, "core", {
      l1Address: WALLET,
      cursor: "page-2",
    });
  });

  it("binds RHC ownership reads to the RHC account namespace", async () => {
    const getAccountsByL1Address = vi.fn().mockResolvedValue(response([
      { account_type: 0, index: 142, l1_address: WALLET },
    ]));

    await expect(readUniqueLighterMasterAccount(
      { getAccountsByL1Address },
      "rhc",
      WALLET,
    )).resolves.toBe(142);
    expect(getAccountsByL1Address).toHaveBeenCalledWith("rhc", {
      l1Address: WALLET,
      cursor: undefined,
    });
  });

  it("refuses an account row owned by another wallet", async () => {
    const getAccountsByL1Address = vi.fn().mockResolvedValue(response([
      { account_type: 0, index: 42, l1_address: OTHER_WALLET },
    ]));

    await expect(readUniqueLighterCoreMasterAccount(
      { getAccountsByL1Address },
      WALLET,
    )).rejects.toThrow("another wallet");
  });

  it("refuses multiple master accounts instead of guessing", async () => {
    const getAccountsByL1Address = vi.fn().mockResolvedValue(response([
      { account_type: 0, index: 42, l1_address: WALLET },
      { account_type: 0, index: 44, l1_address: WALLET },
    ]));

    await expect(readUniqueLighterCoreMasterAccount(
      { getAccountsByL1Address },
      WALLET,
    )).rejects.toThrow("one uniquely owned");
  });

  it("refuses a repeated pagination cursor", async () => {
    const getAccountsByL1Address = vi.fn()
      .mockResolvedValueOnce(response([], "same"))
      .mockResolvedValueOnce(response([], "same"));

    await expect(readUniqueLighterCoreMasterAccount(
      { getAccountsByL1Address },
      WALLET,
    )).rejects.toThrow("cursor repeated");
  });
});
