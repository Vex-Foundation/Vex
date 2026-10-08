/**
 * The AUDITED parallel-safe read allowlist (Kairos Phase 5, T-1 + T-3).
 *
 * A tool on this list may run CONCURRENTLY with its allowlisted neighbours in
 * one model batch (`engine/core/turn-loop-tool-batch/read-segment.ts`), and
 * its dispatch is bounded by a read timeout (`dispatcher.ts`). Every other
 * tool, including every tool added later, is a SERIAL barrier and is never
 * wrapped in a timeout: absence from this file is the safe default.
 *
 * `actionKind === "read"` is REQUIRED but not sufficient. Each entry was
 * audited for:
 *  - shared state: nothing it touches can change what another call in the
 *    same batch sees (ToolSearch changes the callable set, quotes write the
 *    quote authority a later execute binds to, memory / plan / board /
 *    mission tools change session state - all excluded);
 *  - human or engine hand-offs: it never returns an approval, a user form, a
 *    Lighter setup hand-off, an engine signal or a prepared-action follow-up;
 *  - privacy: running it concurrently sends nothing it would not send
 *    serially, to nobody it would not send it to serially;
 *  - provider rate limits: every entry names the upstream it shares, and
 *    `READ_PROVIDER_CONCURRENCY_CAPS` bounds how many calls to that upstream
 *    one batch keeps in flight, on top of any client-side throttle.
 *
 * Adding an entry is a reviewed change: write the one-line justification, and
 * `parallel-safe-reads.test.ts` checks the entry is a registered read with no
 * quote-authority or follow-up role.
 */

import { getActionKind } from "./registry.js";
import { resolveToolName } from "./registry/name-resolution.js";
import { resolveInjectedProtocolTool } from "./registry/injected-protocol-tools.js";

/**
 * The upstream an allowlisted read shares with its siblings. `local` is pure
 * in-process computation and has no cap beyond the batch limit.
 */
export type ReadProvider =
  | "local"
  | "local_db"
  | "dexscreener"
  | "tavily"
  | "twitter"
  | "evm_rpc"
  | "wallet_scan"
  | "khalani"
  | "kyberswap"
  | "jupiter"
  | "morpho";

/** Which read timeout bounds the call (`AGENT_TOOL_READ_*_TIMEOUT_MS`). */
export type ReadTimeoutClass = "standard" | "extended";

export interface ParallelSafeRead {
  readonly provider: ReadProvider;
  readonly timeoutClass: ReadTimeoutClass;
  /** The audit, in one line. */
  readonly why: string;
}

/**
 * Most calls to one upstream a batch keeps in flight at once. The batch-wide
 * `AGENT_TOOL_READ_CONCURRENCY` still applies on top.
 */
export const READ_PROVIDER_CONCURRENCY_CAPS: Readonly<Record<ReadProvider, number>> = {
  // Pure computation, bounded only by the batch limit.
  local: Number.POSITIVE_INFINITY,
  // Selects on the main pool; two leaves the pool for everything else.
  local_db: 2,
  // The client-side throttle (`src/tools/dexscreener/throttle.ts`) is a
  // concurrency-safe token bucket with in-flight dedupe; it keeps the budget.
  dexscreener: 3,
  tavily: 2,
  // Unofficial client with an undocumented budget: never two at once.
  twitter: 1,
  evm_rpc: 2,
  // WalletBalances already fans out across chains internally.
  wallet_scan: 1,
  khalani: 2,
  kyberswap: 2,
  // The keyed Jupiter tier is rate limited per second: never two at once.
  jupiter: 1,
  morpho: 2,
};

/** Internal tools, by canonical registered name. */
export const PARALLEL_SAFE_INTERNAL_READS: Readonly<Record<string, ParallelSafeRead>> = {
  UnitsConvert: {
    provider: "local",
    timeoutClass: "standard",
    why: "Pure decimal arithmetic: no I/O, no state.",
  },
  WebResearch: {
    provider: "tavily",
    timeoutClass: "extended",
    why: "Search/fetch GET; its only write is an idempotent ON CONFLICT cache upsert keyed by query/url.",
  },
  TwitterAccount: {
    provider: "twitter",
    timeoutClass: "standard",
    why: "Public profile/tweet read; no local state; capped at one in flight.",
  },
  TokenFind: {
    provider: "khalani",
    timeoutClass: "standard",
    why: "Token search over khalani.tokens.search, DexScreener resolve and ERC-20 metadata reads; no writes.",
  },
  TokenCheck: {
    provider: "kyberswap",
    timeoutClass: "standard",
    why: "Routes to kyberswap.tokens.check, a stateless honeypot/FoT GET; records no quote.",
  },
  ChainRead: {
    provider: "evm_rpc",
    timeoutClass: "standard",
    why: "eth_call / receipt / balance RPC reads; no writes, no signer.",
  },
  WalletBalances: {
    provider: "wallet_scan",
    timeoutClass: "extended",
    why: "Balance read of the selected wallet (tracked-token SELECT + RPC/Khalani GETs); no writes, no signer.",
  },
  AgentScan: {
    provider: "local_db",
    timeoutClass: "standard",
    why: "SELECTs over local portfolio/activity projections; no writes, no network.",
  },
};

const DEX_WHY = "DexScreener public GET behind the shared throttle; handler has no DB access or session state.";

