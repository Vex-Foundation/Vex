/**
 * AgentTaxV2 per chain - the contract that HOLDS a Virtuals agent creator's
 * trading-tax revenue, and the numbers that decide what the creator eventually
 * receives.
 *
 * EVERY ADDRESS AND EVERY RATE BELOW WAS READ FROM THE CHAIN on 2026-09-04, not
 * copied from a doc. The vault address is not hardcoded folklore either: it is
 * `FFactoryV2.taxVault()`, the same value the curve factory itself hands
 * `FRouterV3` when it deposits tax, so the table below is a PIN of a measured
 * read and the module re-reads `taxVault()` before it trusts it.
 *
 * THE TWO DENOMINATIONS, AND WHY CONFUSING THEM IS A MILLIONFOLD ERROR.
 * AgentTaxV2 collects in `taxToken` and pays in `assetToken`, and they are NOT
 * the same asset:
 *
 *   | chain          | taxToken (collected)      | assetToken (paid out) |
 *   |----------------|---------------------------|-----------------------|
 *   | Base 8453      | VIRTUAL, 18 decimals      | USDC, 6 decimals      |
 *   | Robinhood 4663 | VIRTUAL, 18 decimals      | USDG, 6 decimals      |
 *
 * `amountCollected` and `amountSwapped` are VIRTUAL at 18 decimals; the money
 * that lands in the creator's wallet is a 6-decimal stablecoin. A reader that
 * carries one number without its asset and its scale is off by 10^12.
 *
 * Both token identities are READ from the contract at call time (`taxToken()`,
 * `assetToken()`, then `symbol()`/`decimals()` on each). The table here is the
 * expectation this module was built against; a live mismatch is reported, never
 * silently overridden, because a changed asset changes what the numbers mean.
 *
 * SOLANA AND ETHEREUM ARE ABSENT ON PURPOSE. AgentTaxV2 is an EVM contract and
 * Virtuals deploys the launchpad V5 suite on Base and Robinhood only; the two
 * remaining chains in the namespace's own vocabulary have no entry here and the
 * handler refuses them by name rather than reading zero from nowhere.
 */

import type { Address } from "viem";

/** One chain's AgentTaxV2 deployment and the facts measured against it. */
export interface VirtualsTaxDeployment {
  /** Canonical Virtuals chain slug (`chain-param.ts` vocabulary). */
  readonly slug: string;
  readonly chainId: number;
  /** The curve factory whose `taxVault()` names the tax contract. */
  readonly ffactoryV2: Address;
  /** `FFactoryV2.taxVault()`, measured 2026-09-04. Re-read before it is trusted. */
  readonly agentTaxV2: Address;
  /**
   * The EIP-1967 implementation behind the proxy at the time of measurement.
   * Compared against the live slot so an upgrade is REPORTED rather than
   * silently changing what these getters mean.
   */
  readonly agentTaxV2Implementation: Address;
  /** Expected `taxToken()` - the asset tax is collected in. */
  readonly expectedTaxToken: Address;
  /** Expected `assetToken()` - the asset the creator is paid in. */
  readonly expectedAssetToken: Address;
  /** RPC used when the local chain registry does not know this chain. */
  readonly defaultRpcUrl: string;
}

/**
 * Base 8453.
 *
 * Measured 2026-09-04 at block 50881423: `taxVault` 0x617F..., implementation
 * 0xF6dE..., `taxToken` VIRTUAL (18), `assetToken` USDC (6), `feeRate` 3000
 * (30 percent to treasury), `minSwapThreshold` 10 VIRTUAL,
 * `maxSwapThreshold` 1000 VIRTUAL.
 *
 * RPC: `base.drpc.org`, the same endpoint and for the same measured reason as
 * `tools/uniswap/deployments.ts` (publicnode refuses archive-class methods,
 * `mainnet.base.org` rate limits at about five requests).
 */
const BASE: VirtualsTaxDeployment = {
  slug: "base",
  chainId: 8453,
  ffactoryV2: "0x488Db0978b34C6Fd901760b9024B565C1117c7c8",
  agentTaxV2: "0x617Fd668c5b0d1906C0B3E7E3E49d1409Df0a528",
  agentTaxV2Implementation: "0xF6dEd65faaB429b2d5E13552D618a2E231f3D129",
  expectedTaxToken: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  expectedAssetToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  defaultRpcUrl: "https://base.drpc.org",
};

/**
 * Robinhood Chain 4663.
 *
 * Measured 2026-09-04 at block 54534905: `taxVault` 0x6D80..., implementation
 * 0x4D4e..., `taxToken` VIRTUAL (18), `assetToken` USDG (6), `feeRate` 3000,
 * `minSwapThreshold` 1 VIRTUAL, `maxSwapThreshold` 1000 VIRTUAL.
 *
 * The local chain registry knows 4663, so the client defers to it and the user's
 * own RPC override wins; this URL is the fallback the registry itself carries.
 */
const ROBINHOOD: VirtualsTaxDeployment = {
  slug: "robinhood",
  chainId: 4663,
  ffactoryV2: "0xFC2E4Da3EdB2E18100473339c763705d263D20A9",
  agentTaxV2: "0x6D80B81d9Fc56A7A839b1Af9006Eb49151961ce7",
  agentTaxV2Implementation: "0x4D4e8F06FE9a3dB2FA7AD4D17893128600Ec01bB",
  expectedTaxToken: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  expectedAssetToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
};

const BY_SLUG: ReadonlyMap<string, VirtualsTaxDeployment> = new Map(
  [BASE, ROBINHOOD].map((deployment) => [deployment.slug, deployment]),
);

/** The slugs a creator-fee read can answer for, in table order. */
export const VIRTUALS_TAX_CHAIN_SLUGS: readonly string[] = [BASE.slug, ROBINHOOD.slug];

/**
 * The AgentTaxV2 deployment for a canonical Virtuals chain slug.
 *
 * @returns `undefined` for `solana` and `ethereum`, which have no AgentTaxV2.
 * The caller refuses those by name with the reason; it never falls back.
 */
export function virtualsTaxDeployment(slug: string): VirtualsTaxDeployment | undefined {
  return BY_SLUG.get(slug);
}

/**
 * The protocol's own fee denominator (`AgentTaxV2.DENOM`, an internal constant
 * with no getter). `feeRate` and `partnerFeeRate` are both parts in 10000, so
 * 3000 is 30 percent - not 3000 bps of something else, and not a percentage.
 */
export const AGENT_TAX_DENOM = 10_000;

/**
 * `keccak256("SWAP_ROLE")`, verified live against `AgentTaxV2.SWAP_ROLE()` on
 * both chains 2026-09-04 (identical on both).
 *
 * This is the role that can call `swapForTokenAddress` / `batchSwapForTokenAddress`,
 * the ONLY functions that turn collected tax into a creator payout. The handler
 * reads `hasRole(SWAP_ROLE, creator)` live so the refusal it returns is a
 * MEASUREMENT of this wallet against this contract, not a claim from a document.
 */
export const AGENT_TAX_SWAP_ROLE =
  "0x499b8dbdbe4f7b12284c4a222a9951ce4488b43af4d09f42655d67f73b612fe1" as const;
