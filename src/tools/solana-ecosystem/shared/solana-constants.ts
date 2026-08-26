/**
 * Shared Solana token primitives for the new solana-ecosystem shelf.
 */

import type { QuoteAssetPolicy } from "../../dexscreener/best-liquidity-price.js";
import type { TokenMetadata } from "./types.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
/** USDC mint. Also the tier-0 quote asset behind the wSOL/USDC anchor pool. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** USDT mint. */
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** Jupiter's own dollar asset. */
export const JUPUSD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
export const SOL_DECIMALS = 9;
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/**
 * Token-2022 program id. A wallet's holdings are split across BOTH programs -
 * `getTokenAccountsByOwner` filters by exactly one program id, so a balance
 * read that queries only `SPL_TOKEN_PROGRAM_ID` silently misses every
 * Token-2022 position (5 of the 12 accounts on the wallet probed 2026-08-26).
 * The parsed account shape is identical to the classic program's, plus an
 * `info.extensions[]` array.
 */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const WELL_KNOWN_SOLANA_TOKENS: readonly TokenMetadata[] = [
  { chain: "solana", address: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9 },
  { chain: "solana", address: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6 },
  // Jupiter's own dollar asset. It is what a PREDICTION position pays out and
  // what Jupiter's venue fees are taken in, so its raw amounts show up across
  // the activity log; without an entry here they are unreadable integers.
  { chain: "solana", address: JUPUSD_MINT, symbol: "JupUSD", name: "Jupiter USD", decimals: 6 },
  { chain: "solana", address: USDT_MINT, symbol: "USDT", name: "Tether USD", decimals: 6 },
  { chain: "solana", address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", decimals: 6, logoUri: "https://static.jup.ag/jup/icon.png" },
  { chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk", decimals: 5 },
  { chain: "solana", address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "mSOL", name: "Marinade Staked SOL", decimals: 9 },
  { chain: "solana", address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "jitoSOL", name: "Jito Staked SOL", decimals: 9 },
  { chain: "solana", address: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", symbol: "bSOL", name: "BlazeStake Staked SOL", decimals: 9 },
  { chain: "solana", address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", symbol: "ETH", name: "Wrapped Ether (Wormhole)", decimals: 8 },
  { chain: "solana", address: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", symbol: "wBTC", name: "Wrapped BTC (Wormhole)", decimals: 8 },
  { chain: "solana", address: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH", name: "Pyth Network", decimals: 6 },
  { chain: "solana", address: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", symbol: "JTO", name: "Jito", decimals: 9 },
  { chain: "solana", address: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk", symbol: "WEN", name: "Wen", decimals: 5 },
  { chain: "solana", address: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", symbol: "RNDR", name: "Render Token", decimals: 8 },
  { chain: "solana", address: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", symbol: "JLP", name: "Jupiter Perps LP", decimals: 6 },
] as const;

/**
 * Which quote assets may price a Solana token (see
 * `dexscreener/best-liquidity-price.ts`). Base58 case is identity, so these
 * are the canonical mints verbatim.
 *
 * LIVE-VERIFIED 2026-08-26 on `api.dexscreener.com` (archived under
 * `scratchpad/solana-probes/`): `tokens/v1/solana/<wSOL>` answered SOL/USDC at
 * `priceUsd` 96.76, `<USDC>` answered USDC/USDT at 1.00016 and `<JupUSD>`
 * answered JupUSD/USDC at 0.9996 - so all three stables and the wrapped native
 * are real, deep, live quote assets on this chain.
 *
 * Declared omission: no other stablecoin (PYUSD, USDS, FDUSD ...) is listed.
 * Adding one is additive and safe; leaving it out only means a token quoted
 * ONLY in it falls to tier 2 and needs the pool-list fallback or stays
 * unpriced. Never a wrong number.
 */
export const SOLANA_QUOTE_ASSET_POLICY: QuoteAssetPolicy = {
  stables: new Set([USDC_MINT, USDT_MINT, JUPUSD_MINT]),
  wrappedNative: SOL_MINT,
};

const wellKnownBySymbol = new Map<string, TokenMetadata>();
const wellKnownByMint = new Map<string, TokenMetadata>();

for (const token of WELL_KNOWN_SOLANA_TOKENS) {
  wellKnownBySymbol.set(token.symbol.toLowerCase(), token);
  wellKnownByMint.set(token.address, token);
}

export function getWellKnownSolanaTokenBySymbol(symbol: string): TokenMetadata | undefined {
  return wellKnownBySymbol.get(symbol.toLowerCase());
}

export function getWellKnownSolanaTokenByMint(mint: string): TokenMetadata | undefined {
  return wellKnownByMint.get(mint);
}
