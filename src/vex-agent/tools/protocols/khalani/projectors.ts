/**
 * Khalani concise token/chain/quote-route projectors (P0-4).
 *
 * Khalani read tools ship heavy upstream payloads the model never acts on:
 * `chains.list` returns a full `KhalaniChain[]` with `rpcUrls`/`blockExplorers`,
 * `tokens.{top,search,balances}` and `tokens.autocomplete` return full
 * `KhalaniToken` rows carrying a `logoURI` plus an open `extensions[key:unknown]`
 * passthrough bag. On the hot pre-mutation path (`tokens.search` — the canonical
 * cross-chain contract resolver) and on `chains.list`/`autocomplete` this is the
 * biggest byte sink in the Khalani bundle and dilutes the contract/price signal.
 *
 * These pure projectors strip that noise at the handler seam — BEFORE the result
 * is serialized — so the model sees a lean, decision-relevant row: token identity
 * plus the lifted price/balance/risk signal, and chain identity plus native-coin
 * facts. Every Khalani read tool is `mutating:false` / `actionKind:"read"` with
 * no `_tradeCapture`, so trimming both the output string and the unused `data` is
 * safe (see CC-4 / P0-4 in the tool-output eval).
 *
 * The internal rpc/explorer resolvers (`getChainRpcUrl`/`getChainExplorerUrl` in
 * `@tools/khalani/chains.js`) read `rpcUrls`/`blockExplorers` off the CACHED chain
 * REGISTRY (`getCachedKhalaniChains()`), never off this projected tool output — so
 * dropping those provider-metadata blocks here does not affect chain resolution or
 * bridging.
 *
 * Default-concise with NO verbosity knob: there is no agent use case for the
 * dropped `logoURI`, the open `extensions` bag, or the provider rpc/explorer URLs.
 *
 * Every field read is defensive: the shapes come from an external API, so missing
 * / null / wrong-typed fields are normalised rather than assumed present. Note:
 * `KhalaniTokenMeta` (the `fromTokenMeta`/`toTokenMeta` on `KhalaniOrder`) is a
 * DIFFERENT, already-minimal shape (`{symbol,decimals,logoURI?}`) — it is NOT a
 * `KhalaniToken`, so it is intentionally NOT routed through `projectToken`.
 */

import type { ChainFamily, KhalaniChain, KhalaniToken, QuoteRoute } from "@tools/khalani/types.js";
import { projectBalanceRow } from "../amount-display.js";

// ── Concise output shapes ────────────────────────────────────────

/**
 * Concise Khalani token row. KEEPS identity (`symbol`/`name`/`address`/`chainId`/
 * `decimals`) and lifts the three decision signals out of the open `extensions`
 * bag: USD price, the wallet balance (present on the balances path), and the
 * risk-token flag. DROPS `logoURI` and the rest of the open `extensions`
 * passthrough bag.
 */
export interface ConciseKhalaniToken {
  symbol: string;
  name: string;
  address: string;
  chainId: number;
  decimals: number;
  /**
   * The balance quartet, present TOGETHER or not at all.
   *
   * A token row that carries no `extensions.balance` (the `tokens.search` /
   * `tokens.top` / `autocomplete` paths) is a pure IDENTITY row and stays one:
   * emitting four nulls there would read as "you hold zero of it", which is a
   * different claim from "this lookup did not ask about your wallet".
   *
   * On the balances path all four are present. `balanceRaw` is the atomic
   * amount as a DECIMAL string (never hex) and is what a trade is sized from,
   * together with `decimals`. `balance` is the exact human amount as a STRING;
   * `valueUsd` is a DISPLAY-GRADE estimate derived from a provider float and
   * never gates a spend.
   */
  balanceRaw?: string;
  balance?: string | null;
  valueUsd?: string | null;
  /** Lifted from `extensions.price.usd` (string from upstream). */
  priceUsd?: string | null;
  /** Set when the row has a balance but no usable price feed. Never `valueUsd: 0`. */
  priceUnavailable?: true;
  /** Named cause when `balance` could not be derived. The row still stands. */
  unprojectableReason?: string;
  /** Lifted from `extensions.isRiskToken`. */
  isRiskToken?: boolean;
  /**
   * Provider labels for this identity, verbatim. Present only on a row whose
   * identity came from an indexer that supplied them (Blockscout on chain
   * 4663). They are LABELS: they are reported to the agent and never used to
   * hide, reorder, or discount a row.
   */
  providerFlags?: { reputation: string | null };
}

