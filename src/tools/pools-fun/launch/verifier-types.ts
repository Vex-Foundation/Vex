/**
 * The vocabulary of the pools.fun calldata verifier.
 *
 * THE PROBLEM THE VERIFIER SOLVES. The launch path is `prepare` -> sign: a
 * third-party backend hands Vex ready-made `Gateway.launch(tuple)` calldata and
 * Vex signs it with the user's key and the user's money. Everything in that
 * response is a claim. The verifier's job is to make every claim independently
 * provable from the DECODED CALLDATA and from the CHAIN, so that a compromised,
 * buggy, or merely stale backend cannot get a signature for a transaction the
 * user did not agree to.
 *
 * Rule 90 states the same idea for a different provider: "a provider's number is
 * a hint, never a floor... where the provider returns opaque calldata, decode and
 * verify it against that bound before signing."
 *
 * FIFTEEN POINTS. Thirteen were adopted verbatim from the Codex review; points
 * 14 and 15 were added with the V3 suite, which introduced two new ways for a
 * launch to be wrong that no earlier point could see:
 *
 *   14. the price ATTESTATION - on a `SIGNED_STOCK` pair the factory derives the
 *       opening price from six signed numbers, so an unchecked attestation is an
 *       unchecked launch price;
 *   15. the fee RECIPIENT MODE - `feeRecipient` may now legitimately be a
 *       sentinel constant meaning "pay the token holders", and a sentinel is
 *       indistinguishable from a stranger's address to point 4 alone.
 *
 * Every point is REQUIRED before signing; there is no partial pass and no
 * warn-and-continue.
 */

import type { Address, Hex } from "viem";

import type { PoolsPricingMode } from "../abi.js";

/**
 * The 15 checks, in the order they run.
 *
 * Order is deliberate rather than incidental: the cheap structural proofs come
 * first so a malformed response is refused before any RPC is spent, and the
 * simulation-dependent points come last because they depend on values the
 * earlier points establish.
 */
export const POOLS_VERIFIER_POINTS = [
  /** 1. The contract at the pinned address IS the gateway, and it will not refuse. */
  "gateway_identity",
  /** 2. The provider itself says the quote is current. */
  "requires_reprepare",
  /** 3. The selector is `launch` and the tuple re-encodes byte-identically. */
  "selector_and_encoding",
  /** 4. Every mirrored response field equals the decoded calldata. */
  "response_mirrors_calldata",
  /** 5. The symbolic pair maps to the tuple's address AND is allowlisted on-chain. */
  "paired_asset_allowlisted",
  /** 6. The pinned start tick equals what the factory would use, live flag included. */
  "start_tick_agrees",
  /** 7. The metadata is fetched, bounded, and says what was requested. */
  "metadata_matches_request",
  /** 8. Three independent derivations of the token address agree. */
  "token_address_agrees",
  /** 9. Dev-buy modes are exclusive and the amount matches the request's units. */
  "dev_buy_consistent",
  /** 10. The FINAL calldata (with the pinned minOut) still simulates. */
  "final_simulation",
  /** 11. `value` is EXACTLY fee + native prebuy. */
  "value_exact",
  /** 12. The wallet can pay value + bounded gas + the Vex fee. */
  "balance_covers_total",
  /** 13. What was verified is what gets authorized and broadcast. */
  "fingerprint_binding",
  /** 14. The price attestation matches the pair's pricing mode, and is signed by the factory's signer. */
  "price_attestation",
  /** 15. The fee recipient is the intended wallet, or exactly the live sentinel for the intended holders mode. */
  "fee_recipient_mode",
] as const;

export type PoolsVerifierPoint = (typeof POOLS_VERIFIER_POINTS)[number];

/**
 * The signed stock-price quote inside a V3 launch tuple.
 *
 * ALL-ZERO IS A REAL VALUE, not an absence: the gateway takes the struct by
 * value, so a launch that needs no attestation carries six zeroes and an empty
 * `priceSignature`. "Empty" is therefore a shape the verifier must recognise
 * and bind to the pair's pricing mode, never a field it can skip.
 *
 * `underlyingPriceUsdE18` and `expectedUiMultiplier` decide the opening tick
 * (`PartyFactory._signedStockTick`), which makes them money fields at 18-decimal
 * scale - carried as `bigint`, never as a number.
 */
