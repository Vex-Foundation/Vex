import { describe, it, expect } from "vitest";
import { getAddress, decodeFunctionData } from "viem";
import { buildTradePlan } from "../../vex-agent/tools/protocols/trench/handlers/trade/plan.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { TRENCH_DIAMOND_ABI, TRENCH_ERC20_ABI } from "@tools/trench-express/abi.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";

const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");

const base = {
  chainId: 4663,
  token: TOKEN,
  nativeAddress: NATIVE_TOKEN_ADDRESS,
  walletAddress: WALLET,
  sessionId: "s1",
  tokenDecimals: 18,
  minOut: 900n,
  deadline: 111n,
};

describe("buildTradePlan", () => {
  it("BUY is a single payable swap leg to the Diamond carrying the ETH principal", () => {
    const plans = buildTradePlan({ ...base, side: "buy", amountInRaw: 5_000n, amountInHuman: "0.000000000000005", expectedOutRaw: 1_000n });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.eventRole).toBe("swap");
    expect(plans[0]!.txParams.to).toBe(DIAMOND);
    expect(plans[0]!.txParams.value).toBe(5_000n);
    expect(decodeFunctionData({ abi: TRENCH_DIAMOND_ABI, data: plans[0]!.txParams.data }).functionName).toBe("buy");
  });

  it("SELL orders approve (leg 0) BEFORE sell (leg 1), sell is non-payable", () => {
    const plans = buildTradePlan({ ...base, side: "sell", amountInRaw: 100n, amountInHuman: "0.0000000000000001", expectedOutRaw: 5_000n });
    expect(plans).toHaveLength(2);
    expect(plans[0]!.eventRole).toBe("allowance");
    expect(plans[0]!.txParams.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: TRENCH_ERC20_ABI, data: plans[0]!.txParams.data }).functionName).toBe("approve");
    expect(plans[1]!.eventRole).toBe("swap");
    expect(plans[1]!.txParams.to).toBe(DIAMOND);
    expect(plans[1]!.txParams.value).toBe(0n);
    expect(decodeFunctionData({ abi: TRENCH_DIAMOND_ABI, data: plans[1]!.txParams.data }).functionName).toBe("sell");
  });
});
