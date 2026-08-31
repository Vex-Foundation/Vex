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