export interface PoolsPriceAttestation {
  readonly asset: Address;
  readonly underlyingPriceUsdE18: bigint;
  readonly expectedUiMultiplier: bigint;
  readonly observedAt: bigint;
  readonly expiresAt: bigint;
  readonly pricingEpoch: bigint;
}

/**
 * The decoded `LaunchParams` tuple, as the V3 gateway defines it.
 *
 * FOURTEEN members: the twelve V1 ones in the same order, then the attestation
 * and its signature. Named rather than positional: a tuple where two adjacent
 * members are both `uint256` amounts (`nativeDevBuyAmount`, `erc20DevBuyAmountIn`)
 * is a transposition waiting to happen, and no value in the data would reveal it.
 */
export interface PoolsLaunchTuple {
  readonly name: string;
  readonly symbol: string;
  readonly metadataUri: string;
  readonly userSalt: Hex;
  readonly pairedAsset: Address;
  readonly expectedStartTick: number;
  readonly deadline: bigint;
  readonly feeRecipient: Address;
  readonly nativeDevBuyAmount: bigint;
  readonly erc20DevBuyAmountIn: bigint;
  readonly devBuyMinOut: bigint;
  readonly expectedFeeWei: bigint;
  readonly priceAttestation: PoolsPriceAttestation;
  /** `0x` when the pair needs no signed quote. Verified against the mode, never assumed. */
  readonly priceSignature: Hex;
}

/**
 * Where a launch's creator fee stream goes, as the CALLER intends it.
 *
 * Two shapes because the chain has two shapes. An `address` is a wallet the
 * verifier holds the tuple to exactly. `holders` means the tuple must carry one
 * of the gateway's own `FEES_TO_HOLDERS*` SENTINELS - which is not an address
 * anybody owns, and which point 4 alone would read as "a stranger". The mode is
 * named by the caller and the sentinel is read live from the gateway, so no
 * constant in this repository can point a fee stream anywhere.
 */
export type PoolsFeeRecipientIntent =
  | { readonly kind: "address"; readonly address: Address }
  | { readonly kind: "holders"; readonly mode: PoolsHolderRewardsMode };

/** The three payout modes `launches/config.holderRewardsPayoutModes` declares. */
export const POOLS_HOLDER_REWARDS_MODES = ["token", "paired", "both"] as const;
export type PoolsHolderRewardsMode = (typeof POOLS_HOLDER_REWARDS_MODES)[number];

/** What the caller asked for, in the caller's own terms. The verifier proves the tuple matches THIS. */
export interface PoolsVerifierExpectation {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: "weth" | "usdg";
  readonly pairedAssetAddress: Address;
  /**
   * The recipient the CALLER intends.
   *
   * On an agent path this is the session wallet and equality is EXACT - the zero
   * address is rejected rather than treated as "the gateway will substitute
   * msg.sender". The substitution is real (gateway source line 146) but relying
   * on it would mean signing a tuple whose recipient field does not say who
   * gets paid, and a later gateway change would silently redirect a fee stream.
   *
   * A `holders` intent is the one case where the tuple legitimately names
   * something that is not a wallet; point 15 holds it to the gateway's own live
   * sentinel for exactly that mode.
   */
  readonly feeRecipient: PoolsFeeRecipientIntent;
  /** The launching wallet. `computeTokenAddress` is keyed on it. */
  readonly launcher: Address;
  /**
   * The gateway version this launch was PREPARED against, as `/launches/config`
   * reported it and as the prepare request declared it in
   * `expectedGatewayVersion`.
   *
   * Checked against the contract's own `VERSION` at the anchored block: a
   * gateway upgraded between the quote and the signature is a different contract
   * with the same address, and the calldata was built for the old one.
   */
  readonly gatewayVersion: bigint;
  readonly imageUrl?: string | undefined;
  readonly tweetUrl?: string | undefined;
  readonly websiteUrl?: string | undefined;
  /** The intended prebuy, or none. Units are the pair's, not assumed to be 18. */
  readonly devBuy?:
    | { readonly mode: "native"; readonly amountWei: bigint }
    | { readonly mode: "erc20"; readonly amountRaw: bigint }
    | undefined;
}