/** Protocol tools, by immutable dotted toolId. */
export const PARALLEL_SAFE_PROTOCOL_READS: Readonly<Record<string, ParallelSafeRead>> = {
  "dexscreener.search": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.pair.get": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.pairs.batch": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.tokenPairs": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.spotlight": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.pair.details": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.candles": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.trades": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.top.traders": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.pairs.trending": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.pairs.top": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.gainers": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.losers": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.pairs.new": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.launchpad.pairs": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.chains": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.tokens.screen": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "dexscreener.trending": { provider: "dexscreener", timeoutClass: "standard", why: DEX_WHY },
  "khalani.chains.list": {
    provider: "khalani",
    timeoutClass: "standard",
    why: "Public chain catalog GET; no wallet, no writes.",
  },
  "khalani.tokens.search": {
    provider: "khalani",
    timeoutClass: "standard",
    why: "Public token search GET; no wallet, no writes.",
  },
  "khalani.tokens.top": {
    provider: "khalani",
    timeoutClass: "standard",
    why: "Public top-token list GET; no wallet, no writes.",
  },
  "khalani.tokens.autocomplete": {
    provider: "khalani",
    timeoutClass: "standard",
    why: "Public token autocomplete GET; no wallet, no writes.",
  },
  "kyberswap.chains": {
    provider: "kyberswap",
    timeoutClass: "standard",
    why: "Supported-chain list read (KyberSwap common API); no wallet, no writes.",
  },
  "kyberswap.tokens.check": {
    provider: "kyberswap",
    timeoutClass: "standard",
    why: "Stateless honeypot/fee-on-transfer GET; records no quote.",
  },
  "solana.prices": {
    provider: "jupiter",
    timeoutClass: "standard",
    why: "Jupiter price GET; no wallet, no writes; capped at one in flight.",
  },
  "solana.tokens.search": {
    provider: "jupiter",
    timeoutClass: "standard",
    why: "Jupiter token search GET; no wallet, no writes; capped at one in flight.",
  },
  "solana.tokens.trending": {
    provider: "jupiter",
    timeoutClass: "standard",
    why: "Jupiter trending-token GET; no wallet, no writes; capped at one in flight.",
  },
  "morpho.markets.discover": {
    provider: "morpho",
    timeoutClass: "standard",
    why: "Public Morpho GraphQL market query; no wallet, no writes.",
  },
  "morpho.market.get": {
    provider: "morpho",
    timeoutClass: "standard",
    why: "Public Morpho GraphQL market detail; no wallet, no writes.",
  },
  "morpho.vaults.discover": {
    provider: "morpho",
    timeoutClass: "standard",
    why: "Public Morpho GraphQL vault query; no wallet, no writes.",
  },
  "morpho.vault.get": {
    provider: "morpho",
    timeoutClass: "standard",
    why: "Public Morpho GraphQL vault detail; no wallet, no writes.",
  },
};

/**
 * Deliberate exclusions, kept next to the allowlist so a reviewer sees why a
 * tempting read stays serial. Not load-bearing: anything absent from the
 * allowlist is serial whether or not it is named here.
 */
export const PARALLEL_READ_EXCLUSIONS: Readonly<Record<string, string>> = {
  ToolSearch: "Changes the session's discovered (callable) tool set that later calls are admitted against.",
  SwapQuote: "Records swap quote authority that a later SwapExecute binds to; order must stay deterministic.",
  SwapQuoteUniswap: "Records Uniswap quote authority that a later execute binds to.",
  BridgeQuote: "Records bridge quote authority that a later bridge execute binds to.",
  BridgeQuoteRelay: "Records Relay quote authority that a later execute binds to.",
  BridgeStatus: "Bridge status polling feeds in-flight bridge reconciliation; kept serial.",
  "protocol quote tools": "Every PREQUOTE_QUOTE_TOOLS entry records quote authority (e.g. kyberswap.swap.quote, khalani.quote.get).",
  MemorySearch: "Memory tools are excluded by the Phase 5 contract (session/long-memory state).",
  MemoryGet: "Memory tools are excluded by the Phase 5 contract.",
  MemoryHistory: "Memory tools are excluded by the Phase 5 contract.",
  SessionMemorySearch: "Memory tools are excluded by the Phase 5 contract.",
  lighter_rhc_onboarding_status: "May return a Lighter setup hand-off that parks the turn on a human.",
  lighter_core_onboarding_status: "May return a Lighter setup hand-off that parks the turn on a human.",
  "lighter.*": "Shares the Lighter signer/auth client and nonce recovery; kept serial.",
  "khalani.tokens.balances": "Wallet-scoped balance read; WalletBalances already covers it with its own cap.",
  "pools.*, pendle.*, virtuals.*, solana.predict.*, solana.lend.*": "Not audited in Phase 5; serial by default.",
};

export interface ResolvedParallelSafeRead extends ParallelSafeRead {
  /** The allowlist key the call resolved to (canonical name or toolId). */
  readonly identity: string;
}

/**
 * The allowlist entry for a model-emitted tool name, or `null` (serial).
 *
 * Resolves the name exactly as the dispatcher does (deprecation alias first,
 * then the injected protocol lane) and re-checks the registered action kind,
 * so a manifest that is ever reclassified away from `read` drops out of the
 * parallel lane without anyone editing this file.
 */
export function resolveParallelSafeRead(name: string): ResolvedParallelSafeRead | null {
  const canonical = resolveToolName(name);
  const internal = PARALLEL_SAFE_INTERNAL_READS[canonical];
  if (internal !== undefined && Object.hasOwn(PARALLEL_SAFE_INTERNAL_READS, canonical)) {
    return getActionKind(canonical) === "read" ? { ...internal, identity: canonical } : null;
  }
  const manifest = resolveInjectedProtocolTool(name);
  if (manifest === undefined) return null;
  if (!Object.hasOwn(PARALLEL_SAFE_PROTOCOL_READS, manifest.toolId)) return null;
  const entry = PARALLEL_SAFE_PROTOCOL_READS[manifest.toolId];
  if (entry === undefined || manifest.actionKind !== "read" || manifest.mutating) return null;
  return { ...entry, identity: manifest.toolId };
}
