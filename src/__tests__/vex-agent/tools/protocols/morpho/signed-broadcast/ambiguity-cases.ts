/**
 * An ambiguous send may already have moved funds, so it is never terminalized
 * and never re-broadcast. These cases also own the wording of the residual
 * allowance a possibly-landed approval leaves standing.
 */

import { it, expect } from "vitest";

import { ADAPTER, clients, confirmedOutcome, request, type SignedBroadcastContext } from "./harness.js";

export function registerAmbiguityCases(ctx: SignedBroadcastContext): void {
  it("leaves an ambiguous approval PENDING, records why, and stops the execution", async () => {
    ctx.signStageBroadcast.mockResolvedValue({
      kind: "ambiguous", txHash: "0xapproval", stage: "confirm", reason: "receipt wait failed",
    });

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    // The row is neither confirmed nor failed: the transaction may already be
    // on chain, so only the sweep may decide.
    expect(ctx.fail).not.toHaveBeenCalled();
    expect(ctx.confirm).not.toHaveBeenCalled();
    // And it is not re-sent.
    expect(ctx.signStageBroadcast).toHaveBeenCalledTimes(1);
    expect(ctx.notePendingReason).toHaveBeenCalledWith(
      "morpho.vault.deposit", 100, "broadcast_ambiguous_confirm",
    );
    expect(outcome).toMatchObject({ kind: "unproven", reason: "ambiguous", txHash: "0xapproval" });
    expect(outcome.message).toContain("Do not retry");
  });

  // The funded live probe of 2026-08-17 hit exactly this: the approval MINED, the
  // receipt could not be read, and the agent was told only that the vault
  // operation was not attempted while 0.2 USDC of real spending authority stood
  // unmentioned. A staged hash is the evidence that it MAY be standing.
  it("names the allowance that MAY be standing when an approval's broadcast went ambiguous", async () => {
    ctx.signStageBroadcast.mockResolvedValue({
      kind: "ambiguous", txHash: "0xapproval", stage: "confirm", reason: "receipt wait failed",
    });

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(outcome.message).toContain("1 USDC");
    expect(outcome.message).toContain(ADAPTER);
    // Hedged, never asserted: Vex does not know whether it landed.
    expect(outcome.message).toContain("MAY now be standing");
    // Both ways out, and the do-not-retry instruction for the SEND survives.
    expect(outcome.message).toContain("retrying the same deposit later consumes it");
    expect(outcome.message).toContain("approving zero");
    expect(outcome.message).toContain("Do not retry");
    expect(outcome.message).toContain("must not be sent again");
  });

  it("says nothing about a standing allowance when the approval was refused BEFORE anything was signed", async () => {
    ctx.signStageBroadcast.mockRejectedValue(new Error("gas estimate refused"));

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("No transaction was sent and no gas was spent");
    // No hash exists, so there is no allowance that could be standing to hedge about.
    expect(outcome.message).not.toContain("MAY now be standing");
    expect(outcome.message).not.toContain(ADAPTER);
  });

  it("leaves an ambiguous DEPOSIT pending too, and tells the agent not to retry", async () => {
    ctx.signStageBroadcast
      .mockResolvedValueOnce(confirmedOutcome([], "0xapproval"))
      .mockResolvedValueOnce({ kind: "ambiguous", txHash: "0xdep", stage: "send", reason: "submit unclear" });

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.fail).not.toHaveBeenCalled();
    expect(ctx.notePendingReason).toHaveBeenCalledWith("morpho.vault.deposit", 101, "broadcast_ambiguous_send");
    expect(outcome).toMatchObject({ kind: "unproven", reason: "ambiguous" });
  });

  it("leaves a mined-but-undecodable deposit pending rather than reporting a guessed fill", async () => {
    ctx.signStageBroadcast
      .mockResolvedValueOnce(confirmedOutcome([], "0xapproval"))
      // Mined SUCCESSFULLY with no transfer the decoder can prove.
      .mockResolvedValueOnce(confirmedOutcome([], "0xdep"));

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.notePendingReason).toHaveBeenCalledWith("morpho.vault.deposit", 101, "settlement_undecodable");
    expect(outcome).toMatchObject({ kind: "unproven", reason: "undecodable" });
    // The confirm that DID run was the approval's, never the deposit's.
    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.confirm).toHaveBeenCalledWith(100, {});
  });
}
