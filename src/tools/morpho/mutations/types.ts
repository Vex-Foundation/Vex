/**
 * The vocabulary the Morpho mutation layer verifies AGAINST.
 *
 * The intent is the thing Vex decided to do, expressed in Vex's own terms before
 * any SDK is involved. Everything downstream - the requirement classification,
 * the bundle decoder, the gas bound, the preflight - checks the SDK's output
 * against THIS, never against the SDK's own account of what it built. That
 * direction is the whole point: a builder that also gets to say whether its
 * output is correct is not a check.
 */

import type { Address } from "viem";

/** Which way the assets move. There is no third direction in E3b-1. */
export type MorphoVaultDirection = "deposit" | "withdraw";

/**
 * ONE vault operation, fully resolved.
 *
 * Every address is already narrowed to a supported chain and lower-cased by the
 * caller. Amounts are RAW base units of the vault's ASSET (not of its shares):
 * the vault's shares are 18 decimals while a USDC asset is 6, and carrying one
 * number for both is the thousandfold error rules/90 names.
 */
export interface MorphoVaultIntent {
  readonly chainId: number;
  readonly direction: MorphoVaultDirection;
  /** The vault contract. Chain-scoped; the same address elsewhere is a different thing. */
  readonly vaultAddress: Address;
  /** The vault's underlying ERC-20, read from the vault itself, never from a caller. */
  readonly assetAddress: Address;
  /** Asset decimals, read from the vault. Travels with every raw amount. */
  readonly assetDecimals: number;
  /** Share decimals, read from the vault. Distinct from `assetDecimals` on purpose. */
  readonly shareDecimals: number;
  /** Amount of the ASSET, in raw base units. */
  readonly amountRaw: bigint;
  /** The wallet whose funds move and whose shares are burned or minted. */
  readonly userAddress: Address;
  /** Where the shares (deposit) or the assets (withdrawal) land. */
  readonly recipient: Address;
}

/** One decoded leg of a transaction, named so a reader can audit it. */
export interface MorphoDecodedLeg {
  readonly index: number;
  readonly target: string;
  readonly targetRole: string;
  readonly selector: string;
  readonly functionName: string;
  readonly signature: string;
  /** Native value this leg moves. Anything but "0" is refused before it is reported. */
  readonly valueRaw: string;
  /** Whether Bundler3 was told to swallow this leg's revert. Always false here. */
  readonly skipRevert: boolean;
  /** A one-line reading of the call in the intent's own terms. */
  readonly summary: string;
}

/**
 * The verifier's account of a transaction it ACCEPTED. A rejection is a thrown
 * `VexError` and never a report with a flag on it, so no caller can proceed past
 * a failed check by forgetting to read a boolean.
 */
export interface MorphoBundleReport {
  /**
   * `bundler3-multicall` for a deposit, `direct-vault-call` for a withdrawal.
   * The shape is DERIVED from the bytes and then required to match the
   * direction, so a deposit arriving as a direct call is a refusal.
   */
  readonly shape: "bundler3-multicall" | "direct-vault-call";
  readonly to: string;
  readonly toRole: string;
  readonly selector: string;
  readonly functionName: string;
  /** Native value on the outer transaction. "0" for every shape E3b-1 builds. */
  readonly valueRaw: string;
  readonly legs: readonly MorphoDecodedLeg[];
  /**
   * The on-chain price guard the adapter enforces, in the SDK's own units
   * (assets per share, scaled). Present on a deposit, `null` on a direct
   * withdrawal, which has no share-price leg to guard.
   */
  readonly maxSharePriceRaw: string | null;
  /** The asset amount the decoder PROVED the transaction moves. */
  readonly verifiedAmountRaw: string;
  /** The address the decoder proved the shares or assets land on. */
  readonly verifiedRecipient: string;
}
