/**
 * The ordering money cases: a deposit whose simulation proved a revert is never
 * broadcast, a rebuilt leg pointing somewhere the row does not name is refused,
 * and a reverted approval abandons the rest.
 */

import { it, expect } from "vitest";

import { VexError } from "../../../../../../errors.js";
import { ADAPTER, BUNDLER3, clients, confirmedOutcome, request, type SignedBroadcastContext } from "./harness.js";

export function registerLegOrderingCases(ctx: SignedBroadcastContext): void {
  it("NEVER broadcasts the deposit when its simulation proved a revert", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome([], "0xapproval"));
    ctx.prepareLeg.mockRejectedValue(
      new VexError("MORPHO_PREFLIGHT_REVERTED", "the node proved it reverts", "nothing was signed"),
    );

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    // Exactly ONE broadcast happened: the approval. The deposit never reached
    // the signer at all.
    expect(ctx.signStageBroadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("refused");
    // THE CODE IS `unknown`, NOT `simulation_reverted`, AND THAT CHANGED ON
    // PURPOSE (funded live audit 2026-08-18, D1). This execution's own approval
    // had just confirmed, and a simulation runs against "latest": the node may
    // have been answering from a view that predates our own write, which is
    // precisely what happened on real funds, so the row must not record a chain
    // verdict Vex could not establish. What has NOT changed is the part that
    // protects the wallet - nothing was signed, and no gas was spent.
    expect(ctx.fail).toHaveBeenCalledWith(101, expect.objectContaining({ failureCode: "unknown" }));
    expect(outcome.message).toContain("NOT a definitive refusal from the chain");
  });

  it("names the residual allowance the landed approval left behind, with its remediation", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome([], "0xapproval"));
    ctx.prepareLeg.mockRejectedValue(new VexError("MORPHO_PREFLIGHT_REVERTED", "reverts", "hint"));

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(outcome.message).toContain("1 USDC");
    expect(outcome.message).toContain(ADAPTER);
    expect(outcome.message).toContain("Retrying the same deposit consumes it");
  });

  it("refuses to send a rebuilt deposit that points at a target the row does not name", async () => {
    ctx.signStageBroadcast.mockResolvedValue(confirmedOutcome([], "0xapproval"));
    ctx.prepareLeg.mockResolvedValue({
      to: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      data: "0xdeposit", value: 0n,
      bundle: { to: BUNDLER3 },
      gas: { nodeEstimate: "1", vexGasLimit: "2" },
      preflight: { verdict: "ok", revertReason: null, explanation: "" },
    });

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.signStageBroadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("refused");
  });

  it("does not attempt the deposit when the approval REVERTED, and abandons the rest", async () => {
    ctx.signStageBroadcast.mockResolvedValue({
      kind: "reverted", txHash: "0xapproval", receipt: { blockNumber: 1n },
    });

    const outcome = await ctx.module.executeMorphoVaultDeposit(clients, request());

    expect(ctx.signStageBroadcast).toHaveBeenCalledTimes(1);
    expect(ctx.prepareLeg).not.toHaveBeenCalled();
    expect(ctx.abort).toHaveBeenCalledWith(7, 1, expect.stringContaining("reverted"));
    expect(outcome.kind).toBe("reverted");
  });
}
