import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress } from "viem";

import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_DEPOSIT_FUNCTION_ABI,
  LIGHTER_DEPOSIT_SELECTOR,
  LIGHTER_USDC_ASSET_INDEX,
} from "@tools/lighter/wallet-funding/constants.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

describe("buildLighterDepositCalldata", () => {
  it("encodes a USDC perps deposit crediting the wallet's own address", () => {
    const cd = buildLighterDepositCalldata({ to: WALLET, amountUnits: 11_000_000n });
    expect(cd.to).toBe(getAddress(LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS));
    expect(cd.value).toBe(0n);
    expect(cd.assetIndex).toBe(LIGHTER_USDC_ASSET_INDEX);
    expect(cd.routeType).toBe(0);
    expect(cd.data.startsWith(LIGHTER_DEPOSIT_SELECTOR)).toBe(true);

    const decoded = decodeFunctionData({ abi: LIGHTER_DEPOSIT_FUNCTION_ABI, data: cd.data });
    expect(decoded.functionName).toBe("deposit");
    expect(decoded.args).toEqual([getAddress(WALLET), LIGHTER_USDC_ASSET_INDEX, 0, 11_000_000n]);
  });

  it("encodes route=spot as routeType 1", () => {
    const cd = buildLighterDepositCalldata({ to: WALLET, amountUnits: 5_000_000n, route: "spot" });
    expect(cd.routeType).toBe(1);
    const decoded = decodeFunctionData({ abi: LIGHTER_DEPOSIT_FUNCTION_ABI, data: cd.data });
    expect(decoded.args?.[2]).toBe(1);
  });

  it("rejects an amount below the 1 USDC credited minimum", () => {
    expect(() => buildLighterDepositCalldata({ to: WALLET, amountUnits: 999_999n })).toThrow(/minimum/);
  });

  it("rejects an invalid recipient address", () => {
    expect(() => buildLighterDepositCalldata({ to: "0xnope", amountUnits: 11_000_000n })).toThrow(/valid EVM address/);
  });

  it("rejects an out-of-range asset index", () => {
    expect(() => buildLighterDepositCalldata({ to: WALLET, amountUnits: 11_000_000n, assetIndex: 0 })).toThrow(/assetIndex/);
    expect(() => buildLighterDepositCalldata({ to: WALLET, amountUnits: 11_000_000n, assetIndex: 99 })).toThrow(/assetIndex/);
  });
});
