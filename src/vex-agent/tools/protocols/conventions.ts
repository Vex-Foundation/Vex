/**
 * THE PARAM CONVENTION — one vocabulary for every agent-facing tool surface.
 *
 * This module is the single home for the cross-cutting naming/format rules the
 * tool audit (`agents_dm/tool-audit-2026-08/SPEC.md` §1) settled on: which
 * chain slugs exist, which param keys are canonical, which spellings are banned
 * and what replaces them, and the shared description sentences that must not be
 * retyped per manifest.
 *
 * NOTHING consumes it yet. It is landed ahead of the migration waves so the
 * manifest linter (`_manifest-lint.ts`) can measure today's distance from the
 * convention, and so each later wave edits ONE table instead of hunting copies.
 *
 * Deliberate non-goals: no runtime validation lives here (the boundary owner is
 * `runtime/params.ts`), and no provider translation lives here (a provider that
 * needs a numeric id, an UPPERCASE enum, or a slug in a URL path converts inside
 * its own adapter — the manifest always advertises the canonical spelling).
 */

import { getKyberChains } from "@tools/kyberswap/chains.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { VEX_MAX_SLIPPAGE_BPS, VEX_DEFAULT_SLIPPAGE_BPS } from "./slippage-policy.js";

// ── Chains ───────────────────────────────────────────────────────

/**
 * The Solana family discriminator. Solana has no EVM chain id and is not in any
 * EVM registry, but `chain: "solana"` is how every router in the tree selects
 * the Solana lane, so it is a canonical chain VALUE even though it is not an
 * EVM chain.
 */
const SOLANA_FAMILY_SLUG = "solana";

/**
 * Canonical agent-facing chain value.
 *
 * Derived, never hand-listed: the KyberSwap registry (`src/tools/kyberswap/chains.ts`)
 * is the broadest slug table in the tree and already carries every chain the
 * local registry covers (Robinhood 4663). A chain that exists ONLY in
 * `src/tools/evm-chains/registry.ts` would therefore be missing here — the
 * manifest-lint suite asserts that coverage so the gap fails a test instead of
 * silently narrowing what an agent may say.
 */
export type CanonicalChainSlug = KyberChainSlug | typeof SOLANA_FAMILY_SLUG;

/** Runtime membership test for {@link CanonicalChainSlug}. */
export const CANONICAL_CHAIN_SLUGS: ReadonlySet<string> = new Set<string>([
  ...getKyberChains().map((chain) => chain.slug),
  SOLANA_FAMILY_SLUG,
]);

// ── Param keys ───────────────────────────────────────────────────

/**
 * Every param key the convention permits, with the reason it exists. Adding a
 * key is a deliberate edit HERE, not an accident in a manifest — the linter
 * reports any other key against the tool that introduced it.
 */
export const CANONICAL_PARAM_KEYS: ReadonlyMap<string, string> = new Map([
  ["chain", "the single-chain selector; slug or decimal chain-id string"],
  ["fromChain", "bridge source chain; pairs with fromToken"],
  ["toChain", "bridge destination chain; pairs with toToken"],
  ["chainIds", "a LIST of chains (comma-separated string, or string[] where declared)"],
  ["walletFamily", "wallet FAMILY (eip155|solana|all) — never a chain"],
  ["tokenIn", "swap input token: EVM contract address or ETH/native; Solana symbol or mint"],
  ["tokenOut", "swap output token, same grammar as tokenIn"],
  ["fromToken", "bridge source token; pairs with fromChain"],
  ["toToken", "bridge destination token; pairs with toChain"],
  ["token", "the one token a single-token tool acts on"],
  ["tokenAddress", "a token CONTRACT address on a read tool"],
  ["tokenAddresses", "a list of token contract addresses"],
  ["walletAddress", "an ACCOUNT address (the thing that holds funds)"],
  ["amountIn", "input amount in HUMAN decimal units, as a string"],
  ["amountOut", "output amount in HUMAN decimal units, as a string"],
  ["amountRaw", "amount in RAW base units; description must name the decimals source"],
  ["depositAmountRaw", "multi-leg lend deposit, raw base units"],
  ["withdrawAmountRaw", "multi-leg lend withdrawal, raw base units"],
  ["borrowAmountRaw", "multi-leg lend borrow, raw base units"],
  ["repayAmountRaw", "multi-leg lend repayment, raw base units"],
  ["slippageBps", "price protection in basis points; type number, unit bps"],
  [
    "minSellPriceSlippageBps",
    "solana.predict.closeAll's distinct tolerance — a separate knob by necessity, documented in slippage-policy.ts",
  ],
  ["limit", "result cap; description states the default and the maximum"],
  ["page", "1-based FIRST provider page of a windowed read; the reply names the next page to continue from"],
  ["pageSize", "rows fetched per provider page; distinct from `limit`, which caps what is RETURNED after filtering"],
  ["environment", "explicit public service environment selector, such as Lighter core vs rhc"],
  ["marketId", "protocol-native market identifier returned by a market catalog read"],
  ["marketSymbol", "protocol-native market symbol used to resolve a market id"],
  ["accountIndex", "protocol-native L2 account index (a public integer identity, not an address)"],
  ["apiKeyIndex", "protocol-native API-key slot index on an exchange account; public metadata, never key material"],
  ["activeOnly", "boolean account-lookup flag: return only active sub-accounts"],
  ["side", "orderbook order side, buy or sell, declared with an enum"],
  ["price", "human-decimal order price string; market orders read it as the worst acceptable price"],
  ["baseAmountIn", "orderbook order size in the BASE asset, human decimal string"],
  ["orderType", "orderbook order type declared with an enum, such as limit or market"],
  ["timeInForce", "orderbook time-in-force declared with an enum"],
  ["reduceOnly", "perp order flag: execute only if it reduces the current position"],
  ["orderExpiry", "absolute order expiry in epoch milliseconds; the relative twin is orderExpiryOffsetMinutes"],
  ["previewId", "persisted preview identifier returned by a preview tool; binds a prepare call to that exact preview"],
  ["intentId", "prepared execution-intent identifier returned by its prepare tool; binds the approved execute call"],
  ["filter", "closed provider-side category/status filter declared with an enum"],
  ["resolution", "candle or chart bucket size declared with an enum"],
  ["startTimestamp", "epoch-millisecond start bound for time-series reads"],
  ["endTimestamp", "epoch-millisecond end bound for time-series reads"],
  ["countBack", "provider row cap for time-series reads"],
  ["setTimestampToEnd", "candle timestamp placement flag for time-series providers that expose it"],
  ["orderExpiryOffsetMinutes", "relative order expiry in whole minutes from preview time"],
  ["dryRun", "preview switch, reserved by runtime/params.ts"],
  [
    "imageId",
    "opaque id of an image already in the user's locker; the agent can never create one, only name one a read tool listed",
  ],
]);

