import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import { decodeTrenchSettlement } from "../../vex-agent/tools/protocols/trench/settlement-decoder.js";
import type { SettlementDecoderInput } from "../../vex-agent/sync/settlement-decoders.js";
import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";

const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");

interface RawLog { address: string; topics: readonly string[]; data: string }

function transferLog(from: Address, to: Address, value: bigint): RawLog {
  const [topic0, t1, t2] = encodeEventTopics({
    abi: [{ type: "event", name: "Transfer", inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ] }],
    eventName: "Transfer",
    args: { from, to },
  }) as [Hex, Hex, Hex];
  return { address: TOKEN, topics: [topic0, t1, t2], data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}

function curveEventLog(name: "Bought" | "Sold", a: Address, b: Address, v1: bigint, v2: bigint, v3: bigint): RawLog {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: name }) as [Hex];
  return {
    address: DIAMOND,
    topics: [topic0],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [a, b, v1, v2, v3],
    ),
  };
}

function input(over: Partial<SettlementDecoderInput> & { receipt: unknown }): SettlementDecoderInput {
  return {
    protocolExecutionId: 1,
    chainId: 4663,
    walletAddress: WALLET,
    tokenInAddress: null,
    tokenOutAddress: null,
    eventRole: "swap",
    ...over,
  };
}

describe("decodeTrenchSettlement (repair-sweep decoder — establishes both legs)", () => {
  it("decodes a BUY receipt: input from route_provenance (msg.value), output from Bought/Transfer", () => {
    const buyInputWei = 500_000_000_000_000n;
    const tokensOut = 197_913_781_308_210_736_292_461n;
    const receipt = { logs: [
      curveEventLog("Bought", WALLET, TOKEN, 495_000_000_000_000n, tokensOut, 2_501_584_250n),
      transferLog(DIAMOND, WALLET, tokensOut),
    ] };
    const out = decodeTrenchSettlement(input({
      receipt,
      tokenInAddress: NATIVE_TOKEN_ADDRESS,
      tokenOutAddress: TOKEN,
      routeProvenance: { plannedInputRaw: buyInputWei.toString(), side: "buy" },
    }));
    expect(out).toEqual({ executedAmountInRaw: buyInputWei.toString(), executedAmountOutRaw: tokensOut.toString() });
  });

  it("decodes a SELL receipt (real funded values): tokens in + ETH out via the Sold cross-check", () => {
    const ethOut = 784_080_000_000_000n;
    const tokensIn = 316_699_669_544_688_242_764_692n;
    const receipt = { logs: [
      transferLog(WALLET, DIAMOND, tokensIn),
      curveEventLog("Sold", WALLET, TOKEN, ethOut, tokensIn, 2_500_000_000n),
    ] };
    const out = decodeTrenchSettlement(input({
      receipt,
      tokenInAddress: TOKEN,
      tokenOutAddress: NATIVE_TOKEN_ADDRESS,
      routeProvenance: { plannedInputRaw: tokensIn.toString(), side: "sell" },
    }));
    expect(out).toEqual({ executedAmountInRaw: tokensIn.toString(), executedAmountOutRaw: ethOut.toString() });
  });

  it("declines the allowance leg (no settlement to decode)", () => {
    const receipt = { logs: [] };
    expect(decodeTrenchSettlement(input({ receipt, eventRole: "allowance", tokenInAddress: TOKEN, tokenOutAddress: NATIVE_TOKEN_ADDRESS }))).toBeNull();
  });

  it("declines a BUY when the planned input was not persisted", () => {
    const receipt = { logs: [curveEventLog("Bought", WALLET, TOKEN, 1n, 2n, 3n), transferLog(DIAMOND, WALLET, 2n)] };
    expect(decodeTrenchSettlement(input({ receipt, tokenInAddress: NATIVE_TOKEN_ADDRESS, tokenOutAddress: TOKEN, routeProvenance: {} }))).toBeNull();
  });
});