/**
 * Concise Khalani chain row. KEEPS chain identity (`id`/`name`/`type`) and the
 * native-coin facts an agent needs to reason about amounts (`nativeSymbol`/
 * `nativeDecimals`, lifted from `nativeCurrency`). DROPS `rpcUrls`,
 * `blockExplorers`, and other heavy provider metadata — those are resolved
 * internally from the cached registry, not from this output.
 */
export interface ConciseKhalaniChain {
  id: number;
  name: string;
  type: ChainFamily;
  nativeSymbol: string | null;
  nativeDecimals: number | null;
}

/**
 * Concise Khalani quote-route row.
 *
 * KEEPS the route identity/pricing/ETA an agent picks a route with, PLUS the
 * quote's own DEADLINE. The deadline used to be dropped even though
 * `handlers/bridge-execute.ts` hard-fails (`deadline_expired`) on exactly it
 * — so `khalani.quote.get` told the agent nothing about how long its quote
 * was good for. Both raw provider timestamps are surfaced alongside the
 * single EFFECTIVE deadline the executor enforces, so the agent never has to
 * re-derive the precedence rule (see {@link khalaniRouteExpiryUnixSeconds}).
 * DROPS `icon`, `exactOutMethod`, `depositMethods`/`supportedDepositMethods`
 * (deposit-method selection is an execute-time concern, not a route choice).
 */
