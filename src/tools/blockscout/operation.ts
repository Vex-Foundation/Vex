import { getUserBlockscoutOverrideForChain } from "../../config/chain-blockscout-overrides.js";
import { BlockscoutErrorCodes, blockscoutError } from "./errors.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_BLOCKSCOUT_HOST = "robinhoodchain.blockscout.com";
export const ROBINHOOD_BLOCKSCOUT_ORIGIN =
  `https://${ROBINHOOD_BLOCKSCOUT_HOST}`;

export function getBlockscoutBaseUrlForChain(chainId: number): string {
  const override = getUserBlockscoutOverrideForChain(chainId);
  if (override !== undefined) return override;
  if (chainId === ROBINHOOD_CHAIN_ID) return ROBINHOOD_BLOCKSCOUT_ORIGIN;
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
 * Build the only provider operation this seam can perform.
 *
 * There is intentionally no generic URL input and no query-string surface.
 */
export function buildRobinhoodTokenBalancesUrl(address: string): URL {
  const validated = validateBlockscoutAddress(address);
  return new URL(
    `api/v2/addresses/${validated}/token-balances`,
    `${getBlockscoutBaseUrlForChain(ROBINHOOD_CHAIN_ID)}/`,
  );
}

/** Verify that Chromium did not move the request to any other URL. */
export function isExactRobinhoodTokenBalancesUrl(
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
