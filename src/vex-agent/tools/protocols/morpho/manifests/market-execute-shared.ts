/**
 * The sentences the FOUR Morpho Blue market executes must say, written once.
 *
 * Same doctrine as `./vault-execute-shared.ts`: each of these is a safety claim
 * the owner's approval policy or rules/90 requires a mutating tool to make, not
 * stylistic boilerplate, and a copy edited in one manifest and not the other is
 * how two tools end up promising different things about the same mechanism.
 *
 * WHAT IS NOT SHARED IS THE CONSENT MODEL, deliberately. Two of the four
 * operations PULL a token and are two transactions behind one consent; the other
 * two only RECEIVE and are a single direct Morpho Blue call with no approval at
 * any point. Averaging those into one sentence would either invent an approval
 * step for a borrow or hide one from a repayment, so each manifest states its
 * own shape and only the facts that genuinely apply to all four live here.
 */

import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "../../slippage-policy.js";

/** Quote-first, named as a gate rather than as advice. */
export const MORPHO_MARKET_QUOTE_FIRST_SENTENCE =
  "QUOTE FIRST: REFUSED without a fresh `morpho.market.quote` of THIS direction for exactly these params. A quote of "
  + "any other direction does not authorize it.";

/** The floor, and the reason it is policy rather than advice. */
export const MORPHO_HEALTH_FLOOR_SENTENCE =
  "REFUSED below a health factor of 1.25, projected fresh and re-checked immediately before signing. A `null` health "
  + "factor means NO DEBT, not a failed read.";

/** Which markets Vex will act on at all. */
export const MORPHO_ORACLE_VOUCHING_SENTENCE =
  "REFUSED on any market whose oracle and IRM Vex cannot vouch for, by name, before anything is built. The gate is "
  + "strict: only 9 of 100 Base markets sampled passed it.";

/** One leg per operation, and why there is no second one. */
export const MORPHO_ONE_LEG_SENTENCE =
  "ONE LEG: the result carries one of `tokenIn` (wallet sends) or `tokenOut` (wallet receives), never both. The "
  + "market's two tokens rarely share a decimal scale, so never compare a collateral raw amount with a loan one.";

/** What is written down, and what the four endings mean. */
export const MORPHO_MARKET_LEDGER_SENTENCE =
  "RECORDED before anything is signed, and the amount reported back is PROVEN from the receipt rather than copied "
  + "from the quote. Four endings: confirmed, refused (nothing signed, no gas), reverted (gas spent, position "
  + "untouched), and unproven - on unproven DO NOT RETRY, the funds may already have moved.";

/** The atomicity Vex deliberately does not have. */
export const MORPHO_NO_COMBO_SENTENCE =
  "NOT ATOMIC with any other operation: Vex grants no standing authorization, so a supply-then-borrow is two separate "
  + "calls and either can fail with the other landed. Each is gated on its own post-state.";

/** The two operations that pull a token, stated once. */
export const MORPHO_PULLING_CONSENT_SENTENCE =
  "WHAT GETS SIGNED: TWO transactions behind ONE consent - an exact-amount ERC-20 `approve()` to the chain's pinned "
  + "GeneralAdapter1, then the operation through Bundler3. Never an unlimited approval and never a signature of any "
  + "kind. They are not atomic, so a failure after the approval lands leaves a standing allowance capped at this "
  + "amount, named in the failure output; retrying consumes it, or approve zero to revoke it.";

/** The two operations that pull nothing, stated once. */
export const MORPHO_RECEIVING_CONSENT_SENTENCE =
  "WHAT GETS SIGNED: exactly ONE direct call on Morpho Blue. This operation only RECEIVES, so there is no approval, "
  + "no bundle and NO STANDING ALLOWANCE at any point. The proceeds land in the signing wallet by construction.";

/** The dryRun contract, identical on all four. */
export const MORPHO_MARKET_DRY_RUN_PARAM =
  "Set true to get the FULL preview and sign nothing: the vouching verdict, the health factor before and after, the "
  + "free liquidity, the allowance plan, the decoded transaction, the gas bound and the simulation verdict.";

export const MORPHO_MARKET_SLIPPAGE_PARAM =
  `Price protection in basis points (1 bps = 0.01%). Default ${VEX_DEFAULT_SLIPPAGE_BPS}, capped at `
  + `${VEX_MAX_SLIPPAGE_BPS}, and a higher value is REJECTED rather than clamped. It bounds a full-debt repayment's `
  + "share price and its approval ceiling; the other operations name their own exact amount and are unaffected.";

export const MORPHO_MARKET_ID_PARAM =
  "The market's 0x-prefixed 64-hex id, from `morpho.markets.discover` or `morpho.positions.get`. A 40-hex value is a "
  + "CONTRACT ADDRESS and is rejected by name. Chain-scoped.";

export const MORPHO_MARKET_CHAIN_PARAM =
  "The chain the market lives on. Required: a market id is chain-scoped.";
