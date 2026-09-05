/**
 * Recorded pools.fun responses - the raw bytes the provider actually sent.
 *
 * The validation, client and error tests parse these through the REAL
 * production code; a hand-written row would only prove the test's own
 * assumptions, and this provider publishes no schema at all, so these bytes are
 * the only description of the API that exists. See
 * `fixtures/live-captures/README.md` for provenance and what each file pins.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Capture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly response: unknown;
  /** Present on the error captures. */
  readonly httpStatus?: number;
}

/** The HTML 404 envelope has a distinct shape (no JSON `response`). */
export interface HtmlCapture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly httpStatus: number;
  readonly contentType: string;
  readonly bodyText: string;
  readonly note: string;
}

function load<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/live-captures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Raw `response` body of a standard capture. */
export function captureResponse(name: string): unknown {
  return load<Capture>(name).response;
}

/** A whole error capture (body plus the status the provider answered with). */
export function errorCapture(name: string): Capture {
  return load<Capture>(name);
}

/** The HTML route-not-found capture, whole. */
export function htmlCapture(): HtmlCapture {
  return load<HtmlCapture>("route-not-found-404-html");
}

/** Named accessors for the captures the tests assert against. */
export const CAPTURES = {
  discoverPoolsFun: "discover-poolsfun-marketcap-desc",
  discoverSushiStockPaired: "discover-sushi-stock-paired",
  discoverEmpty: "discover-empty-results",
  discoverCopycatSymbols: "discover-search-copycat-symbols",
  discoverDeployerGatewayLaunch: "discover-deployer-gateway-launch",
  discoverInvalidSortBy: "discover-invalid-sortby-400",
  ohlcvHour: "ohlcv-hour-weth-quote",
  ohlcvUnknownToken: "ohlcv-unknown-token-502",
  /** The V1 capture, kept as the characterization baseline for the suite repair. */
  prepareWalletRecipient: "launches-prepare-wallet-recipient",
  /** The three V3 prepares of 2026-09-04: plain WETH, holders-BOTH, and a feed-priced stock. */
  prepareV3Weth: "launches-prepare-v3-weth",
  prepareV3HoldersBoth: "launches-prepare-v3-holders-both",
  prepareV3StockNvda: "launches-prepare-v3-stock-nvda",
  launchConfigV3: "launches-config-v3",
  // ── The 2026-09-04 read-depth captures (PR4) ──────────────────────
  discoverVexAttested: "discover-vexattested-true",
  discoverVexAttestedFalse400: "discover-vexattested-false-400",
  discoverHolderRewards: "discover-holderrewards-true",
  discoverBrandUnofficial: "discover-brand-unofficial-row",
  discoverPairedStockIlliquid: "discover-paired-stock-illiquid-row",
  launchAssets: "launch-assets",
  holderRewardsTokenMode: "holder-rewards-token-mode",
  holderRewardsPairedMode: "holder-rewards-paired-mode",
  holderRewardsBothMode: "holder-rewards-both-mode",
  holderRewardsWithWallet: "holder-rewards-token-mode-wallet",
  holderRewardsNotAHoldersToken404: "holder-rewards-not-a-holders-token-404",
  holderRewardsBadChecksumWallet502: "holder-rewards-bad-checksum-wallet-502",
  holderRewardsValidChecksumWallet: "holder-rewards-valid-checksum-wallet",
  /** RPC reads, not HTTP captures - the machine artifacts rule 10 point 2 requires. */
  chainRewardModeOrdinals: "chain-holder-rewards-mode-ordinals",
  chainLaunchAssetPricingModes: "chain-launch-asset-pricing-modes",
  prepareXUnresolvable: "launches-prepare-x-unresolvable-400",
  prepareInsufficientDevBuy: "launches-prepare-insufficient-dev-buy-400",
} as const;
