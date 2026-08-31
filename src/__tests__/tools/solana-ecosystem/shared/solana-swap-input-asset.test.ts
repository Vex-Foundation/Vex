/**
 * Which SOL a swap spends.
 *
 * `SOL` and `So11111111111111111111111111111111111111112` resolve to the SAME
 * mint through Jupiter's token resolution, so the resolved address cannot say
 * whether the funds come from the wallet's lamports or from a wrapped-SOL
 * token account. They are different balances (contract C4.1), and the owner
 * decision of 2026-08-31 makes the SYNTAX the discriminator: the symbol means
 * native, the explicit mint with wrapping off means the SPL account, and the
 * explicit mint with wrapping on is refused by name instead of guessed.
 */

import { describe, expect, it } from "vitest";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { resolveSolanaSwapInputAsset } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("resolveSolanaSwapInputAsset", () => {
  it.each([
    ["SOL", true, { kind: "native" }],
    ["SOL", false, { kind: "native" }],
    ["sol", true, { kind: "native" }],
    [` ${SOL_MINT} `, false, { kind: "spl", mint: SOL_MINT }],
    [SOL_MINT, false, { kind: "spl", mint: SOL_MINT }],
  ])("resolves %s with wrapping %s", (query, wrapAndUnwrapSol, expected) => {
    const resolution = resolveSolanaSwapInputAsset({ query, resolvedMint: SOL_MINT, wrapAndUnwrapSol });
    expect(resolution).toEqual({ ok: true, asset: expected });
  });

  it("refuses the explicit wrapped-SOL mint with wrapping enabled, by name", () => {
    const resolution = resolveSolanaSwapInputAsset({
      query: SOL_MINT,
      resolvedMint: SOL_MINT,
      wrapAndUnwrapSol: true,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("ambiguous_wrapped_sol_input");
    // The message must name BOTH ways out, or an agent cannot act on it.
    expect(resolution.message).toContain("wrapAndUnwrapSol");
    expect(resolution.message).toContain("\"SOL\"");
  });

  it("passes every other mint through as its own SPL balance", () => {
    expect(resolveSolanaSwapInputAsset({ query: "USDC", resolvedMint: USDC, wrapAndUnwrapSol: true }))
      .toEqual({ ok: true, asset: { kind: "spl", mint: USDC } });
  });
});
