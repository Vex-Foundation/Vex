/**
 * Prequote registries + freshness window (Stage 6c/7/8c).
 *
 * The quote-tool registry (`PREQUOTE_QUOTE_TOOLS`) names which quote tools record
 * a prequote on success and how; the execute-gate registry (`EXECUTE_GATE_TOOLS`)
 * names which execute tools are subject to the quote-before-transaction gate and
 * which prequote `kind` each must match. `PREQUOTE_MAX_AGE_MS` is the shared
 * freshness window. Pure data + types — no IO.
 */

import type { PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

// ── Quote-tool registry ──────────────────────────────────────────────────

/**
 * Quote tools that record a prequote on success. The two swap quotes record
 * `kind: "swap"` (Stage 6c); the Khalani bridge quote records `kind: "bridge"`
 * (Stage 8c). A `swap` entry pins its family up front; the `bridge` entry
 * derives the source family per-call from `fromChain` (the source leg can be EVM
 * or Solana), so its `family` is resolved inside the recorder, not here.
 *
 * `khalani.quote.get` is the BRIDGE quote (cross-chain), and is used ONLY for
 * bridges (the read alias `bridge_quote` is its only other caller) — recording
 * it as `kind: "bridge"` never mis-records a non-bridge quote.
 */
type PrequoteQuoteRegistration =
  | { readonly kind: "swap"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "bridge"; readonly provider: string }
  // Pendle's single quote tool records EITHER a `swap` prequote (buy / early-exit
  // sell) OR a `redeem` prequote — decided at record-time from the Convert
  // `action` (Wave 5). The recorder dispatches on this `pendle` label, then
  // writes the appropriate DB kind. `family` is always eip155 (Ethereum v1).
  | { readonly kind: "pendle"; readonly family: PrequoteFamily; readonly provider: string }
  // Pendle's PY quote records EITHER a `mint` prequote (direction "mint") OR a
  // `redeem_py` prequote (direction "redeem"), decided from the echoed
  // `direction` (P4). Each writes its dedicated DB kind + identity.
  | { readonly kind: "pendle-py"; readonly family: PrequoteFamily; readonly provider: string }
  // Pendle's LP quote records EITHER an `lp_add` prequote (direction "add") OR an
  // `lp_remove` prequote (direction "remove"), decided from the echoed
  // `direction` (P5). Each writes its dedicated DB kind + identity.
  | { readonly kind: "pendle-lp"; readonly family: PrequoteFamily; readonly provider: string };

export const PREQUOTE_QUOTE_TOOLS: Record<string, PrequoteQuoteRegistration> = {
  "kyberswap.swap.quote": { kind: "swap", family: "eip155", provider: "kyberswap" },
  "uniswap.swap.quote": { kind: "swap", family: "eip155", provider: "uniswap" },
  "solana.swap.quote": { kind: "swap", family: "solana", provider: "jupiter" },
  "khalani.quote.get": { kind: "bridge", provider: "khalani" },
  "relay.quote.get": { kind: "bridge", provider: "relay" },
  "pendle.pt.quote": { kind: "pendle", family: "eip155", provider: "pendle" },
  // YT is ALWAYS a swap (never redeem-py); the pendle recorder records it via the
  // swap identity, so a YT quote authorizes only the matching YT buy/sell execute.
  "pendle.yt.quote": { kind: "pendle", family: "eip155", provider: "pendle" },
  // PY quote records a `mint` or `redeem_py` prequote (P4) — decided from the
  // echoed `direction`.
  "pendle.py.quote": { kind: "pendle-py", family: "eip155", provider: "pendle" },
  // LP quote records an `lp_add` or `lp_remove` prequote (P5) — decided from the
  // echoed `direction`.
  "pendle.lp.quote": { kind: "pendle-lp", family: "eip155", provider: "pendle" },
};

/**
 * Prequote freshness window. Honeypot / audit status is stable minute-to-minute,
 * but a restricted-mode approval pause can sit for minutes before the execute
 * call lands, so the window must comfortably outlive a human approval without
 * letting a stale safety preview authorize an execute indefinitely. Tunable.
 */
export const PREQUOTE_MAX_AGE_MS = 15 * 60_000;

// ── Execute-gate registry ─────────────────────────────────────────────────

/**
 * EXECUTE tools subject to the prequote gate, keyed by toolId. Each entry names
 * the prequote `kind` it must match (Stage 8c made this kind-aware): the three
 * swap executes match a fresh `swap` prequote; the Khalani bridge execute
 * matches a fresh `bridge` prequote. A swap entry pins its `family` (used to
 * resolve the signer + branch the identity builder); the bridge entry derives
 * its families per-call inside `buildBridgeIdentity`. `send` and every other tool
 * pass through untouched.
 */
export type ExecuteGateRegistration =
  | { readonly kind: "swap"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "bridge"; readonly provider: string }
  // Pendle PT redeem — its OWN kind, matched against a `redeem` prequote via the
  // dedicated redeem identity (Wave 5, G2#3). `family` is always eip155.
  | { readonly kind: "redeem"; readonly family: PrequoteFamily; readonly provider: string }
  // Pendle PY mint / pre-expiry redeem — their OWN kinds, matched against a
  // `mint` / `redeem_py` prequote via the dedicated PY identities (P4).
  | { readonly kind: "mint"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "redeem_py"; readonly family: PrequoteFamily; readonly provider: string }
  // Pendle LP single-token add / remove — their OWN kinds, matched against an
  // `lp_add` / `lp_remove` prequote via the dedicated LP identities (P5).
  | { readonly kind: "lp_add"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "lp_remove"; readonly family: PrequoteFamily; readonly provider: string };

export const EXECUTE_GATE_TOOLS: Record<string, ExecuteGateRegistration> = {
  // Agent Scan (plan §11.2): the buy/sell lot-direction split is gone (no PnL
  // lot tracking survives) — ONE execute toolId per venue. `provider` still
  // binds the venue-specific identity, so a kyberswap prequote can never
  // authorize a uniswap execute and vice versa (identity/hash.ts unchanged).
  "kyberswap.swap.execute": { kind: "swap", family: "eip155", provider: "kyberswap" },
  "uniswap.swap.execute": { kind: "swap", family: "eip155", provider: "uniswap" },
  "solana.swap.execute": { kind: "swap", family: "solana", provider: "jupiter" },
  "khalani.bridge": { kind: "bridge", provider: "khalani" },
  "relay.bridge": { kind: "bridge", provider: "relay" },
  // Pendle PT buy / early-exit sell match a fresh `swap` prequote (provider
  // "pendle"); redeem matches a fresh `redeem` prequote (dedicated identity).
  "pendle.pt.buy": { kind: "swap", family: "eip155", provider: "pendle" },
  "pendle.pt.sell": { kind: "swap", family: "eip155", provider: "pendle" },
  "pendle.pt.redeem": { kind: "redeem", family: "eip155", provider: "pendle" },
  // Pendle YT buy / early-exit sell match a fresh `swap` prequote (the token legs
  // are addresses — chain-scoped, collision-safe). `pendle.claim` is an income
  // sweep with NOTHING quoted, so it has NO prequote entry (approval-gated only).
  "pendle.yt.buy": { kind: "swap", family: "eip155", provider: "pendle" },
  "pendle.yt.sell": { kind: "swap", family: "eip155", provider: "pendle" },
  // Pendle PY mint / pre-expiry redeem match their dedicated `mint` / `redeem_py`
  // prequotes (P4).
  "pendle.py.mint": { kind: "mint", family: "eip155", provider: "pendle" },
  "pendle.py.redeem": { kind: "redeem_py", family: "eip155", provider: "pendle" },
  // Pendle LP single-token add / remove match their dedicated `lp_add` /
  // `lp_remove` prequotes (P5).
  "pendle.lp.add": { kind: "lp_add", family: "eip155", provider: "pendle" },
  "pendle.lp.remove": { kind: "lp_remove", family: "eip155", provider: "pendle" },
};
