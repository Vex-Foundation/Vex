/**
 * Prequote registries + freshness window (Stage 6c/7/8c).
 *
 * The quote-tool registry (`PREQUOTE_QUOTE_TOOLS`) names which quote tools record
 * a prequote on success and how; the execute-gate registry (`EXECUTE_GATE_TOOLS`)
 * names which execute tools are subject to the quote-before-transaction gate and
 * which prequote `kind` each must match. `PREQUOTE_MAX_AGE_MS` is the shared
 * freshness window. Pure data + types - no IO.
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
 * bridges (the read alias `BridgeQuote` is its only other caller) - recording
 * it as `kind: "bridge"` never mis-records a non-bridge quote.
 */
type PrequoteQuoteRegistration =
  | { readonly kind: "swap"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "bridge"; readonly provider: string }
  // Pendle's single quote tool records EITHER a `swap` prequote (buy / early-exit
  // sell) OR a `redeem` prequote - decided at record-time from the Convert
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
  | { readonly kind: "pendle-lp"; readonly family: PrequoteFamily; readonly provider: string }
  // Morpho's single vault quote records EITHER a `lend_deposit` prequote OR a
  // `lend_withdraw` one (E3b-2, migration 080), decided at record-time from the
  // direction the quote itself reports. `family` is always eip155.
  | { readonly kind: "morpho-lend"; readonly family: PrequoteFamily; readonly provider: string }
  // Morpho's single MARKET quote records ONE of the four borrow-lane prequotes
  // (E3c, migration 081), decided at record-time from the `direction` the quote
  // priced: supplyCollateral / withdrawCollateral / borrow / repay map one-to-one
  // onto lend_supply_collateral / lend_withdraw_collateral / lend_borrow /
  // lend_repay. `family` is always eip155.
  | { readonly kind: "morpho-borrow"; readonly family: PrequoteFamily; readonly provider: string };

