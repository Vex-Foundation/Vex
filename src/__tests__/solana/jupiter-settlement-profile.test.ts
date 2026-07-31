/**
 * `jupiter-swaps/settlement-profile` — the bounded, versioned record a
 * fee-bearing Jupiter swap persists at intent time so the K3 sweep can later
 * decode what settled (design `solana-settlement-profile-design.md` D1).
 *
 * Pins the ONE property that makes the whole fix safe: the profile is written
 * only when every field is HONEST. An approved tip that was never certified
 * yields NO profile at all rather than a profile claiming the transaction
 * carries no tip — the sweep then falls back to the generic decoder and the row
 * stays pending, which is always the safe answer.
 */

import { describe, it, expect } from "vitest";

import {
  buildSolanaSettlementRouteProvenance,
  JUPITER_FEE_SWAP_SETTLEMENT_KIND,
  SOLANA_SETTLEMENT_PROFILE_VERSION,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import { JUPITER_TIP_RECEIVER_ADDRESSES } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TIP_RECEIVER = JUPITER_TIP_RECEIVER_ADDRESSES[0]!;

function source(overrides: Partial<Parameters<typeof buildSolanaSettlementRouteProvenance>[0]> = {}) {
  return {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inputAmountRaw: "10000000",
    approvedTipLamports: 1_000_000,
    certifiedTip: { tipLamports: 1_000_000, tipReceiver: TIP_RECEIVER },
    wrapAndUnwrapSol: true,
    ...overrides,
  };
}

describe("buildSolanaSettlementRouteProvenance", () => {
  it("records the exact approved economics under the route_provenance settlement key", () => {
    const provenance = buildSolanaSettlementRouteProvenance(source());

    expect(provenance).toEqual({
      settlement: {
        v: SOLANA_SETTLEMENT_PROFILE_VERSION,
        kind: JUPITER_FEE_SWAP_SETTLEMENT_KIND,
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        inputAmountRaw: "10000000",
        tipRecipient: TIP_RECEIVER,
        tipLamports: 1_000_000,
        wrapAndUnwrapSol: true,
      },
    });
  });

  it("records an agent-approved ZERO tip as an explicit absence (no tip transfer can exist)", () => {
    const provenance = buildSolanaSettlementRouteProvenance(
      source({ approvedTipLamports: 0, certifiedTip: null }),
    );
    const profile = provenance?.settlement as Record<string, unknown> | undefined;

    expect(profile?.tipRecipient).toBeNull();
    expect(profile?.tipLamports).toBe(0);
  });

  it("writes NO profile when a tip was approved but never certified — never a profile claiming there is no tip", () => {
    // An agent-chosen tip below Jupiter's /submit minimum is a real transfer in
    // the signed transaction that this profile could not name.
    expect(
      buildSolanaSettlementRouteProvenance(source({ approvedTipLamports: 500_000, certifiedTip: null })),
    ).toBeUndefined();
  });

  it("writes NO profile when the certified tip disagrees with the approved amount", () => {
    expect(
      buildSolanaSettlementRouteProvenance(
        source({ certifiedTip: { tipLamports: 999_999, tipReceiver: TIP_RECEIVER } }),
      ),
    ).toBeUndefined();
  });

  it("writes NO profile for an unusable input amount rather than persisting something a reader must reject", () => {
    expect(buildSolanaSettlementRouteProvenance(source({ inputAmountRaw: "0" }))).toBeUndefined();
    expect(buildSolanaSettlementRouteProvenance(source({ inputAmountRaw: "1.5" }))).toBeUndefined();
    expect(buildSolanaSettlementRouteProvenance(source({ inputAmountRaw: "" }))).toBeUndefined();
  });
});
