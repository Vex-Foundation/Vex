/**
 * Pendle API-independent redeem fallback — redeemPyToSy calldata builder.
 *
 * The share-based-SY floor is pinned against the live measurement in
 * `agents_dm/agentscan-phase4/live-gate/free-lanes-2026-07-28.md` (LANE 2 / L2-D1).
 */

import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, getAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";

import { buildRedeemPyToSyPlan } from "@vex-agent/tools/protocols/pendle/redeem-fallback.js";
import { PENDLE_ROUTER, PENDLE_ROUTER_REDEEM_ABI } from "@tools/pendle/constants.js";
import { ErrorCodes } from "../../../../../errors.js";

const RECEIVER = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
const YT = "0x8a9e90fe18e9d243f804022224fbd8380d6b76f6";
const SY = "0xC9bfEbC79A722C05Dc34bd2A227Ef2dB19FD1B8e";

/** LANE 2 live fixture: matured srUSDe holder 0xadDF8d37…, ethereum. */
const LIVE = {
  netPyIn: 1_896_804_154_210_053_863n,
  exchangeRate: 1_027_763_816_481_086_050n,
  netSyOut: 1_845_564_247_148_178_107n,
} as const;

function clientReturning(rate: bigint | Error): { client: PublicClient<Transport, Chain>; readContract: ReturnType<typeof vi.fn> } {
  const readContract = vi.fn(async () => {
    if (rate instanceof Error) throw rate;
    return rate;
  });
  return { client: { readContract } as unknown as PublicClient<Transport, Chain>, readContract };
}

describe("buildRedeemPyToSyPlan", () => {
  it("targets the pinned Router and encodes redeemPyToSy(receiver, YT, netPyIn, minSyOut)", async () => {
    // Rate 1e18 => one SY share per accounting unit; the floor is then netPyIn * (1 - 0.5%).
    const { client } = clientReturning(10n ** 18n);
    const plan = await buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: 1_000_000n, slippage: 0.005 });
    expect(plan.to).toBe(PENDLE_ROUTER);
    const decoded = decodeFunctionData({ abi: PENDLE_ROUTER_REDEEM_ABI, data: plan.data });
    expect(decoded.functionName).toBe("redeemPyToSy");
    expect(decoded.args[0]).toBe(getAddress(RECEIVER));
    expect(decoded.args[1]).toBe(getAddress(YT));
    expect(decoded.args[2]).toBe(1_000_000n);
    expect(decoded.args[3]).toBe(995_000n);
  });

  it("reads exchangeRate() from the market's SY and reproduces the live netSyOut to the wei", async () => {
    const { client, readContract } = clientReturning(LIVE.exchangeRate);
    const plan = await buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: LIVE.netPyIn, slippage: 0.005 });

    const call = readContract.mock.calls[0]?.[0] as { address: Address; functionName: string };
    expect(call.address).toBe(getAddress(SY));
    expect(call.functionName).toBe("exchangeRate");

    expect(plan.syExchangeRate).toBe(LIVE.exchangeRate);
    expect(plan.expectedSyOut).toBe(LIVE.netSyOut);
    // Floor is the tolerance applied to the SHARE-converted expectation.
    expect(plan.minSyOut).toBe((LIVE.netSyOut * 9_950n) / 10_000n);
    expect(plan.minSyOut).toBeLessThan(LIVE.netSyOut);
  });

  it("counter-test: the OLD netPyIn-scaled floor exceeds the real netSyOut (this is the live revert)", async () => {
    const oldFloor = (LIVE.netPyIn * 9_950n) / 10_000n;
    expect(oldFloor).toBe(1_887_320_133_439_003_593n);
    // Slippage: INSUFFICIENT_SY_OUT — the chain pays less than the old floor demanded.
    expect(oldFloor).toBeGreaterThan(LIVE.netSyOut);

    const { client } = clientReturning(LIVE.exchangeRate);
    const plan = await buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: LIVE.netPyIn, slippage: 0.005 });
    expect(plan.minSyOut).toBeLessThan(oldFloor);
  });

  it("refuses by name when exchangeRate() cannot be read — never falls back to 1:1", async () => {
    const { client } = clientReturning(new Error("rpc down"));
    await expect(
      buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: LIVE.netPyIn, slippage: 0.005 }),
    ).rejects.toMatchObject({ code: ErrorCodes.PENDLE_UNSAFE_TX, message: expect.stringMatching(/exchange rate/i) });
  });

  it("refuses a non-positive exchangeRate", async () => {
    const { client } = clientReturning(0n);
    await expect(
      buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: LIVE.netPyIn, slippage: 0.005 }),
    ).rejects.toMatchObject({ code: ErrorCodes.PENDLE_UNSAFE_TX });
  });

  it("refuses a non-positive amount before touching the network", async () => {
    const { client, readContract } = clientReturning(10n ** 18n);
    await expect(
      buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: 0n, slippage: 0.005 }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_AMOUNT });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("refuses a malformed address before touching the network", async () => {
    const { client, readContract } = clientReturning(10n ** 18n);
    await expect(
      buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: "0xnope", sy: SY, netPyIn: 1_000_000n, slippage: 0.005 }),
    ).rejects.toMatchObject({ code: ErrorCodes.PENDLE_UNSAFE_TX });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("refuses a tiny amount that would floor minSyOut to zero", async () => {
    const { client } = clientReturning(10n ** 18n);
    await expect(
      buildRedeemPyToSyPlan({ publicClient: client, receiver: RECEIVER, yt: YT, sy: SY, netPyIn: 1n, slippage: 0.99 }),
    ).rejects.toMatchObject({ code: ErrorCodes.PENDLE_UNSAFE_TX });
  });
});
