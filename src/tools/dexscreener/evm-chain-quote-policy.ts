/**
 * DexScreener slug + quote-asset policy, per EVM chain.
 *
 * ## Why this table exists
 *
 * MEASURED 2026-08-26 11:25Z: Khalani's balance scan stopped populating
 * `extensions.price.usd`. Base and Arbitrum rows for ETH and USDC came back
 * with a null price, and the owner's portfolio dropped $23.71 for that reason
 * alone. Khalani's price is still preferred when present - it is the balance
 * source's own number and must never be overwritten - but a null now falls
 * through to OUR DexScreener read, using the same quote rule as every other
 * chain (`best-liquidity-price.ts`).
 *
 * A chain with no entry here gets NO fallback and its price-less rows stay
 * unpriced. That is the honest outcome: guessing a slug would price a token
 * off some other chain's identically-addressed contract.
 *
 * ## Every address below was LIVE-CONFIRMED, none was remembered
 *
 * Rule 10, and it earned its place here: the initial candidate table was
 * assembled from convention and TWO of its rows would have been wrong. The
 * confirmation procedure, per chain:
 *
 *  1. `GET /tokens/v1/{slug}/{wrappedNative}` must return pair rows in which
 *     the wrapped native appears as `baseToken.address` or
 *     `quoteToken.address`, paired with a USD stablecoin. The stablecoin's
 *     address is then read OUT OF THAT ROW, never typed from memory.
 *  2. The stablecoin must then be shown to actually trade at a dollar. A
 *     symbol containing "USD" proves nothing.
 *
 * Step 2 is not ceremony. `/tokens/v1/zksync/{USDC.e}` answered a
 * USDC.e/USDT pool quoting `priceUsd` **1.14**, and Berachain's stable is
 * echoed by the provider under the symbol **BUSD** at an address that is not
 * Binance USD. Both were resolved by reading the deepest pool that QUOTES the
 * stablecoin and taking `priceUsd / priceNative`: zkSync USDC.e implies
 * $0.9999998 across a $4.38M WETH pool (the $1.14 row is one thin pool's own
 * mispriced `priceUsd`, which is exactly what the liquidity floor and the
 * deepest-pool rule exist to discard), and Berachain BUSD implies $0.999995
 * across a $1.57M USDe pool, with USDe/BUSD itself trading at 1.00048.
 *
 * Captures are committed under `src/__tests__/fixtures/dexscreener/quote-policy/`
 * and archived with URL and timestamp under
 * `scratchpad/board-v4-probes/quote-policy-{slug}.json`. `evm-chain-quote-policy.test.ts`
 * re-derives every row from those fixtures, so a hand-edited address here
 * fails the suite.
 *
 * ## Confirming pair per row (live, 2026-08-26)
 *
 * | chain | slug | pair | priceUsd | liquidity |
 * | --- | --- | --- | --- | --- |
 * | 1 | ethereum | WETH/USDC | 2471.89 | $3.76M |
 * | 10 | optimism | WETH/USDT | 2471.45 | $468k |
 * | 56 | bsc | WBNB/USDT | 699.03 | $11.7M |
 * | 130 | unichain | WETH/USDC | 2470.73 | $360k |
 * | 137 | polygon | WPOL/USDT0 | 0.1092 | $1.34M |
 * | 143 | monad | MON/USDC | 0.02787 | $1.61M |
 * | 324 | zksync | WETH/USDC.e | 2468.04 | $4.38M |
 * | 2741 | abstract | WETH/USDC.e | 2467.85 | $452k |
 * | 4663 | robinhood | see `evm-chains/registry.ts` | | |
 * | 5000 | mantle | WMNT/USDT0 | 0.4921 | $3.07M |
 * | 8453 | base | WETH/USDC | 2472.15 | $4.41M |
 * | 42161 | arbitrum | USDC/WETH | 1.000021 | $37.6M |
 * | 43114 | avalanche | WAVAX/USDC | 7.24 | $9.60M |
 * | 59144 | linea | WETH/USDC | 2468.97 | $181k |
 * | 80094 | berachain | WBERA/BUSD | 0.1730 | $277k |
 * | 747474 | katana | vbETH/vbUSDC | 2470.68 | $620k |
 *
 * Every ETH-native row independently agrees with mainnet WETH at $2471.89 to
 * within 0.2%, which is the cross-check that the slug, the address and the
 * stablecoin are all the right ones.
 *
 * ## Chains deliberately WITHOUT a row
 *
 *  - **16661** (0G Mainnet): absent from DexScreener's own live chain catalog
 *    (73 entries, probed 2026-08-26) and `/tokens/v1/0g/...` answered `[]`. No
 *    provider coverage.
 *  - **5734951** (Jovay): absent from the same catalog; `/tokens/v1/jovay/...`
 *    answered `[]`. No provider coverage.
 *
 * Khalani rows on either chain stay unpriced when Khalani gives no price. That
 * is a declared gap, not a silent one, and adding a row later needs the same
 * two-step live confirmation as every row above.
 *
 * ## Other declared omissions
 *
 * ONE stablecoin per chain, the one confirmed above. USDT, DAI, USDe, USDbC
 * and the rest are real quote assets on several of these chains; leaving them
 * out can only cost a token a tier-0 pool and push it to a native-quoted pool
 * or to unpriced, never produce a wrong number. Adding one is additive and
 * requires the same two-step confirmation.
 *
 * Non-EVM chains are not here: Solana's policy lives with the Solana constants
 * and Robinhood's with the local-chain registry, because each belongs beside
 * the registry that owns that chain.
 */

