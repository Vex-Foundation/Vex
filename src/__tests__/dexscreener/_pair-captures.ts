/**
 * Recorded DexScreener pair windows, run through the REAL validators.
 *
 * Every number the pair-list tests assert — byte budgets, drop accounting,
 * medians — is measured over bytes the provider actually sent, parsed by the
 * same validators production uses. A hand-written `DexPair` would only prove the
 * test's own assumptions, which is precisely how two shipped tools stayed broken
 * for months behind a green suite.
 *
 * See `fixtures/live-captures/README.md` for provenance and regeneration.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  validatePairsResponse,
  validateSearchResponse,
  validateTokensPairsResponse,
  validateTokensResponse,
} from "@tools/dexscreener/validation/pairs.js";
import type { DexPair, PairsResponse, SearchResponse } from "@tools/dexscreener/types.js";

interface Capture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly response: unknown;
}

function loadCapture(name: string): Capture {
  const path = fileURLToPath(new URL(`./fixtures/live-captures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Capture;
}

/**
 * `search?q=SOL/USDC` — 30 rows, one of which carries a `baseToken.name` of
 * 34,090 characters and a `baseToken.symbol` of 9,575. The adversarial-string
 * witness.
 */
export function searchSolUsdc(): SearchResponse {
  return validateSearchResponse(loadCapture("search-v1-sol-usdc-adversarial-strings").response);
}

/**
 * `search?q=USDC` — 30 rows across 15 chains with **zero** Ethereum rows. The
 * witness for "a chain-filtered empty result is not an absent market".
 */
export function searchUsdc(): SearchResponse {
  return validateSearchResponse(loadCapture("search-v1-usdc").response);
}

/** `latest/dex/pairs/ethereum/<WETH-USDC pool>` — one pool, the single-row case. */
export function pairsWethUsdcPool(): PairsResponse {
  return validatePairsResponse(loadCapture("pairs-v1-ethereum-weth-usdc-pool").response);
}

/** `token-pairs/v1/ethereum/WETH` — 30 pools of one token. */
export function tokenPairsWeth(): DexPair[] {
  return validateTokensPairsResponse(loadCapture("token-pairs-v1-ethereum-weth").response);
}

/**
 * `token-pairs/v1/solana/BONK` — 30 pools whose worst `priceUsd` is ~13.8x the
 * median across the same token's pools. (The same mint showed 4,892x a day
 * earlier: the magnitude moves, the mechanism does not.)
 */
export function tokenPairsBonk(): DexPair[] {
  return validateTokensPairsResponse(
    loadCapture("token-pairs-v1-solana-bonk-price-outlier").response,
  );
}

/**
 * `tokens/v1/ethereum/<40 addresses>` — **30 rows for 40 requested addresses**,
 * HTTP 200, 10 silently absent. The provider-side-truncation witness.
 */
export function tokensEthereum40(): { requestedAddresses: string; pairs: DexPair[] } {
  const capture = loadCapture("tokens-v1-ethereum-40-requested-30-returned");
  const addresses = capture.endpoint.slice(capture.endpoint.lastIndexOf("/") + 1);
  return {
    requestedAddresses: addresses,
    pairs: validateTokensResponse(capture.response),
  };
}
