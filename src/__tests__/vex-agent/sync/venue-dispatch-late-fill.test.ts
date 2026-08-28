/**
 * Late-fill adapters that were missing from `decodeVenueSettlement`: Uniswap,
 * Pendle, trench/pools launches, and the catch-all for an unwired protocol.
 *
 * Pinned here because copying the Kyber adapter's "both token addresses
 * required" gate would decline a Uniswap native leg (NULL address, not 0xeee),
 * and because stamping `amounts_undecodable` for "no decoder wired" released
 * the AgentScan hold immediately — confirmed, $0 volume.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { DepositEvidenceDeps } from "@vex-agent/sync/executed-amount-fallback/deposit-evidence-resolver.js";
import { decodeVenueSettlement } from "@vex-agent/sync/executed-amount-fallback/venue-dispatch.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const VEX = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const VIRTUAL = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const UNDERLYING = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PT = "0x1111111111111111111111111111111111111111";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function transfer(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount) };
}

function row(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 7,
    protocolExecutionId: 1,
    eventIndex: 0,
    eventRole: "swap",
    protocol: "uniswap",
    chainId: 4663,
    chainFamily: "eip155",
    status: "confirmed",
    txHash: "0xabc",
    walletAddress: WALLET,
    tokenInAddress: VEX,
    tokenOutAddress: VIRTUAL,
    executedAmountInRaw: null,
    executedAmountOutRaw: null,
    tokenIn2Address: null,
    tokenOut2Address: null,
    executedAmountIn2Raw: null,
    executedAmountOut2Raw: null,
    routeProvenance: null,
    ...over,
  } as AgentActivityEvent;
}

function deps(tx: { from: string; to: string | null; input: string; valueRaw: string } | null = null): DepositEvidenceDeps {
  return {
    fetchReceiptStatus: async () => "success",
    fetchTransaction: async () => tx,
  };
}

describe("venue dispatch: unwired protocol is a deferral, not a conclusion", () => {
  it("does not stamp amounts_undecodable for a protocol with no adapter", async () => {
    const result = await decodeVenueSettlement({
      row: row({ protocol: "unknown-venue" }),
      logs: [transfer(VEX, WALLET, VIRTUAL, 1n)],
      hint: null,
      deps: deps(),
    });
    expect(result.kind).toBe("deferred");
  });
});

describe("venue dispatch: uniswap", () => {
  it("decodes both ERC-20 legs from wallet Transfer deltas", async () => {
    const result = await decodeVenueSettlement({
      row: row(),
      logs: [transfer(VEX, WALLET, VIRTUAL, 30_480n), transfer(VIRTUAL, VIRTUAL, WALLET, 12_000n)],
      hint: null,
      deps: deps(),
    });
    expect(result).toEqual({
      kind: "decoded",
      amounts: { executedAmountInRaw: "30480", executedAmountOutRaw: "12000" },
    });
  });

  it("persists the proven ERC-20 in even when native-out (NULL token address) is omitted", async () => {
    const result = await decodeVenueSettlement({
      row: row({ tokenOutAddress: null }),
      logs: [transfer(VEX, WALLET, VIRTUAL, 30_480n)],
      hint: null,
      deps: deps(),
    });
    expect(result).toEqual({
      kind: "decoded",
      amounts: { executedAmountInRaw: "30480" },
    });
  });

  it("does not require a token address the Uniswap handler never stored for a native leg", async () => {
    const result = await decodeVenueSettlement({
      row: row({ tokenInAddress: null, tokenOutAddress: VEX }),
      logs: [transfer(VEX, VIRTUAL, WALLET, 99n)],
      hint: null,
      deps: deps(),
    });
    expect(result).toMatchObject({
      kind: "decoded",
      amounts: { executedAmountOutRaw: "99" },
    });
    expect(result.kind === "decoded" ? result.amounts.executedAmountInRaw : "x").toBeUndefined();
  });

  it("declines when the receipt proves no reportable (non-native-out) leg", async () => {
    const result = await decodeVenueSettlement({
      row: row({ tokenOutAddress: null }),
      logs: [],
      hint: null,
      deps: deps(),
    });
    expect(result).toMatchObject({ kind: "declined", reason: "amounts_undecodable" });
  });
});

describe("venue dispatch: pendle", () => {
  it("decodes a PT buy through the venue's own decoder, including provenance", async () => {
    const result = await decodeVenueSettlement({
      row: row({
        protocol: "pendle",
        eventRole: "yield_pt",
        chainId: 1,
        tokenInAddress: UNDERLYING,
        tokenOutAddress: PT,
      }),
      logs: [transfer(UNDERLYING, WALLET, PT, 1_000_000n), transfer(PT, PT, WALLET, 990_000n)],
      hint: null,
      deps: deps(),
    });
    expect(result).toEqual({
      kind: "decoded",
      amounts: { executedAmountInRaw: "1000000", executedAmountOutRaw: "990000" },
    });
  });

  it("declines a pendle role the decoder does not own rather than guessing", async () => {
    const result = await decodeVenueSettlement({
      row: row({ protocol: "pendle", eventRole: "allowance", tokenInAddress: UNDERLYING, tokenOutAddress: PT }),
      logs: [transfer(UNDERLYING, WALLET, PT, 1n)],
      hint: null,
      deps: deps(),
    });
    expect(result).toMatchObject({ kind: "declined", reason: "amounts_undecodable" });
  });
});

function tokenCreatedLog(token: Address, creator: Address): { address: string; topics: string[]; data: string } {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: "TokenCreated" }) as [Hex];
  return {
    address: DIAMOND,
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

describe("venue dispatch: trench token_launch is not the curve-trade decoder", () => {
  it("decodes a no-prebuy launch from TokenCreated + mined value, out proven as 0", async () => {
    const wallet = getAddress(WALLET);
    const result = await decodeVenueSettlement({
      row: row({
        protocol: "trench",
        eventRole: "token_launch",
        tokenInAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        tokenOutAddress: null,
        walletAddress: wallet,
        routeProvenance: { prebuyRaw: "0" },
      }),
      logs: [tokenCreatedLog(TOKEN, wallet)],
      hint: null,
      deps: deps({ from: wallet, to: DIAMOND, input: "0x", valueRaw: "1000000000000000000" }),
    });
    expect(result.kind).toBe("decoded");
    if (result.kind !== "decoded") return;
    expect(result.amounts).toEqual({
      executedAmountInRaw: "1000000000000000000",
      executedAmountOutRaw: "0",
    });
    expect(result.launchIdentity).toEqual({ tokenOutAddress: TOKEN });
  });
});

describe("venue dispatch: pools token_launch", () => {
  it("declines rather than guessing when the authorized plan is not on the row", async () => {
    const result = await decodeVenueSettlement({
      row: row({ protocol: "pools", eventRole: "token_launch", tokenOutAddress: null }),
      logs: [],
      hint: null,
      deps: deps({ from: WALLET, to: WALLET, input: "0x", valueRaw: "1" }),
    });
    expect(result).toMatchObject({ kind: "declined", reason: "amounts_undecodable" });
  });
});