import type { QuoteAssetPolicy } from "./best-liquidity-price.js";

/** One chain's DexScreener identity and pricing policy. */
export interface EvmChainQuotePolicy {
  /** DexScreener chain slug for `tokens/v1` / `token-pairs/v1`. */
  readonly slug: string;
  readonly policy: QuoteAssetPolicy;
}

/**
 * chainId -> [slug, wrappedNative, ...stables]. Lowercase throughout, because
 * the EVM address-identity policy is lowercase. Kept as a flat literal so the
 * table test can enumerate it and re-derive every address from the fixtures.
 */
const TABLE: ReadonlyArray<readonly [number, string, string, ...string[]]> = [
  [1, "ethereum", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  [10, "optimism", "0x4200000000000000000000000000000000000006", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"],
  [56, "bsc", "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", "0x55d398326f99059ff775485246999027b3197955"],
  [130, "unichain", "0x4200000000000000000000000000000000000006", "0x078d782b760474a361dda0af3839290b0ef57ad6"],
  [137, "polygon", "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"],
  [143, "monad", "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", "0x754704bc059f8c67012fed69bc8a327a5aafb603"],
  [324, "zksync", "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91", "0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4"],
  [2741, "abstract", "0x3439153eb7af838ad19d56e1571fbd09333c2809", "0x84a71ccd554cc1b02749b35d22f684cc8ec987e1"],
  [5000, "mantle", "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8", "0x779ded0c9e1022225f8e0630b35a9b54be713736"],
  [8453, "base", "0x4200000000000000000000000000000000000006", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  [42161, "arbitrum", "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
  [43114, "avalanche", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"],
  [59144, "linea", "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", "0x176211869ca2b568f2a7d4ee941e073a821ee1ff"],
  [80094, "berachain", "0x6969696969696969696969696969696969696969", "0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce"],
  [747474, "katana", "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62", "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36"],
];

const BY_CHAIN_ID: ReadonlyMap<number, EvmChainQuotePolicy> = new Map(
  TABLE.map(([chainId, slug, wrappedNative, ...stables]) => [
    chainId,
    { slug, policy: { stables: new Set(stables), wrappedNative } },
  ]),
);

/**
 * The slug and policy for one EVM chain id, or `undefined` when this table has
 * no entry - which means "no DexScreener fallback on that chain", never "guess".
 */
export function getEvmChainQuotePolicy(chainId: number): EvmChainQuotePolicy | undefined {
  return BY_CHAIN_ID.get(chainId);
}

/** Every row, for the table test that re-derives each one from its fixture. */
export function listEvmChainQuotePolicies(): ReadonlyArray<EvmChainQuotePolicy & { chainId: number }> {
  return TABLE.map(([chainId, slug, wrappedNative, ...stables]) => ({
    chainId,
    slug,
    policy: { stables: new Set(stables), wrappedNative },
  }));
}
