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
 * THIRTEEN POINTS, adopted verbatim from the Codex review and numbered here so
 * the checklist, the code, and the tests all use one set of names. Every point
 * is REQUIRED before signing; there is no partial pass and no warn-and-continue.
 */

import type { Address, Hex } from "viem";

/**
 * The 13 checks, in the order they run.
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
] as const;

export type PoolsVerifierPoint = (typeof POOLS_VERIFIER_POINTS)[number];

/**
 * The decoded `LaunchParams` tuple, as the gateway defines it.
 *
 * Named members rather than positional: a 12-member tuple where two adjacent
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
}

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
   */
  readonly feeRecipient: Address;
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

/** The pinned on-chain facts the verifier reads, all at ONE anchored block. */
export interface PoolsChainAnchors {
  readonly blockNumber: bigint;
  readonly gatewayVersion: bigint;
  readonly gatewayFactory: Address;
  readonly gatewayPaused: boolean;
  readonly gatewayDeploymentFeeWei: bigint;
  readonly gatewayMinFeeWei: bigint;
  readonly gatewayMaxFeeWei: bigint;
  /**
   * `gateway.weth()` - the ONLY address a `weth` pair may be, and the only one a
   * native prebuy may pair against (the gateway reverts otherwise).
   */
  readonly gatewayWeth: Address;
  readonly pairedAssetAllowed: boolean;
  readonly startTick: number;
  readonly startTickLive: boolean;
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
