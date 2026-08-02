/**
 * Launch receipt decoding — WHICH positional field of `Bought` is tokens-out.
 *
 * `Bought(a, b, v1, v2, v3)` has opaque names in the verified ABI. The funded
 * probe pinned in `evm.test.ts:141-149` proves the mapping: v1 = ETH in
 * (post-fee), **v2 = tokens out**, v3 = price. Reading v3 as tokens-out would
 * write a PRICE into the user's launch record — off by many orders of
 * magnitude, and consumed downstream as an amount.
 */

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import {
  decodeLaunchReceipt,
  type SettlementLog,
} from "@vex-agent/tools/protocols/trench/handlers/launch/settlement.js";

const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");

function tokenCreatedLog(token: Address, creator: Address, address: Address = DIAMOND): SettlementLog {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: "TokenCreated" }) as [Hex];
  return {
    address,
    topics: [topic0],
    data: encodeAbiParameters(
      [
        { type: "address" }, { type: "address" }, { type: "uint8" },
        { type: "uint8" }, { type: "bytes" }, { type: "uint256" },
      ],
      [token, creator, 0, 0, "0x", 1n],
    ),
  };
}

function boughtLog(a: Address, b: Address, v1: bigint, v2: bigint, v3: bigint): SettlementLog {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: "Bought" }) as [Hex];
  return {
    address: DIAMOND,
    topics: [topic0],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [a, b, v1, v2, v3],
    ),
  };
}

describe("decodeLaunchReceipt", () => {
  it("reads the prebuy's tokens-out from Bought.v2, never the v3 price", () => {
    const ethIn = 297_000_000_000_000n;
    const tokensOut = 197_913_781_308_210_736_292_461n;
    const price = 2_501_584_250n;

    const decoded = decodeLaunchReceipt({
      logs: [tokenCreatedLog(TOKEN, WALLET), boughtLog(WALLET, TOKEN, ethIn, tokensOut, price)],
      diamond: DIAMOND,
      wallet: WALLET,
      expectPrebuy: true,
    });

    expect(decoded).not.toBeNull();
    expect(decoded!.tokenAddress).toBe(TOKEN);
    expect(decoded!.prebuyTokensOutRaw).toBe(tokensOut);
    expect(decoded!.prebuyTokensOutRaw).not.toBe(price);
  });

  it("declines the amount (null) when Bought does not name this wallet and token", () => {
    const stranger = getAddress("0x1111111111111111111111111111111111111111");
    const decoded = decodeLaunchReceipt({
      logs: [tokenCreatedLog(TOKEN, WALLET), boughtLog(stranger, TOKEN, 1n, 2n, 3n)],
      diamond: DIAMOND,
      wallet: WALLET,
      expectPrebuy: true,
    });
    expect(decoded).not.toBeNull();
    expect(decoded!.prebuyTokensOutRaw).toBeNull();
  });

  it("returns null when no TokenCreated from the Diamond names this wallet as creator", () => {
    const other = getAddress("0x2222222222222222222222222222222222222222");
    expect(
      decodeLaunchReceipt({
        logs: [tokenCreatedLog(TOKEN, other)],
        diamond: DIAMOND,
        wallet: WALLET,
        expectPrebuy: false,
      }),
    ).toBeNull();
  });
});