export interface ConciseKhalaniQuoteRoute {
  routeId: string;
  type: string;
  amountIn: string;
  amountOut: string;
  etaSeconds: number;
  /**
   * The deadline `khalani.bridge` actually enforces, unix SECONDS.
   * `null` means the provider set none (both timestamps absent or 0) — the
   * executor skips the freshness check in exactly that case.
   */
  expiresAtUnixSeconds: number | null;
  /** Seconds left on {@link expiresAtUnixSeconds} at projection time; `0` when already expired, `null` when no deadline was set. */
  expiresInSeconds: number | null;
  /** Raw provider `quote.validBefore`, unix seconds (the fallback deadline). */
  validBeforeUnixSeconds: number;
  /** Raw provider `quote.quoteExpiresAt`, unix seconds; takes precedence over `validBefore` when present. `null` when the provider omitted it. */
  quoteExpiresAtUnixSeconds: number | null;
  /** Provider gas estimate for the deposit leg, raw provider string (units are the provider's own, unlabeled — not a USD figure). `null` when absent. */
  estimatedGas: string | null;
  tags: string[] | null;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Narrow an `unknown` to a plain record so optional nested reads are type-safe. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The ONE owner of Khalani's quote-freshness rule: `quoteExpiresAt` when the
 * provider sent one, else `validBefore`; a non-positive/absent value means no
 * deadline is enforced (`null`).
 *
 * `handlers/bridge-execute.ts` (the hard `deadline_expired` gate) and the
 * `khalani.quote.get` / dryRun previews all read it through here, so the
 * deadline an agent is SHOWN can never drift from the deadline that is
 * ENFORCED. Values are untrusted provider numbers — non-finite is treated as
 * "no deadline", never as `NaN` arithmetic.
 */
export function khalaniRouteExpiryUnixSeconds(route: QuoteRoute): number | null {
  const raw = route.quote.quoteExpiresAt ?? route.quote.validBefore;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

// ── Projectors ───────────────────────────────────────────────────

/**
 * Project a raw `KhalaniToken` to a concise, decision-relevant row.
 *
 * KEEP: symbol, name, address, chainId, decimals.
 * LIFT (from the open `extensions` bag, only when present and well-typed):
 *   `extensions.price.usd` → `priceUsd`, `extensions.balance` → `balance`,
 *   `extensions.isRiskToken` → `isRiskToken`.
 * DROP: `logoURI` and the rest of the open `extensions` passthrough bag.
 *
 * Optional signals are omitted (not set to `null`) when absent so a token with no
 * price/balance/risk data stays a clean identity row.
 */
export function projectToken(t: KhalaniToken): ConciseKhalaniToken {
  const out: ConciseKhalaniToken = {
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    chainId: t.chainId,
    decimals: t.decimals,
  };

  // `extensions` is an open bag from an external API — narrow every read.
  const ext: unknown = t.extensions;
  if (isRecord(ext)) {
    const price: unknown = ext.price;
    const priceUsd = isRecord(price) && typeof price.usd === "string" ? price.usd : null;
    if (typeof ext.balance === "string") {
      // A balance row. The model never divides: the human amount and the USD
      // estimate are derived HERE, by the single conversion owner.
      out.balanceRaw = ext.balance;
      out.priceUsd = priceUsd;
      const projected = projectBalanceRow(ext.balance, t.decimals, priceUsd);
      out.balance = projected.balance;
      out.valueUsd = projected.valueUsd;
      if (projected.priceUnavailable) out.priceUnavailable = true;
      if (projected.unprojectableReason) out.unprojectableReason = projected.unprojectableReason;
    } else if (priceUsd !== null) {
      // Identity row: a price is still useful, a balance quartet is not.
      out.priceUsd = priceUsd;
    }
    if (typeof ext.isRiskToken === "boolean") {
      out.isRiskToken = ext.isRiskToken;
    }
  }

  return out;
}

/** Project an array of raw tokens defensively (tolerates a non-array input). */
export function projectTokens(
  tokens: readonly KhalaniToken[] | null | undefined,
): ConciseKhalaniToken[] {
  return (Array.isArray(tokens) ? tokens : []).map(projectToken);
}

/**
 * Project a raw `KhalaniChain` to a concise identity + native-coin row.
 *
 * KEEP: id, name, type, and the native-coin symbol/decimals lifted from
 * `nativeCurrency`. DROP: `rpcUrls`, `blockExplorers` (internal resolvers read
 * these from the cached registry, not from output).
 *
 * `nativeSymbol`/`nativeDecimals` normalise to `null` when `nativeCurrency` is
 * absent or malformed, so a missing native block stays explicit rather than
 * silently absent.
 */
export function projectChain(c: KhalaniChain): ConciseKhalaniChain {
  const native: unknown = c.nativeCurrency;
  const nativeSymbol = isRecord(native) && typeof native.symbol === "string" ? native.symbol : null;
  const nativeDecimals = isRecord(native) && typeof native.decimals === "number" ? native.decimals : null;
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    nativeSymbol,
    nativeDecimals,
  };
}

/**
 * Project a raw `QuoteRoute` to a concise row that carries its own deadline.
 *
 * `nowMs` is injected (never read from the clock here) so the projection
 * stays pure and the countdown is deterministic under test; callers pass
 * `Date.now()` at the moment they build the output.
 */
export function projectQuoteRoute(route: QuoteRoute, nowMs: number): ConciseKhalaniQuoteRoute {
  const expiresAtUnixSeconds = khalaniRouteExpiryUnixSeconds(route);
  return {
    routeId: route.routeId,
    type: route.type,
    amountIn: route.quote.amountIn,
    amountOut: route.quote.amountOut,
    etaSeconds: route.quote.expectedDurationSeconds,
    expiresAtUnixSeconds,
    expiresInSeconds: expiresAtUnixSeconds === null
      ? null
      : Math.max(0, Math.floor(expiresAtUnixSeconds - nowMs / 1000)),
    validBeforeUnixSeconds: route.quote.validBefore,
    quoteExpiresAtUnixSeconds: route.quote.quoteExpiresAt ?? null,
    estimatedGas: route.quote.estimatedGas ?? null,
    tags: route.quote.tags ?? null,
  };
}

/** Project an array of raw quote routes defensively (tolerates a non-array input). */
export function projectQuoteRoutes(
  routes: readonly QuoteRoute[] | null | undefined,
  nowMs: number,
): ConciseKhalaniQuoteRoute[] {
  return (Array.isArray(routes) ? routes : []).map((route) => projectQuoteRoute(route, nowMs));
}

/** Project an array of raw chains defensively (tolerates a non-array input). */
export function projectChains(
  chains: readonly KhalaniChain[] | null | undefined,
): ConciseKhalaniChain[] {
  return (Array.isArray(chains) ? chains : []).map(projectChain);
}
