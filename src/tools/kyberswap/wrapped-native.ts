/**
 * KyberSwap wrapped-native token registry — the wrapped-native ERC-20 address
 * per aggregator chain, keyed by chain slug.
 *
 * Used ONLY to classify a swap leg as economically native for RECORDING
 * (trade side, benchmark/settlement asset keys) when the caller passes the
 * wrapped contract address directly instead of the native sentinel/keyword —
 * never for routing, allowance, or execution, where a wrapped token remains
 * an ordinary ERC-20.
 *
 * Coverage is EXACTLY the `aggregator: true` chains in `chains.ts` — every
 * aggregator chain has a wrapped-native asset by construction, so a missing
 * entry is a registry bug, not a legitimate "no wrapped native" case. Fail
 * closed (throw) rather than returning `undefined`.
 *
 * Addresses are the identity key (verified on-chain 2026-07-19); the symbol in
 * each comment is for human reporting ONLY. Never compare by symbol: several
 * chains have a token literally named "WETH" that is a DIFFERENT bridged asset
 * from the chain's own wrapped-native (e.g. Mantle's bridged WETH is not
 * WMNT), and Sonic's wrapped-native symbol is lowercase `wS`.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import type { KyberChainSlug } from "./types.js";

const WRAPPED_NATIVE_ADDRESS: Partial<Record<KyberChainSlug, Address>> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL
  optimism: "0x4200000000000000000000000000000000000006", // WETH
  avalanche: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
  base: "0x4200000000000000000000000000000000000006", // WETH
  linea: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", // WETH
  mantle: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", // WMNT — NOT the bridged "WETH" on Mantle
  sonic: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", // wS (lowercase symbol)
  berachain: "0x6969696969696969696969696969696969696969", // WBERA
  ronin: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4", // WRON
  unichain: "0x4200000000000000000000000000000000000006", // WETH
  hyperevm: "0x5555555555555555555555555555555555555555", // WHYPE
  plasma: "0x6100e367285b01f48d07953803a2d8dca5d19873", // WXPL
  monad: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", // WMON
  megaeth: "0x4200000000000000000000000000000000000006", // WETH
  robinhood: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
};

/**
 * Get the wrapped-native ERC-20 address for a KyberSwap aggregator chain.
 * Fail-closed: throws for any slug without a registered entry (non-aggregator
 * chains such as scroll/zksync, or an unknown slug).
 */
export function getKyberWrappedNativeAddress(slug: KyberChainSlug): Address {
  const address = WRAPPED_NATIVE_ADDRESS[slug];
  if (!address) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      `No wrapped-native token registered for KyberSwap chain "${slug}"`,
    );
  }
  return address;
}