/**
 * The pinned on-chain facts the verifier reads, all at ONE anchored block.
 *
 * THE SUITE TRIANGLE IS PART OF THE ANCHORS. `gatewayFactory` and
 * `factoryLocker` are both read so the verifier can require the closed triangle
 * (table gateway -> table factory -> table locker) instead of trusting the one
 * address the provider named. Reading only the gateway's opinion of its factory
 * would let a gateway with the right address and the wrong wiring pass.
 */
export interface PoolsChainAnchors {
  readonly blockNumber: bigint;
  readonly gatewayVersion: bigint;
  readonly gatewayFactory: Address;
  /** `factory.locker()` - closes the suite triangle back to the pinned table. */
  readonly factoryLocker: Address;
  readonly gatewayPaused: boolean;
  readonly gatewayDeploymentFeeWei: bigint;
  readonly gatewayMinFeeWei: bigint;
  readonly gatewayMaxFeeWei: bigint;
  /**
   * `gateway.weth()` - the ONLY address a `weth` pair may be, and the only one a
   * native prebuy may pair against (the gateway reverts otherwise).
   */
  readonly gatewayWeth: Address;
  /**
   * The three `FEES_TO_HOLDERS*` sentinels, read from the gateway that will
   * interpret them. A mode whose sentinel this suite does not expose is `null`,
   * which is a capability fact (V2 has no PAIRED or BOTH) and makes point 15
   * refuse by name rather than compare against a missing value.
   */
  readonly feesToHoldersSentinels: {
    readonly token: Address | null;
    readonly paired: Address | null;
    readonly both: Address | null;
  };
  readonly pairedAssetAllowed: boolean;
  /**
   * The pair's pricing mode, from `factory.pricingModeFor`. `null` means the
   * factory returned a byte this build has no name for - never silently treated
   * as one of the known modes.
   */
  readonly pricingMode: PoolsPricingMode | null;
  /**
   * The tick the factory would open at, and whether it came from the live feed.
   *
   * `null` on a `SIGNED_STOCK` pair: `startTickFor` REVERTS there
   * (`PriceAttestationRequired`, verified source), and the tick comes from
   * `signedStartTick` instead. Two fields rather than one nullable number,
   * because "the feed is on fallback" and "this pair has no feed at all" are
   * different facts and only one of them is a reason to refuse.
   */
  readonly startTick: number | null;
  readonly startTickLive: boolean;
  /**
   * `factory.quoteStartTick(pair, attestation, signature)` - the tick the FACTORY
   * derives from the attestation the tuple actually carries. Present only when
   * an attestation was supplied and the factory accepted it; `null` when the
   * factory itself rejected the quote, which point 14 reports by name.
   */
  readonly signedStartTick: number | null;
  /** Why the factory rejected the signed quote, when it did. Never a default. */
  readonly signedStartTickError: string | null;
  /** `factory.priceSigner()` - the only key whose signature the factory accepts. */
  readonly priceSigner: Address | null;
  /** `factory.pricingEpoch()` - bumped whenever a curve changes; stale epoch reverts. */
  readonly pricingEpoch: bigint | null;
  /**
   * The window the factory enforces on `expiresAt - observedAt`.
   *
   * `assetMaxQuoteAge` is the PER-ASSET bound the factory actually compares
   * against (`_signedStockTick`); the MIN/MAX constants are only the range an
   * owner may configure it within. Checking the constants alone would accept a
   * quote this asset's own curve rejects, so both travel.
   */
  readonly assetMaxQuoteAgeSeconds: bigint | null;
  readonly minSignedQuoteAgeSeconds: bigint | null;
  readonly maxSignedQuoteAgeSeconds: bigint | null;
  /** The anchored block's timestamp - the clock the factory's own bounds are judged on. */
  readonly blockTimestamp: bigint;
  readonly computedTokenAddress: Address;
  /** The wallet's native balance at the anchored block. */
  readonly nativeBalanceWei: bigint;
}

/** One failed point, named so the agent and the user learn WHICH check refused. */
export interface PoolsVerifierViolation {
  readonly point: PoolsVerifierPoint;
  /** What was expected versus what was found, in plain language. */
  readonly detail: string;
}

export type PoolsVerifierResult =
  | { readonly ok: true; readonly tuple: PoolsLaunchTuple; readonly checked: readonly PoolsVerifierPoint[] }
  | { readonly ok: false; readonly violations: readonly PoolsVerifierViolation[] };
