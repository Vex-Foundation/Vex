/**
 * THE GATE ROW EACH RECORDER WRITES, owned by the recorders themselves.
 *
 * ONE SOURCE, TWO CONSUMERS. Every `kind` (and, on the two shared lend kinds,
 * every `lane`) a prequote recorder can write is declared here ONCE:
 *
 *   - the recorder reads it to build the row it persists
 *     (`record/swap.ts`, `record/bridge.ts`, `record/pendle-*.ts`,
 *     `record/morpho-*.ts`), and
 *   - `prequote/registry.ts` composes `PREQUOTE_QUOTE_WRITES` out of it, which
 *     is what `vex_ToolDescribe.quoteGate.authorizedBy` publishes.
 *
 * That is the whole reason this module exists. The published answer used to be
 * a SECOND literal table in the registry and a THIRD in its test, so a recorder
 * could change the row it writes and leave both copies green - the description
 * would keep advertising a pairing the gate refuses, on a call that moves
 * money. There is now nothing to drift from: change a value here and both the
 * persisted row and the published contract change with it.
 *
 * NOT A GATE. Nothing here admits a prequote. The gate keeps reading
 * `EXECUTE_GATE_TOOLS` plus the match hash (`prequote/gate.ts`), and the
 * identity builders keep owning the hash material. Where a table already
 * existed on that side, this module DERIVES from it rather than restating it:
 *
 *   - the Morpho MARKET map calls `morphoBorrowKindForDirection`, the same
 *     function the identity builders use, so the row, the hash and the
 *     description read one table;
 *   - every map is keyed by the EXTRACTOR's own direction union, so a venue
 *     that gains a direction fails to compile here until its row is declared.
 *
 * Pure data + pure functions. No IO.
 */

import type { PrequoteGateTarget } from "../registry.js";
import type { ExtractedMorphoLendQuote } from "../safety/extract/morpho-lend.js";
import type { ExtractedPendleQuote } from "../safety/extract/pendle-pt.js";
import type { ExtractedPendleLpQuote } from "../safety/extract/pendle-lp.js";
import type { ExtractedPendlePyQuote } from "../safety/extract/pendle-py.js";
import {
  morphoBorrowKindForDirection,
  type MorphoBorrowDirection,
} from "../identity/morpho-borrow.js";

/** The row the four venue swap quotes record (`record/swap.ts`). */
export const SWAP_QUOTE_GATE_TARGET = { kind: "swap" } as const satisfies PrequoteGateTarget;

/** The row both bridge quotes record (`record/bridge.ts`). */
export const BRIDGE_QUOTE_GATE_TARGET = { kind: "bridge" } as const satisfies PrequoteGateTarget;

/**
 * The rows `pendle.pt.quote` records, by the Convert `action` its own result
 * echoes (`record/pendle-pt.ts`). `pendle.yt.quote` shares this recorder, but
 * its handler FIXES `action: "swap"`, so the registry narrows it to that one
 * action rather than inheriting both.
 */
export const PENDLE_PT_QUOTE_GATE_TARGETS = {
  swap: { kind: "swap" },
  redeem: { kind: "redeem" },
} as const satisfies Readonly<Record<ExtractedPendleQuote["action"], PrequoteGateTarget>>;

/** The action a Pendle PT/YT quote can record under. */
export type PendlePtQuoteAction = keyof typeof PENDLE_PT_QUOTE_GATE_TARGETS;

/** Every action the PT recorder can take, for the tools that are not narrowed. */
export const PENDLE_PT_QUOTE_ACTIONS = ["swap", "redeem"] as const satisfies
  readonly PendlePtQuoteAction[];

/** The rows `pendle.py.quote` records, by the echoed direction (`record/pendle-py.ts`). */
export const PENDLE_PY_QUOTE_GATE_TARGETS = {
  mint: { kind: "mint" },
  redeem: { kind: "redeem_py" },
} as const satisfies Readonly<Record<ExtractedPendlePyQuote["direction"], PrequoteGateTarget>>;

/** The rows `pendle.lp.quote` records, by the echoed direction (`record/pendle-lp.ts`). */
export const PENDLE_LP_QUOTE_GATE_TARGETS = {
  add: { kind: "lp_add" },
  remove: { kind: "lp_remove" },
} as const satisfies Readonly<Record<ExtractedPendleLpQuote["direction"], PrequoteGateTarget>>;

/**
 * The rows `morpho.vault.quote` records (`record/morpho-lend.ts`), on the VAULT
 * lane. The lane is not decoration: it travels on the identity into
 * `computePrequoteMatchHash` (`identity/hash/morpho-lend.ts`), and it is the
 * only thing between "put money in a curated vault" and "lend into a Blue
 * market", which share both kinds.
 */
export const MORPHO_LEND_QUOTE_GATE_TARGETS = {
  deposit: { kind: "lend_deposit", lane: "vault" },
  withdraw: { kind: "lend_withdraw", lane: "vault" },
} as const satisfies Readonly<Record<ExtractedMorphoLendQuote["direction"], PrequoteGateTarget>>;

/**
 * The row one market direction records. The four borrower operations carry no
 * lane (their kinds belong to this lane alone); the LENDER'S two reuse the
 * vault lane's kinds, so they MUST carry `lane: "market"` - the same
 * discriminator their identity builders put in the hash
 * (`identity/morpho-borrow.ts`, `buildMorphoMarketSupplyIdentity`).
 */
function morphoMarketGateTarget(direction: MorphoBorrowDirection): PrequoteGateTarget {
  const kind = morphoBorrowKindForDirection(direction);
  return kind === "lend_deposit" || kind === "lend_withdraw"
    ? { kind, lane: "market" }
    : { kind };
}

/**
 * The rows `morpho.market.quote` records, by the direction it priced.
 *
 * Every row's KIND comes from the identity side's own table rather than being
 * restated here, and the six keys are required by the compiler, so a direction
 * added to that lane fails to build until it declares the row it writes.
 */
export const MORPHO_MARKET_QUOTE_GATE_TARGETS: Readonly<
  Record<MorphoBorrowDirection, PrequoteGateTarget>
> = {
  supplyCollateral: morphoMarketGateTarget("supplyCollateral"),
  withdrawCollateral: morphoMarketGateTarget("withdrawCollateral"),
  borrow: morphoMarketGateTarget("borrow"),
  repay: morphoMarketGateTarget("repay"),
  supply: morphoMarketGateTarget("supply"),
  withdraw: morphoMarketGateTarget("withdraw"),
};