export const PREQUOTE_QUOTE_TOOLS: Record<string, PrequoteQuoteRegistration> = {
  "kyberswap.swap.quote": { kind: "swap", family: "eip155", provider: "kyberswap" },
  "uniswap.swap.quote": { kind: "swap", family: "eip155", provider: "uniswap" },
  // Trench Express curve buy/sell - records a `swap` prequote (provider "trench")
  // so the match-hash binds tokenIn/tokenOut/amount/chain/provider; a curve
  // trade IS a swap, so NO new prequote kind and NO migration (Codex aha).
  "trench.trade_quote": { kind: "swap", family: "eip155", provider: "trench" },
  "solana.swap.quote": { kind: "swap", family: "solana", provider: "jupiter" },
  "khalani.quote.get": { kind: "bridge", provider: "khalani" },
  "relay.quote.get": { kind: "bridge", provider: "relay" },
  "pendle.pt.quote": { kind: "pendle", family: "eip155", provider: "pendle" },
  // YT is ALWAYS a swap (never redeem-py); the pendle recorder records it via the
  // swap identity, so a YT quote authorizes only the matching YT buy/sell execute.
  "pendle.yt.quote": { kind: "pendle", family: "eip155", provider: "pendle" },
  // PY quote records a `mint` or `redeem_py` prequote (P4) - decided from the
  // echoed `direction`.
  "pendle.py.quote": { kind: "pendle-py", family: "eip155", provider: "pendle" },
  // LP quote records an `lp_add` or `lp_remove` prequote (P5) - decided from the
  // echoed `direction`.
  "pendle.lp.quote": { kind: "pendle-lp", family: "eip155", provider: "pendle" },
  // Morpho vault quote records a `lend_deposit` or `lend_withdraw` prequote
  // (E3b-2) - decided from the direction the quote priced.
  "morpho.vault.quote": { kind: "morpho-lend", family: "eip155", provider: "morpho" },
  // Morpho market quote records ONE of the four borrow-lane prequotes (E3c) -
  // decided from the direction the quote priced. It is the ONLY recorder for all
  // four kinds, which is why a collateral quote can never reach a borrow gate:
  // the direction it priced is the kind it writes.
  "morpho.market.quote": { kind: "morpho-borrow", family: "eip155", provider: "morpho" },
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
  // Pendle PT redeem - its OWN kind, matched against a `redeem` prequote via the
  // dedicated redeem identity (Wave 5, G2#3). `family` is always eip155.
  | { readonly kind: "redeem"; readonly family: PrequoteFamily; readonly provider: string }
  // Pendle PY mint / pre-expiry redeem - their OWN kinds, matched against a
  // `mint` / `redeem_py` prequote via the dedicated PY identities (P4).
  | { readonly kind: "mint"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "redeem_py"; readonly family: PrequoteFamily; readonly provider: string }
  // Pendle LP single-token add / remove - their OWN kinds, matched against an
  // `lp_add` / `lp_remove` prequote via the dedicated LP identities (P5).
  | { readonly kind: "lp_add"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "lp_remove"; readonly family: PrequoteFamily; readonly provider: string }
  // Morpho vault supply / redeem - their OWN kinds, matched against a
  // `lend_deposit` / `lend_withdraw` prequote from `morpho.vault.quote` via the
  // dedicated lend identities (E3b-2). Distinct kinds make the direction
  // unmixable: a deposit quote cannot authorize a withdrawal execute.
  // ── THE LANE DISCRIMINATOR ────────────────────────────────────────────────
  //
  // These two kinds are shared by TWO different operations: a curated VAULT
  // deposit/redeem, and a Blue MARKET supply/withdraw of the loan asset.
  // Supplying a loan asset IS lending, so it reuses the kind rather than
  // minting a venue-shape-specific one that would fragment the agent's own
  // history. That makes the kind alone insufficient to build an identity, so
  // every registration under these two kinds MUST name its `lane`, and the same
  // discriminator travels on the match input into `computePrequoteMatchHash`.
  | {
    readonly kind: "lend_deposit";
    readonly lane: "vault" | "market";
    readonly family: PrequoteFamily;
    readonly provider: string;
  }
  | {
    readonly kind: "lend_withdraw";
    readonly lane: "vault" | "market";
    readonly family: PrequoteFamily;
    readonly provider: string;
  }
  // Morpho Blue market operations - their OWN kinds, one per operation, matched
  // against a `morpho.market.quote` of the SAME direction via the dedicated
  // borrow-lane identities (E3c, migration 081). Distinct kinds make the
  // operation unmixable: a collateral-supply quote cannot authorize a BORROW
  // execute, which would turn "put money in" into "take debt out".
  | { readonly kind: "lend_supply_collateral"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "lend_withdraw_collateral"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "lend_borrow"; readonly family: PrequoteFamily; readonly provider: string }
  | { readonly kind: "lend_repay"; readonly family: PrequoteFamily; readonly provider: string };

export const EXECUTE_GATE_TOOLS: Record<string, ExecuteGateRegistration> = {
  // Agent Scan (plan §11.2): the buy/sell lot-direction split is gone (no PnL
  // lot tracking survives) - ONE execute toolId per venue. `provider` still
  // binds the venue-specific identity, so a kyberswap prequote can never
  // authorize a uniswap execute and vice versa (identity/hash.ts unchanged).
  "kyberswap.swap.execute": { kind: "swap", family: "eip155", provider: "kyberswap" },
  "uniswap.swap.execute": { kind: "swap", family: "eip155", provider: "uniswap" },
  // Trench Express curve execute - matches a fresh `swap` prequote from
  // trench.trade_quote (provider "trench"); the local-chain 4663 identity is
  // resolved in `gate.ts` (buildEvmIdentity trench branch).
  "trench.trade_execute": { kind: "swap", family: "eip155", provider: "trench" },
  "solana.swap.execute": { kind: "swap", family: "solana", provider: "jupiter" },
  "khalani.bridge": { kind: "bridge", provider: "khalani" },
  "relay.bridge": { kind: "bridge", provider: "relay" },
  // Pendle PT buy / early-exit sell match a fresh `swap` prequote (provider
  // "pendle"); redeem matches a fresh `redeem` prequote (dedicated identity).
  "pendle.pt.buy": { kind: "swap", family: "eip155", provider: "pendle" },
  "pendle.pt.sell": { kind: "swap", family: "eip155", provider: "pendle" },
  "pendle.pt.redeem": { kind: "redeem", family: "eip155", provider: "pendle" },
  // Pendle YT buy / early-exit sell match a fresh `swap` prequote (the token legs
  // are addresses - chain-scoped, collision-safe). `pendle.claim` is an income
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
  // Morpho vault deposit / withdraw match their dedicated `lend_deposit` /
  // `lend_withdraw` prequotes from `morpho.vault.quote` (E3b-2).
  "morpho.vault.deposit": { kind: "lend_deposit", lane: "vault", family: "eip155", provider: "morpho" },
  "morpho.vault.withdraw": { kind: "lend_withdraw", lane: "vault", family: "eip155", provider: "morpho" },
  // Morpho Blue market operations match their dedicated borrow-lane prequotes
  // from `morpho.market.quote` (E3c). ONE kind each, and the mapping is the
  // whole safety property: the gate reads its row under the kind as a predicate,
  // so a quote of another direction is not merely a hash mismatch, it is not
  // even looked at.
  "morpho.market.supplyCollateral": { kind: "lend_supply_collateral", family: "eip155", provider: "morpho" },
  "morpho.market.withdrawCollateral": { kind: "lend_withdraw_collateral", family: "eip155", provider: "morpho" },
  "morpho.market.borrow": { kind: "lend_borrow", family: "eip155", provider: "morpho" },
  // `morpho.rewards.claim` has NO entry here, exactly like `pendle.claim` above
  // and for the same reason: it is an income sweep with NOTHING quoted. A claim
  // has no price, no slippage, no counterparty and no size, so there is no
  // figure a prequote could bind an approval to. It remains approval-gated.
  "morpho.market.repay": { kind: "lend_repay", family: "eip155", provider: "morpho" },
  // The LENDER'S side of a Blue market, under the SAME kinds as the vault lane
  // above and separated from it by `lane`. A vault-deposit quote therefore
  // cannot authorize a market supply and the reverse is equally impossible: the
  // gate builds a market identity here, whose material is a different length
  // over a different anchor, so the digests cannot meet.
  "morpho.market.supply": { kind: "lend_deposit", lane: "market", family: "eip155", provider: "morpho" },
  "morpho.market.withdraw": { kind: "lend_withdraw", lane: "market", family: "eip155", provider: "morpho" },
};

// ── Recorder -> gate-row mapping (derived, read-only) ─────────────────────

/**
 * ONE gate row a quote tool's recorder can write.
 *
 * `lane` is present exactly when the kind needs it - `lend_deposit` and
 * `lend_withdraw` are shared by the vault lane and the market lane, and the
 * lane travels on the identity into `computePrequoteMatchHash`, so a row
 * without its lane names two different operations at once.
 */
export interface PrequoteGateTarget {
  readonly kind: ExecuteGateRegistration["kind"];
  readonly lane?: "vault" | "market";
}

/**
 * WHICH GATE ROWS EACH QUOTE TOOL ACTUALLY WRITES, keyed by the same quote
 * toolId as {@link PREQUOTE_QUOTE_TOOLS}.
 *
 * READ-ONLY DERIVATION, NOT A SECOND GATE. The gate itself keeps reading
 * `EXECUTE_GATE_TOOLS` + the match hash; nothing here can admit a prequote the
 * gate would refuse. It exists because the published contract
 * (`vex_ToolDescribe.quoteGate.authorizedBy`, `mcp/tool-describe-export.ts`)
 * used to derive "which quote authorizes this execute" from `provider`
 * equality alone, which advertised pairings the gate refuses: every Morpho
 * quote for every Morpho execute, every Pendle quote for every Pendle execute.
 * Provider is necessary and never sufficient - the gate reads its row under
 * `kind` (and `lane`) as a predicate.
 *
 * EVERY ROW IS TAKEN FROM THE RECORDER THAT WRITES IT, never from convention:
 *
 * - `swap` (`record/swap.ts:165,185`) for the four venue swap quotes.
 * - `bridge` (`record/bridge.ts:72`) for both bridge quotes.
 * - `pendle.pt.quote` writes `redeem` (`record/pendle-pt.ts:71`) or `swap`
 *   (`record/pendle-pt.ts:94,111`), decided from the Convert `action`.
 * - `pendle.yt.quote` shares that recorder but its handler FIXES
 *   `action: "swap"` (`pendle/handlers/yt/quote.ts:88`), so the redeem branch
 *   is unreachable for it and a YT quote can never authorize a PT redeem.
 * - `pendle.py.quote` writes `mint` (`record/pendle-py.ts:55`) or `redeem_py`
 *   (`record/pendle-py.ts:90`).
 * - `pendle.lp.quote` writes `lp_add` (`record/pendle-lp.ts:55`) or
 *   `lp_remove` (`record/pendle-lp.ts:90`).
 * - `morpho.vault.quote` writes `lend_deposit` or `lend_withdraw`
 *   (`record/morpho-lend.ts:62`) on the VAULT lane
 *   (`identity/hash/morpho-lend.ts:61,87`).
 * - `morpho.market.quote` writes one of the six borrow-lane kinds
 *   (`record/morpho-borrow.ts:71` through
 *   `identity/morpho-borrow.ts:61-72 KIND_FOR_DIRECTION`), and its `supply` /
 *   `withdraw` directions reuse the two lend kinds on the MARKET lane
 *   (`identity/morpho-borrow.ts:199,213`).
 */
export const PREQUOTE_QUOTE_WRITES: Readonly<Record<string, readonly PrequoteGateTarget[]>> = {
  "kyberswap.swap.quote": [{ kind: "swap" }],
  "uniswap.swap.quote": [{ kind: "swap" }],
  "trench.trade_quote": [{ kind: "swap" }],
  "solana.swap.quote": [{ kind: "swap" }],
  "khalani.quote.get": [{ kind: "bridge" }],
  "relay.quote.get": [{ kind: "bridge" }],
  "pendle.pt.quote": [{ kind: "swap" }, { kind: "redeem" }],
  "pendle.yt.quote": [{ kind: "swap" }],
  "pendle.py.quote": [{ kind: "mint" }, { kind: "redeem_py" }],
  "pendle.lp.quote": [{ kind: "lp_add" }, { kind: "lp_remove" }],
  "morpho.vault.quote": [
    { kind: "lend_deposit", lane: "vault" },
    { kind: "lend_withdraw", lane: "vault" },
  ],
  "morpho.market.quote": [
    { kind: "lend_supply_collateral" },
    { kind: "lend_withdraw_collateral" },
    { kind: "lend_borrow" },
    { kind: "lend_repay" },
    { kind: "lend_deposit", lane: "market" },
    { kind: "lend_withdraw", lane: "market" },
  ],
};

/** The lane a gate registration carries, or `undefined` when its kind needs none. */
export function laneOfGateRegistration(gate: ExecuteGateRegistration): "vault" | "market" | undefined {
  return "lane" in gate ? gate.lane : undefined;
}

/**
 * The quote toolIds whose recorder can write the row this execute is gated on,
 * from the SAME provider. Sorted, so the published answer is deterministic.
 */
export function quoteToolsAuthorizing(gate: ExecuteGateRegistration): readonly string[] {
  const lane = laneOfGateRegistration(gate);
  return Object.entries(PREQUOTE_QUOTE_TOOLS)
    .filter(([quoteToolId, registration]) => {
      if (registration.provider !== gate.provider) return false;
      const writes = PREQUOTE_QUOTE_WRITES[quoteToolId] ?? [];
      return writes.some((target) => target.kind === gate.kind && target.lane === lane);
    })
    .map(([quoteToolId]) => quoteToolId)
    .sort();
}
