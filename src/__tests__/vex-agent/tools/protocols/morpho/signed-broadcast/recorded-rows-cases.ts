/**
 * What a Morpho vault write RECORDS: the family and chain columns migration 079
 * stopped catching, the per-leg roles, both token scales, and the decode hint.
 */

import { it, expect } from "vitest";

import {
  ADAPTER,
  ASSET,
  BUNDLER3,
  CHAIN_ID,
  DEPOSIT_ASSETS,
  MINTED_SHARES,
  VAULT,
  WALLET,
  ZERO,
  clients,
  confirmedOutcome,
  request,
  transfer,
  vaultState,
  type SignedBroadcastContext,
} from "./harness.js";

export function registerRecordedRowCases(ctx: SignedBroadcastContext): void {
  const depositLogs = () => [
    transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
    transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
  ];

  it("STATES chain_family eip155 explicitly on every leg, because 079 stopped catching an omission", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome(depositLogs()));

    await ctx.module.executeMorphoVaultDeposit(clients, request());

    const events = ctx.capturedEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.chainFamily).toBe("eip155");
      expect(event.kind).toBe("lend");
      expect(event.protocol).toBe("morpho");
    }
  });

  it("takes chain_id and its slug from the caller's registry-resolved chain, never from params", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome(depositLogs()));

    // The params carry a DIFFERENT chain. Only `chainId` may decide the column.
    await ctx.module.executeMorphoVaultDeposit(clients, request({ intentParams: { chain: "ethereum" } }));

    for (const event of ctx.capturedEvents()) {
      expect(event.chainId).toBe(CHAIN_ID);
      expect(event.chainSlug).toBe("base");
    }
  });

  it("files the approval and the deposit under their own roles, approval first", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome(depositLogs()));

    await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.capturedEvents().map((e) => e.eventRole)).toEqual(["allowance", "lend_deposit"]);
  });

  it("gives every leg its address, symbol, decimals, human and raw amount at BOTH scales", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome(depositLogs()));

    await ctx.module.executeMorphoVaultDeposit(clients, request());

    const deposit = ctx.capturedEvents()[1];
    // The asset is 6 decimals and the share token is 18. A single `decimals`
    // field beside these two raw numbers is the thousandfold error rules/90
    // names, so each leg carries its own.
    expect(deposit.tokenIn).toEqual({
      tokenAddress: ASSET,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountHuman: "1",
      amountRaw: DEPOSIT_ASSETS.toString(),
    });
    expect(deposit.tokenOut).toEqual({
      tokenAddress: VAULT,
      tokenSymbol: "steakUSDC",
      tokenDecimals: 18,
      amountHuman: "0.97",
      amountRaw: MINTED_SHARES.toString(),
    });
  });

  it("persists the settlement-decode hint on the OPERATION leg, naming the verified target", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome(depositLogs()));

    await ctx.module.executeMorphoVaultDeposit(clients, request());

    const events = ctx.capturedEvents();
    const hint = (events[1].routeProvenance as Record<string, unknown>).settlementDecode;
    expect(hint).toEqual({ v: 1, decoder: "morpho", chainId: CHAIN_ID, routerAddress: BUNDLER3 });
    // The approval leg carries no hint: its decoder declines the role anyway, so
    // a hint there would promise a decode that can never happen.
    expect((events[0].routeProvenance as Record<string, unknown>).settlementDecode).toBeUndefined();
  });

  it("plans a withdrawal as ONE direct leg with no approval at all", async () => {
    ctx.prepareExecution.mockResolvedValue({
      state: vaultState(),
      allowancePlan: null,
      expectedSharesRaw: MINTED_SHARES,
      bundle: { to: VAULT, shape: "direct-vault-call" },
    });
    ctx.prepareLeg.mockResolvedValue({
      to: VAULT, data: "0xwithdraw", value: 0n,
      bundle: { to: VAULT },
      gas: { nodeEstimate: "1", vexGasLimit: "2" },
      preflight: { verdict: "ok", revertReason: null, explanation: "" },
    });
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(VAULT, WALLET, ZERO, MINTED_SHARES),
      transfer(ASSET, VAULT, WALLET, DEPOSIT_ASSETS),
    ]));

    const outcome = await ctx.module.executeMorphoVaultWithdraw(
      clients,
      request({ toolId: "morpho.vault.withdraw" }),
    );

    expect(ctx.capturedEvents().map((e) => e.eventRole)).toEqual(["lend_withdraw"]);
    expect(outcome.kind).toBe("confirmed");
  });
}
