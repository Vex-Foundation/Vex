/**
 * Solana asset identity for balance rows.
 *
 * Native SOL has four related identities that must not be collapsed:
 *
 * | Role | Native SOL | SPL token |
 * | --- | --- | --- |
 * | Asset identity | `kind: "native"`, `slip44:501` | `kind: "spl"`, mint |
 * | Jupiter route mint | wSOL mint | token mint |
 * | Pricing mint | wSOL mint | token mint |
 * | Persisted address | System Program address | token mint |
 *
 * `kind` decides whether a row is native. No address predicate does. The
 * persisted address only satisfies the existing `proj_balances.token_address`
 * and renderer address grammar. The System Program already occupies that
 * public key, so it cannot also be an SPL mint, and it differs from the wSOL
 * mint. Routing and pricing use their own fields and can never receive the
 * persisted address through this contract.
 */

import { SOL_MINT } from "./solana-constants.js";

/** CAIP-19 native-asset namespace and reference for SOL. */
export const SOLANA_NATIVE_ASSET_ID = "slip44:501" as const;

/**
 * Address-shaped storage key for native SOL.
 *
 * This is the Solana System Program public key, not a mint. It exists here
 * only because the current database and renderer require an address-shaped
 * token identity.
 */
export const SOLANA_NATIVE_PERSISTED_ADDRESS =
  "11111111111111111111111111111111" as const;

export interface SolanaNativeAssetIdentity {
  readonly kind: "native";
  readonly nativeAssetId: typeof SOLANA_NATIVE_ASSET_ID;
  readonly routeMint: typeof SOL_MINT;
  readonly pricingMint: typeof SOL_MINT;
  readonly persistedAddress: typeof SOLANA_NATIVE_PERSISTED_ADDRESS;
}

export interface SolanaSplAssetIdentity {
  readonly kind: "spl";
  readonly nativeAssetId: null;
  readonly routeMint: string;
  readonly pricingMint: string;
  readonly persistedAddress: string;
}

export type SolanaAssetIdentity = SolanaNativeAssetIdentity | SolanaSplAssetIdentity;

export const SOLANA_NATIVE_ASSET_IDENTITY: SolanaNativeAssetIdentity = {
  kind: "native",
  nativeAssetId: SOLANA_NATIVE_ASSET_ID,
  routeMint: SOL_MINT,
  pricingMint: SOL_MINT,
  persistedAddress: SOLANA_NATIVE_PERSISTED_ADDRESS,
};

/**
 * Resolve all four identities from a structural asset discriminator.
 *
 * Native callers cannot provide a mint or storage address. SPL callers must
 * provide the mint, which is the route, pricing and persisted identity for
 * that token.
 */
export function solanaAssetIdentity(
  asset: { readonly kind: "native" } | { readonly kind: "spl"; readonly mint: string },
): SolanaAssetIdentity {
  if (asset.kind === "native") return SOLANA_NATIVE_ASSET_IDENTITY;
  return {
    kind: "spl",
    nativeAssetId: null,
    routeMint: asset.mint,
    pricingMint: asset.mint,
    persistedAddress: asset.mint,
  };
}

/**
 * Decode an address read from `proj_balances` into the route-compatible mint.
 *
 * Only the native storage key changes. Every SPL mint, including wSOL, passes
 * through verbatim. Callers must apply this after grouping on the persisted
 * address, so native SOL and wSOL remain distinct balance rows.
 */
export function solanaRouteMintFromPersistedAddress(address: string): string {
  return address === SOLANA_NATIVE_PERSISTED_ADDRESS ? SOL_MINT : address;
}

// ── Swap input syntax: native SOL versus SPL wSOL ───────────────────────

/**
 * Which asset a Solana swap actually SPENDS, decided from what the caller
 * wrote rather than from the mint the resolver produced.
 *
 * Both `SOL` and the explicit `So111...` mint resolve to the SAME wSOL mint
 * through `resolveJupiterTokenWithSafety`, so the resolved address alone cannot
 * say whether the funds come from the wallet's lamports or from an SPL token
 * account. They are different balances (contract C4.1: a native derivative may
 * share the native asset's PRICE, never its SPENDABILITY), so the two must be
 * read from different places, and the syntax is what disambiguates.
 */
export type SolanaSwapInputAsset =
  /** The wallet's own lamports. Read with `getBalance`. */
  | { readonly kind: "native" }
  /** An SPL token account holding `mint`, wSOL included. Read from token accounts. */
  | { readonly kind: "spl"; readonly mint: string };

