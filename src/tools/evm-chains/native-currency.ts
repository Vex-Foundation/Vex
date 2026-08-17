/**
 * EVM native-currency registry — the chain's REAL gas-asset symbol, name and
 * decimals, for agent-facing labels.
 *
 * Why this module exists: a swap leg denominated in the native asset resolves
 * to the chain-agnostic `NATIVE` sentinel (`kyberswap/constants.ts`'s
 * `NATIVE_TOKEN_ADDRESS`, `helpers.ts`'s `NATIVE` symbol). That sentinel is the
 * right IDENTITY — one value on every chain — but it is a useless LABEL: an
 * agent reading `token_out_symbol = 'NATIVE'` in its own history cannot tell
 * whether it received ETH, BNB or AVAX. This module supplies the missing fact
 * without disturbing the sentinel.
 *
 * DO NOT source this from `kyberswap/evm/config.ts`'s `toViemChain`. That
 * function hardcodes `nativeCurrency: { symbol: "ETH" }` for every chain except
 * Robinhood, so a label wired to it would read ETH on BSC, Polygon and
 * Avalanche. Replacing an unhelpful label with a false one is strictly worse:
 * the whole contract here is "right or absent, never confidently wrong".
 *
 * Resolution order:
 *   1. `./registry.ts` — Vex's own curated local chains (Robinhood 4663, which
 *      viem does not ship). Ours is the authority where we have one.
 *   2. The explicit viem/chains table below.
 *   3. `undefined` — the caller degrades to the bare sentinel.
 *
 * The viem table is keyed by an EXPLICIT chain id paired with an EXPLICIT named
 * import, never by scanning `viem/chains` for a matching `id`. Chain id 999 is
 * claimed by three viem exports — `hyperEvm` (HYPE), `wanchainTestnet` (WANt)
 * and `zoraTestnet` (ETH) — so a scan would pick a native symbol by iteration
 * order. Each pair is additionally verified at module load (see
 * `viemNativeByChainId`); a viem upgrade that repoints an export drops that
 * entry rather than mislabelling the chain.
 */

import {
  arbitrum,
  avalanche,
  base,
  berachain,
  bsc,
  hyperEvm,
  linea,
  mainnet,
  mantle,
  megaeth,
  monad,
  optimism,
  plasma,
  polygon,
  ronin,
  sonic,
  unichain,
  type Chain,
} from "viem/chains";

import { getLocalChain } from "./registry.js";

/**
 * The canonical, chain-agnostic symbol Vex mints for an EVM native leg. It is
 * the STORED value and the one anything matching on a symbol would compare
 * against — annotation never replaces it.
 */
export const NATIVE_SENTINEL_SYMBOL = "NATIVE";

/** Denomination of an EVM chain's native gas asset. */
export interface EvmNativeCurrency {
  /** Ticker, e.g. `ETH`, `BNB`, `POL`. */
  readonly symbol: string;
  /** Long name, e.g. `Ether`, `BNB`. */
  readonly name: string;
  /** Native denomination — 18 on every chain Vex trades on today. */
  readonly decimals: number;
}

/**
 * Chain id → viem chain, stated as explicit pairs. The id on the left is the
 * one Vex routes on (`kyberswap/chains.ts`); the object on the right is the
 * named viem export whose `nativeCurrency` we trust.
 */
const VIEM_CHAINS: ReadonlyArray<readonly [chainId: number, chain: Chain]> = [
  [1, mainnet],
  [10, optimism],
  [56, bsc],
  [130, unichain],
  [137, polygon],
  [143, monad],
  [146, sonic],
  [999, hyperEvm],
  [2020, ronin],
  [4326, megaeth],
  [5000, mantle],
  [8453, base],
  [9745, plasma],
  [42161, arbitrum],
  [43114, avalanche],
  [59144, linea],
  [80094, berachain],
];

/**
 * Built once, dropping any pair whose viem export no longer carries the chain
 * id we expect. That mismatch can only happen if a viem upgrade repoints an
 * export, and the safe response is to lose the label (callers fall back to the
 * bare sentinel) rather than to attach another chain's ticker.
 */
const viemNativeByChainId: ReadonlyMap<number, EvmNativeCurrency> = new Map(
  VIEM_CHAINS.filter(([chainId, chain]) => chain.id === chainId).map(([chainId, chain]) => [
    chainId,
    {
      symbol: chain.nativeCurrency.symbol,
      name: chain.nativeCurrency.name,
      decimals: chain.nativeCurrency.decimals,
    },
  ]),
);

/**
 * Resolve an EVM chain's native currency, or `undefined` when it cannot be
 * proven. Never guesses — an unknown chain returns `undefined` so the caller
 * can degrade to the bare `NATIVE` sentinel.
 */
export function getEvmNativeCurrency(chainId: number): EvmNativeCurrency | undefined {
  if (!Number.isInteger(chainId) || chainId <= 0) return undefined;

  // Vex's own registry wins: it covers chains viem does not ship (Robinhood
  // 4663) and is the curated source for anything we operate directly.
  const local = getLocalChain(chainId);
  if (local) {
    return {
      symbol: local.nativeCurrency.symbol,
      name: local.nativeCurrency.name,
      decimals: local.nativeCurrency.decimals,
    };
  }

  return viemNativeByChainId.get(chainId);
}

export function annotateNativeSymbol(symbol: string, chainId: number | null | undefined): string;
export function annotateNativeSymbol(
  symbol: string | null | undefined,
  chainId: number | null | undefined,
): string | null | undefined;
/**
 * Annotate the canonical `NATIVE` sentinel with the chain's real ticker for
 * agent-facing output — `NATIVE` becomes `NATIVE (ETH)`.
 *
 * Three properties callers depend on:
 *   - **no-op for everything else.** Any symbol that is not exactly the
 *     sentinel is returned untouched, so this is safe to run over every row of
 *     a fused multi-venue feed (real tickers, and the raw address the
 *     transactions query COALESCEs in when a symbol is null).
 *   - **degrades honestly.** An unresolvable or absent chain yields the bare
 *     sentinel. A vague-but-true label beats a confident wrong one.
 *   - **idempotent.** Re-annotating an already-annotated label does not nest,
 *     because the annotated form is no longer the bare sentinel.
 *
 * Case-sensitive on purpose: the sentinel is a value Vex mints in uppercase, so
 * a token that self-declares the symbol `native` is an ordinary (possibly
 * hostile) ERC-20 and must not be dressed up as the chain's gas asset.
 *
 * Display only. The value written to `agent_activity.token_*_symbol` stays the
 * bare sentinel — vex-app's `sanitizeTokenSymbol` allowlist rejects spaces and
 * parentheses, so a stored `NATIVE (ETH)` would sanitize to null and vanish
 * from Moves and Token History.
 */
export function annotateNativeSymbol(
  symbol: string | null | undefined,
  chainId: number | null | undefined,
): string | null | undefined {
  if (symbol !== NATIVE_SENTINEL_SYMBOL) return symbol;
  if (chainId == null) return symbol;
  const native = getEvmNativeCurrency(chainId);
  return native ? `${NATIVE_SENTINEL_SYMBOL} (${native.symbol})` : symbol;
}
