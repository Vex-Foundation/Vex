/**
 * The sentences the SIX Morpho Blue market executes must say, written once.
 *
 * Same doctrine as `./vault-execute-shared.ts`: each of these is a safety claim
 * the owner's approval policy or rules/90 requires a mutating tool to make, not
 * stylistic boilerplate, and a copy edited in one manifest and not the other is
 * how two tools end up promising different things about the same mechanism.
 *
 * WHAT IS NOT SHARED IS THE CONSENT MODEL, deliberately. Three of the six
 * operations PULL a token and are two transactions behind one consent; the other
 * three only RECEIVE and are a single direct Morpho Blue call with no approval
 * at any point. Averaging those into one sentence would either invent an
 * approval step for a borrow or hide one from a repayment, so each manifest
 * states its own shape and only the facts that genuinely apply live here.
 *
 * THE HEALTH-FACTOR SENTENCE IS NOT SHARED EITHER, and that absence is load
 * bearing. The two LENDER operations (`morpho.market.supply` and
 * `morpho.market.withdraw`) have no health factor at all: they take on no debt
 * and post no collateral. They say so with their own sentence below rather than
 * inheriting a floor that does not apply to them.
 */

import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "../../slippage-policy.js";

/** Quote-first, named as a gate rather than as advice. */
export const MORPHO_MARKET_QUOTE_FIRST_SENTENCE =
  "QUOTE FIRST: REFUSED without a fresh `morpho__market_quote` of THIS direction for exactly these params. A quote of "
  + "any other direction does not authorize it.";

/**
 * The floor, and the reason it is policy rather than advice.
 *
 * IT IS A BUFFER, NOT A GUARANTEE, and the sentence has to say so. The calldata
 * Vex signs is a plain Morpho Blue call with no floor encoded in it, so the only
 * thing 1.25 binds is whether Vex signs at all. An oracle move between signing
 * and inclusion can settle the position under 1.25 and still above Morpho's own
 * liquidation threshold of 1, and a manifest that called this a guarantee would
 * be selling a safety property the chain never agreed to.
 */
export const MORPHO_HEALTH_FLOOR_SENTENCE =
  "REFUSED below a health factor of 1.25, projected fresh and re-checked immediately before signing. That floor is a "
  + "PRE-SIGNATURE BUFFER, not an on-chain guarantee: the signed call carries no floor, so an oracle move before "
  + "inclusion can settle the position below 1.25 while still above Morpho's liquidation threshold of 1. A `null` "
  + "health factor means NO DEBT, not a failed read.";

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
  "NOT ATOMIC with any other operation: Vex grants no standing authorization, so a supply-then-borrow is two "
  + "separately quoted and separately consented OPERATIONS, and either can fail with the other landed. What makes "
  + "the in-between state safe is ORDERING - collateral in before debt out, debt down before collateral out - so a "
  + "second leg that never lands leaves the position safer than it started.";

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
  + "per-share price of the TWO operations that move shares: a market supply and a repayment. On each, Vex derives a "
  + "`maxSharePrice` ceiling from it that the CHAIN enforces, so a worse price cannot mine; on a full-debt "
  + "(shares-mode) repayment it also caps the approval. The other four - supply_collateral, withdraw, "
  + "withdraw_collateral and borrow - are direct calls naming their own exact token amount, carry NO on-chain price "
  + "guard, and are unaffected by this value.";

/**
 * WHAT SUPPLYING DIRECTLY ACTUALLY BUYS, from live measurement rather than from
 * a brochure. Every curated USDC vault on Base earns the SAME gross rate because
 * they allocate into the same markets; the only thing that separates them is the
 * curator's performance fee. Stating the measured table is the difference
 * between the agent making an informed choice and repeating "the vault is safer".
 */
export const MORPHO_LENDER_CHOICE_SENTENCE =
  "DIRECT VERSUS CURATED, measured on Base: every curated USDC vault earns the SAME gross 4.13% because they "
  + "allocate into the same markets, and only the curator's fee separates them (Gauntlet 0% leaves 4.13% net, "
  + "Steakhouse Prime 5% leaves 3.92%, Spark 10% leaves 3.71%, Steakhouse USDC 25% leaves 3.08%). Supplying "
  + "cbBTC/USDC DIRECTLY earns the full 4.13% with NO fee, and what you give up for it is diversification and "
  + "management: the position is concentrated in ONE market's collateral, oracle and LLTV, and NOBODY REALLOCATES "
  + "IT FOR YOU when that market degrades. Say both halves before recommending either.";

/** Neither lender operation touches a borrower's health factor. Stated, not implied. */
export const MORPHO_LENDER_NO_HEALTH_SENTENCE =
  "THIS DOES NOT MOVE THE HEALTH FACTOR. Supplying and withdrawing the loan asset is the LENDER'S side of the "
  + "market: it takes on no debt and posts no collateral, so it has no liquidation risk of its own and it changes "
  + "nothing about any borrow position the same wallet may hold on the same market.";

/** The two independent ceilings on a lender withdrawal, both refused by name. */
export const MORPHO_LENDER_WITHDRAW_BOUNDS_SENTENCE =
  "TWO INDEPENDENT LIMITS, each REFUSED BY NAME rather than silently clamped. First, YOUR OWN SUPPLIED POSITION: "
  + "you cannot withdraw more than you have supplied plus the interest it accrued. Second, THE MARKET'S AVAILABLE "
  + "LIQUIDITY: supplied assets that borrowers have already drawn are not there to withdraw, so a market that is "
  + "fully utilised can refuse a withdrawal you are otherwise entitled to. That second limit is the real cost of "
  + "lending directly, and it is not a failure of Vex: wait for a repayment or withdraw the part that is free.";

export const MORPHO_MARKET_ID_PARAM =
  "The market's 0x-prefixed 64-hex id, from `morpho__markets_discover` or `morpho__positions_get`. A 40-hex value is a "
  + "CONTRACT ADDRESS and is rejected by name. Chain-scoped.";

export const MORPHO_MARKET_CHAIN_PARAM =
  "The chain the market lives on. Required: a market id is chain-scoped.";
