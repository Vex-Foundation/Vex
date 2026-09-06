export const BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION =
  "RETURNS `tokenMetadata` with `source`, `destination`, `amountRaw`, and nullable `amountHuman`; each EVM side is contract/registry verified or `kind: metadata_unavailable`, which blocks signing.";

export type VerifiedEvmBridgeAssetIdentity = {
  readonly family: "eip155";
  readonly kind: "erc20" | "native";
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly metadataSource: "rpc_contract" | "chain_registry";
  readonly symbolSanitized: boolean;
};

export type UnavailableEvmBridgeAssetIdentity = {
  readonly family: "eip155";
  readonly kind: "metadata_unavailable";
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly symbol: null;
  readonly decimals: null;
  readonly metadataSource: "rpc_contract_unavailable" | "chain_registry_unavailable";
  readonly symbolSanitized: false;
  readonly metadataErrorCode: "contract_metadata_unavailable" | "native_registry_metadata_unavailable";
  readonly metadataErrorMessage: string;
};

export type BridgeAssetIdentity =
  | VerifiedEvmBridgeAssetIdentity
  | UnavailableEvmBridgeAssetIdentity
  | {
      readonly family: "solana";
      readonly kind: "solana";
      readonly chainId: number;
      readonly tokenAddress: string;
      readonly symbol: null;
      readonly decimals: null;
      readonly metadataSource: "solana_not_read_by_evm_contract_resolver";
      readonly symbolSanitized: false;
    };

export interface BridgeTokenIdentityPreview {
  readonly source: BridgeAssetIdentity;
  readonly destination: BridgeAssetIdentity;
  readonly amountRaw: string;
  readonly amountHuman: string | null;
  /**
   * WHERE THE FUNDS LAND. The destination-family wallet the bridge identity
   * derived and bound into its match hash - `resolveSelectedAddress(destFamily)`,
   * never a `recipient` parameter, which both bridge aliases reject by name.
   *
   * Attached by the prequote gate (`runtime/gates.ts`) rather than by the token
   * resolver, because it is a fact about the SESSION's selected wallets, not
   * about the token contracts this preview otherwise reads. Absent when the gate
   * produced no bridge identity for this call.
   */
  readonly recipient?: {
    readonly family: "eip155" | "solana";
    readonly address: string;
  };
}

export function isVerifiedEvmBridgeAssetIdentity(
  identity: BridgeAssetIdentity | undefined,
): identity is VerifiedEvmBridgeAssetIdentity {
  return identity?.family === "eip155" && identity.kind !== "metadata_unavailable";
}

export function isBridgeTokenPreviewSigningReady(preview: BridgeTokenIdentityPreview): boolean {
  return preview.source.kind !== "metadata_unavailable" && preview.destination.kind !== "metadata_unavailable";
}
