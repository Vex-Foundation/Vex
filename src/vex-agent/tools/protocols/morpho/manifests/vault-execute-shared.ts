/**
 * The sentences `morpho.vault.deposit` and `morpho.vault.withdraw` must BOTH
 * say, written once.
 *
 * These are not stylistic boilerplate. Each one is a safety claim the owner's
 * approval policy or rules/90 requires an agent-facing mutating tool to make:
 * quote-first, the two-transaction consent model, the exact-amount approval, the
 * non-atomicity and its remediations, the gating hazard, the absolute share
 * floor, and what lands in the activity ledger. A copy of a safety claim left in
 * one manifest and edited in the other is how two tools end up promising
 * different things about the same mechanism, so there is one owner of each
 * sentence and the two manifests compose them.
 *
 * The DECIMALS sentences are deliberately NOT here and not imported from
 * `conventions.ts`: each amount param names the vault asset as its own source in
 * its own words, for the two reasons `vault-quote.ts` records - the canonical
 * sentence points at `TokenFind`, which is the wrong source for a vault asset
 * read off the vault itself, and it contains an em dash, which this namespace
 * bans.
 */

import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "../../slippage-policy.js";

/** Quote-first, named as a gate rather than as advice. */
export const MORPHO_QUOTE_FIRST_SENTENCE =
  "QUOTE FIRST, ALWAYS: this tool is gated on a fresh `morpho__vault_quote` for EXACTLY these params (same vault, same "
  + "chain, same raw amount, same slippageBps), and it is REFUSED without one. A quote for the other direction does "
  + "not authorize this one.";

/** What is actually signed, and how many times. */
export const MORPHO_TWO_TX_SENTENCE =
  "WHAT GETS SIGNED: a deposit is TWO transactions behind ONE consent. First a plain ERC-20 `approve()` for EXACTLY "
  + "this operation's amount to the chain's pinned GeneralAdapter1, then the deposit itself. Vex NEVER grants an "
  + "unlimited approval and NEVER signs a permit, a permit2 message, or any other off-chain signature for Morpho; a "
  + "requirement for one is refused by name. When the wallet's existing allowance already covers the amount there is "
  + "only one transaction.";

/** The non-atomicity the owner accepted in writing, with both ways out. */
export const MORPHO_RESIDUAL_SENTENCE =
  "THE FAILURE MODE THIS BUYS, stated up front: the two transactions are not atomic, so if the approval lands and the "
  + "deposit then fails, a standing allowance is left behind. It is capped at exactly this one operation's amount, it "
  + "is reported in the failure output in the wallet's own units, and there are two ways out: retrying the same "
  + "deposit consumes it and grants nothing further, or it can be revoked by approving zero to the same spender.";

/** Gating: disclose, do not block. */
export const MORPHO_GATING_SENTENCE =
  "GATING HAZARD: a V2 vault can carry a gate contract that refuses this very operation on chain however healthy its "
  + "numbers look. Vex DISCLOSES gating rather than blocking on it, and reports it as UNKNOWN rather than absent when "
  + "the governance read did not answer. Say so before recommending the operation.";

/** The share bound, stated as what it actually is: the chain's own price guard. */
export const MORPHO_SHARE_FLOOR_SENTENCE =
  "PRICE PROTECTION: `slippageBps` sets a per-share PRICE bound, derived ONCE from this operation's quote and the "
  + "approved basis points before any settlement is known. The share floor it implies is proportional to the size "
  + "traded, exactly as the chain's own guard is. On a deposit it is the ceiling the transaction's own "
  + "`maxSharePrice` guard enforces ON CHAIN, so a worse fill cannot mine. The settled shares are reported against "
  + "that bound, with the plain quoted-vs-settled "
  + "difference beside it labelled accrual drift, which is the interest the vault earned between the two blocks and is "
  + "normal rather than a fault.";

/** What is written down, and what the four endings mean. */
export const MORPHO_LEDGER_SENTENCE =
  "RECORDED: every attempt writes a row to Vex's activity ledger BEFORE anything is signed, and the amounts reported "
  + "back are PROVEN from the receipt's own logs rather than copied from the quote. Four endings, never collapsed: "
  + "confirmed, refused (nothing signed, no gas spent), reverted (gas spent, principal untouched), and unproven. On "
  + "unproven, DO NOT RETRY: the transaction may already have moved real funds; the row stays pending and resolves "
  + "automatically.";

/** The dryRun contract, identical on both tools. */
export const MORPHO_DRY_RUN_PARAM_DESCRIPTION =
  "Set true to get the FULL preview and sign nothing: the built and decoded transaction, the allowance plan including "
  + "any approval still needed, the gas bound and the simulation verdict. It is a preview of this exact operation, not "
  + "a promise, and nothing is broadcast, approved or recorded as executed.";

/** The slippage param description, identical on both tools. */
export const MORPHO_SLIPPAGE_PARAM_DESCRIPTION =
  `Price protection in basis points (1 bps = 0.01%). Default ${VEX_DEFAULT_SLIPPAGE_BPS} = `
  + `${VEX_DEFAULT_SLIPPAGE_BPS / 100}%. Vex caps it at ${VEX_MAX_SLIPPAGE_BPS} (${VEX_MAX_SLIPPAGE_BPS / 100}%) and `
  + "REJECTS a higher value rather than clamping it.";

/** The vault address param, identical on both tools. */
export const MORPHO_VAULT_ADDRESS_PARAM_DESCRIPTION =
  "The vault's 0x-prefixed 40-hex contract address, from `morpho__vaults_discover` or `morpho__vault_get`. A 64-hex "
  + "value is rejected by name because that is a MARKET id, not a vault. Both vault generations are detected "
  + "automatically.";
