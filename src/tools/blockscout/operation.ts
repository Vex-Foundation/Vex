import { getUserBlockscoutOverrideForChain } from "../../config/chain-blockscout-overrides.js";
import { BlockscoutErrorCodes, blockscoutError } from "./errors.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_BLOCKSCOUT_HOST = "robinhoodchain.blockscout.com";
export const ROBINHOOD_BLOCKSCOUT_ORIGIN =
  `https://${ROBINHOOD_BLOCKSCOUT_HOST}`;

/**
 * Arc's official explorer (docs.arc.io) is Blockscout, confirmed by
 * Blockscout's own announcement ("Blockscout is proud to support Arc from day
 * one with a fully operational... block explorer") and by `explorer.arc.io`'s
 * own page title ("Arc Mainnet blockchain explorer - View Arc Mainnet stats |
 * Blockscout"), Blockscout's standard SEO template. It sits behind the SAME
 * Cloudflare Managed Challenge Robinhood's instance does (measured: identical
 * `cf-mitigated: challenge` response to a bare request) — not independently
 * live-probed end-to-end through the app the way Robinhood's endpoint index in
 * BLOCKSCOUT.md was, so its exact `/api/v2` response shape is inherited by
 * extension (same Blockscout software) rather than separately measured.
 */
export const ARC_CHAIN_ID = 5042;
export const ARC_BLOCKSCOUT_HOST = "explorer.arc.io";
export const ARC_BLOCKSCOUT_ORIGIN = `https://${ARC_BLOCKSCOUT_HOST}`;

/** Built-in (non-override) Blockscout hosts, one per chain that has one. */
const BUILTIN_BLOCKSCOUT_ORIGINS: Readonly<Record<number, string>> = {
  [ROBINHOOD_CHAIN_ID]: ROBINHOOD_BLOCKSCOUT_ORIGIN,
  [ARC_CHAIN_ID]: ARC_BLOCKSCOUT_ORIGIN,
};

export function getBlockscoutBaseUrlForChain(chainId: number): string {
  const override = getUserBlockscoutOverrideForChain(chainId);
  if (override !== undefined) return override;
  const builtin = BUILTIN_BLOCKSCOUT_ORIGINS[chainId];
  if (builtin !== undefined) return builtin;
  throw new Error("No Blockscout base URL is configured for this chain");
}

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Validate an address before it can enter the privileged Electron transport. */
export function validateBlockscoutAddress(address: string): string {
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    throw blockscoutError(
      BlockscoutErrorCodes.ADDRESS_INVALID,
      "The Blockscout inventory address is not a valid EVM address",
      "Pass a 0x-prefixed 20-byte EVM address.",
    );
  }
  return address;
}

/**
 * Build the only provider operation this seam can perform, for one of the
 * chain ids {@link getBlockscoutBaseUrlForChain} resolves a host for.
 *
 * There is intentionally no generic URL input and no query-string surface:
 * the chain id selects a host from the small built-in/override allow-list
 * above, never an arbitrary caller-supplied origin.
 */
export function buildBlockscoutTokenBalancesUrl(chainId: number, address: string): URL {
  const validated = validateBlockscoutAddress(address);
  return new URL(
    `api/v2/addresses/${validated}/token-balances`,
    `${getBlockscoutBaseUrlForChain(chainId)}/`,
  );
}

/** Verify that Chromium did not move the request to any other URL. */
export function isExactBlockscoutTokenBalancesUrl(
  finalUrl: string,
  requestedUrl: URL,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return false;
  }
  return (
    parsed.protocol === requestedUrl.protocol &&
    parsed.host === requestedUrl.host &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === requestedUrl.pathname &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}
