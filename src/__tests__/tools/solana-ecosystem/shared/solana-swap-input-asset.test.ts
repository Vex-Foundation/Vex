/**
 * Which SOL a swap spends.
 *
 * `SOL` and `So11111111111111111111111111111111111111112` resolve to the SAME
 * mint through Jupiter's token resolution, so the resolved address cannot say
 * whether the funds come from the wallet's lamports or from a wrapped-SOL
 * token account. They are different balances (contract C4.1), and the SYNTAX
 * plus the wrapping knob is the discriminator.
 *
 * TWO COMBINATIONS ARE REFUSED BY NAME, and each has its own reason:
 *
 *   - the explicit mint WITH wrapping is ambiguous (the mint says spend an SPL
 *     account, wrapping says fund one from lamports);
 *   - the symbol WITHOUT wrapping is contradictory. Live `/build` probe
 *     2026-09-01 (archived at
 *     `src/__tests__/solana/fixtures/live-captures/jupiter-build-wrap-knob-2026-09-01.json`)
 *     measured that wrapping-off carries no wrap transfer and no `SyncNative`
 *     at all, so the build spends an existing wrapped-SOL token account. The
 *     previous build classified it as native and would have checked lamports
 *     the transaction never touches.
 */

import { describe, expect, it } from "vitest";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { resolveSolanaSwapInputAsset } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("resolveSolanaSwapInputAsset", () => {
  it.each([
    ["SOL", true, { kind: "native" }],
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

  it.each(["SOL", "sol"])("refuses %s with wrapping disabled, by its OWN name", (query) => {
    const resolution = resolveSolanaSwapInputAsset({
      query,
      resolvedMint: SOL_MINT,
      wrapAndUnwrapSol: false,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    // Never collapsed into the ambiguity reason: a different cause needs a
    // different remedy, and the two remedies are opposites.
    expect(resolution.reason).toBe("native_sol_without_wrapping");
    expect(resolution.message).toContain("wrapAndUnwrapSol");
    expect(resolution.message).toContain(SOL_MINT);
  });

  it("never classifies the wrapping-disabled symbol as native", () => {
    // The reversed pin. This exact combination used to resolve to
    // `{ kind: "native" }`, which sent the spendability read at the wallet's
    // lamports while `/build` drew on a wrapped-SOL token account.
    const resolution = resolveSolanaSwapInputAsset({
      query: "SOL",
      resolvedMint: SOL_MINT,
      wrapAndUnwrapSol: false,
    });

    expect(resolution).not.toEqual({ ok: true, asset: { kind: "native" } });
  });

  it("passes every other mint through as its own SPL balance", () => {
    expect(resolveSolanaSwapInputAsset({ query: "USDC", resolvedMint: USDC, wrapAndUnwrapSol: true }))
      .toEqual({ ok: true, asset: { kind: "spl", mint: USDC } });
  });
});
