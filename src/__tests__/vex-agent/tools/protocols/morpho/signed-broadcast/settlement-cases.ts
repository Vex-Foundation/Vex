/**
 * A settled deposit: the amounts the RECEIPT proved, where the settling block's
 * time comes from (including Base preconfirmation receipts), and the absolute
 * share bound that decides the verdict.
 */

import { beforeEach, it, expect } from "vitest";

import {
  ADAPTER,
  ASSET,
  DEPOSIT_ASSETS,
  MINTED_SHARES,
  VAULT,
  WALLET,
  ZERO,
  clients,
  confirmedOutcome,
  getBlockMock,
  request,
  transfer,
  type SignedBroadcastContext,
} from "./harness.js";

export function registerSettlementCases(ctx: SignedBroadcastContext): void {
  beforeEach(() => {
    ctx.signStageBroadcast
      .mockResolvedValueOnce(confirmedOutcome([], "0xapproval"))
      .mockResolvedValueOnce(confirmedOutcome([
        transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
        transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
      ], "0xdep"));
  });

  it("confirms with the amounts the RECEIPT proved, at each leg's own decimals", async () => {
    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(outcome.kind).toBe("confirmed");
    expect(ctx.confirm).toHaveBeenCalledWith(101, {
      executedAmountInRaw: DEPOSIT_ASSETS.toString(),
      executedAmountInHuman: "1",
      executedAmountOutRaw: MINTED_SHARES.toString(),
      executedAmountOutHuman: "0.97",
    });
  });

  it("falls back to getBlock for the settling block's time when the receipt carries none", async () => {
    await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.noteBlockTime).toHaveBeenCalledWith(101, new Date(1_760_000_000 * 1000).toISOString());
  });

  it("takes the time from a FLASHBLOCK receipt's own blockTimestamp, without a racing getBlock", async () => {
    // Base serves preconfirmation receipts: the named block is not sealed yet,
    // so the follow-up getBlock throws BlockNotFoundError and the row keeps a
    // NULL settled_block_time. The funded run of 2026-08-17 proved the receipt
    // itself carried the correct sealed time (0x6a830e71).
    const flashblock = (logs: unknown[], txHash: string) => ({
      kind: "confirmed",
      txHash,
      receipt: {
        blockNumber: 42n,
        // The unsealed block the preconfirmation names.
        blockHash: `0x${"0".repeat(64)}`,
        blockTimestamp: "0x6a830e71",
        logs,
        status: "success",
      },
    });
    ctx.signStageBroadcast.mockReset();
    ctx.signStageBroadcast
      .mockResolvedValueOnce(flashblock([], "0xapproval"))
      .mockResolvedValueOnce(flashblock([
        transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
        transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
      ], "0xdep"));

    await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.noteBlockTime).toHaveBeenCalledWith(101, "2026-08-17T13:36:49.000Z");
    // The lookup that raced the seal is not attempted at all.
    expect(getBlockMock).not.toHaveBeenCalled();
  });

  it("judges the shares against the ABSOLUTE bound the approved slippage allows", async () => {
    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(outcome).toMatchObject({
      kind: "confirmed",
      shares: {
        withinApprovedBound: true,
        actualRaw: MINTED_SHARES.toString(),
        shareDecimals: 18,
        slippageBps: 100,
        boundSide: "minimum_shares_received",
      },
    });
  });

  it("reports the quoted-vs-settled difference as accrual drift rather than as a verdict", async () => {
    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    // The fork run of 2026-08-17 measured an ordinary 1 USDC deposit drifting
    // past the old fixed 1e-9-share tolerance. The drift is still REPORTED; what
    // changed is that it no longer decides the verdict.
    expect(outcome).toMatchObject({ kind: "confirmed" });
    if (outcome.kind !== "confirmed") throw new Error("expected a confirmed outcome");
    // A VAULT deposit always carries a shares verdict. The field is nullable
    // because a Blue MARKET operation has no shares the user holds, so the
    // assertion states which lane this is rather than assuming it.
    if (outcome.shares === null) throw new Error("expected a vault deposit to report a shares verdict");
    expect(outcome.shares.accrualDriftRaw).toBeDefined();
    expect(outcome.message).not.toContain("outside the");
  });
}