/**
 * Spellings that must never appear again, each naming its replacement. The
 * linter puts the replacement IN the failure message: a rejection that does not
 * say what to write instead costs the agent another call.
 */
export const BANNED_PARAM_KEYS: ReadonlyMap<string, string> = new Map([
  ["amount", "use `amountIn` (human decimals) or `amountRaw` (base units) — the bare key meant both, 10^6 apart"],
  ["inputToken", "use `tokenIn`"],
  ["outputToken", "use `tokenOut`"],
  ["chainId", "use `chain` — the key said Id while the value was a slug"],
  ["chains", "use `chainIds`"],
  ["address", "use `tokenAddress` (a contract) or `walletAddress` (an account) — the bare key meant both"],
  ["network", "use `walletFamily` — it selects a wallet family, not a chain"],
  ["wallet", "use `walletFamily`"],
]);

/**
 * Param keys that carry a chain VALUE and therefore need the chain sentence.
 *
 * Also the allowlist for the two normalizations `runtime/params.ts` performs —
 * a JSON number becomes its decimal string, and a declared `enum` matches
 * case-insensitively — because a chain value is the one thing in this
 * vocabulary whose spelling carries no meaning of its own.
 */
export const CHAIN_VALUE_PARAM_KEYS: readonly string[] = ["chain", "fromChain", "toChain"];

// ── Shared description text ──────────────────────────────────────

/**
 * The one sentence every chain-valued param ends with. Both spellings are real:
 * `token_find` hands the agent a NUMERIC chain id, and every resolver in the
 * tree accepts it alongside the slug.
 */
export const CANONICAL_CHAIN_SENTENCE =
  "Chain slug/alias, or the numeric chain id `token_find` returns (e.g. `base` or `8453`).";

/**
 * The one sentence a RAW-amount param ends with. Rule 90: a raw amount must
 * travel with the decimals needed to read it, and the agent must be told where
 * to get them rather than guessing 18.
 */
export const CANONICAL_RAW_AMOUNT_SENTENCE =
  "Raw base units as an integer string (not human decimals) — read the token's decimals from `token_find` first.";

/** The one sentence a HUMAN-amount param ends with. */
export const CANONICAL_HUMAN_AMOUNT_SENTENCE =
  "In HUMAN decimal units (e.g. \"1.5\") — not wei, lamports, or any other base unit.";

/**
 * The shared slippage paragraph, hoisted from six near-verbatim copies.
 *
 * Both numbers are INTERPOLATED from `slippage-policy.ts` rather than written
 * out, so the prose cannot drift from the enforced policy when the default
 * moves.
 */
export const CANONICAL_SLIPPAGE_PARAGRAPH =
  `Basis points (1 bps = 0.01%). Default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%. `
  + `Vex caps this at ${VEX_MAX_SLIPPAGE_BPS} (${VEX_MAX_SLIPPAGE_BPS / 100}%) and REJECTS a higher value rather than clamping it.`;