/**
 * The resolution, or the named reason the request cannot be resolved.
 *
 * Two DISTINCT refusals, never collapsed into one (rule 04):
 *
 * `ambiguous_wrapped_sol_input` - an explicit wSOL mint asks to spend an SPL
 * balance while `wrapAndUnwrapSol` asks Jupiter to create and fund that balance
 * out of lamports. Guessing which the caller meant would spend the wrong asset.
 *
 * `native_sol_without_wrapping` - the symbol asks for native lamports while
 * wrapping is disabled, and the provider has no native landing for that
 * combination. See the live proof cited on
 * {@link resolveSolanaSwapInputAsset}.
 *
 * Rule 90 forbids resolving a money-path ambiguity or contradiction silently.
 */
export type SolanaSwapInputRefusal =
  | "ambiguous_wrapped_sol_input"
  | "native_sol_without_wrapping";

export type SolanaSwapInputResolution =
  | { readonly ok: true; readonly asset: SolanaSwapInputAsset }
  | { readonly ok: false; readonly reason: SolanaSwapInputRefusal; readonly message: string };

/**
 * Decide which balance a swap's input side spends.
 *
 * The four cases:
 *
 * | `query` | `wrapAndUnwrapSol` | Result |
 * | --- | --- | --- |
 * | a symbol resolving to wSOL (`SOL`) | `true` | native lamports |
 * | a symbol resolving to wSOL (`SOL`) | `false` | REFUSED, contradictory |
 * | the explicit `So111...` mint | `false` | SPL wSOL |
 * | the explicit `So111...` mint | `true` | REFUSED, ambiguous |
 *
 * WHY `SOL` PLUS WRAPPING-OFF IS A CONTRADICTION, measured rather than
 * reasoned. Live `/build` probe 2026-09-01, wSOL to USDC, 0.01 SOL, the SAME
 * taker and amount on both calls (archived with provenance at
 * `src/__tests__/solana/fixtures/live-captures/jupiter-build-wrap-knob-2026-09-01.json`):
 *
 *   - `wrapAndUnwrapSol: true` returned setup instructions carrying a System
 *     `Transfer` of exactly `inAmount` lamports from the taker followed by
 *     `SyncNative`, and a cleanup `CloseAccount`. The lamports ARE the source.
 *   - `wrapAndUnwrapSol: false` returned NO transfer, NO `SyncNative` and NO
 *     cleanup. The swap spends an existing wrapped-SOL token account.
 *
 * So there is no provider-supported native landing for wrapping-off, and
 * classifying it as native would have checked the wallet's lamports while the
 * transaction drew on a wSOL token account. It is refused BY NAME instead.
 *
 * Any other resolved mint is that mint's SPL balance, whatever the query said.
 */
export function resolveSolanaSwapInputAsset(input: {
  /** The caller's own `tokenIn` text, before resolution. */
  readonly query: string;
  /** The mint `tokenIn` resolved to. */
  readonly resolvedMint: string;
  /** The knob as the swap will send it to `/build`. */
  readonly wrapAndUnwrapSol: boolean;
}): SolanaSwapInputResolution {
  if (input.resolvedMint !== SOL_MINT) {
    return { ok: true, asset: { kind: "spl", mint: input.resolvedMint } };
  }
  if (input.query.trim() !== SOL_MINT) {
    // A symbol (`SOL`, `sol`) means the native asset the symbol names, and
    // Jupiter can only spend that by wrapping it.
    if (!input.wrapAndUnwrapSol) {
      return {
        ok: false,
        reason: "native_sol_without_wrapping",
        message:
          `tokenIn "${input.query.trim()}" with wrapAndUnwrapSol disabled is contradictory: the symbol names native SOL, `
          + "which Jupiter can only spend by wrapping it, and with wrapping disabled the build spends an existing "
          + "wrapped-SOL token account instead. Enable wrapAndUnwrapSol to spend native SOL, or pass tokenIn "
          + `"${SOL_MINT}" to spend wrapped SOL you already hold.`,
      };
    }
    return { ok: true, asset: { kind: "native" } };
  }
  if (input.wrapAndUnwrapSol) {
    return {
      ok: false,
      reason: "ambiguous_wrapped_sol_input",
      message:
        `tokenIn ${SOL_MINT} with wrapAndUnwrapSol enabled is ambiguous: the mint asks to spend an existing `
        + "wrapped-SOL token account, while wrapping asks to fund one from native lamports. Pass tokenIn \"SOL\" "
        + "to spend native SOL, or keep the mint and set wrapAndUnwrapSol to false to spend wrapped SOL.",
    };
  }
  return { ok: true, asset: { kind: "spl", mint: SOL_MINT } };
}
