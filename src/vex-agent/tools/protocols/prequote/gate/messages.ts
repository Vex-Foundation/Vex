/**
 * Agent-facing rendering of a gate BLOCK: one message map per gated kind, and
 * the `block` constructor that picks the map. Every map is total over
 * `GateBlockReason` so a new reason cannot ship without wording.
 */

import type { PrequoteKind } from "@vex-agent/db/repos/swap-prequotes.js";

import type { GateBlockReason } from "../gate-errors.js";
import type { GateDecision } from "./decision.js";

const SWAP_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Swap blocked: could not verify a fresh quote. Re-run the swap quote and retry.",
  no_session:
    "Swap blocked: could not verify a fresh quote (no session). Re-run the swap quote and retry.",
  unresolved_token:
    "Swap blocked: unresolved execute token — pass the exact token address the quote returned, then retry.",
  no_quote:
    "Swap blocked: no fresh quote for these exact params — the execute must use EXACTLY the same params as the quote, including slippageBps (same value, or omitted on both sides). Call the swap quote first with those params, then retry.",
  safety_fail:
    "Swap blocked: the quoted token was flagged unsafe (honeypot/scam) by the pre-quote safety check. If this is the token you are BUYING, do not retry — pick a different token. If this is a token you already HOLD and are trying to exit, this block is not protecting you: report it and stop rather than retrying, because Vex has no exit path for a flagged holding today.",
  wallet_setup:
    "Swap blocked: the mission is still in setup (no active run), so swaps cannot broadcast yet. Accept and start the mission run, then swap — do NOT re-quote.",
  wallet_scope:
    "Swap blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry — do NOT re-quote.",
  wallet_not_selected:
    "Swap blocked: no wallet is selected (or configured) for this swap's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  // Unreachable on the swap path (only the bridge execute carries these params),
  // but the reason map must be total over GateBlockReason.
  unbindable_param:
    "Swap blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const BRIDGE_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Bridge blocked: could not verify a fresh bridge quote. Re-run BridgeQuote and retry.",
  no_session:
    "Bridge blocked: could not verify a fresh bridge quote (no session). Re-run BridgeQuote and retry.",
  // A bridge execute has no bare-symbol leg (addresses are passed through), so
  // this reason is unreachable on the bridge path; keep a coherent message.
  unresolved_token:
    "Bridge blocked: unresolved bridge token — pass the exact token addresses the quote returned, then retry.",
  no_quote:
    "Bridge blocked: no fresh bridge quote for these exact params. Call BridgeQuote first, then retry.",
  safety_fail:
    "Bridge blocked: the quoted route was flagged unsafe. Aborting.",
  wallet_setup:
    "Bridge blocked: the mission is still in setup (no active run), so bridges cannot broadcast yet. Accept and start the mission run, then bridge — do NOT re-quote.",
  wallet_scope:
    "Bridge blocked: a wallet for this bridge can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry — do NOT re-quote.",
  wallet_not_selected:
    "Bridge blocked: no wallet is selected (or configured) for one of the bridge's chains in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Bridge blocked: routeId/depositMethod cannot be bound to a quote — omit them (the bridge selects the best route) or this execute can't be verified.",
};

const REDEEM_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Redeem blocked: could not verify a fresh redeem quote. Re-run pendle__pt_quote for this PT and retry.",
  no_session:
    "Redeem blocked: could not verify a fresh redeem quote (no session). Re-run pendle__pt_quote and retry.",
  unresolved_token:
    "Redeem blocked: the PT could not be resolved to an active Pendle market. Re-check the PT address, then retry.",
  no_quote:
    "Redeem blocked: no fresh redeem quote for this exact PT/amount. Call pendle__pt_quote first, then retry.",
  safety_fail:
    "Redeem blocked: the quoted redemption was flagged unsafe. Aborting.",
  wallet_setup:
    "Redeem blocked: the mission is still in setup (no active run), so redeems cannot broadcast yet. Accept and start the mission run, then redeem — do NOT re-quote.",
  wallet_scope:
    "Redeem blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Redeem blocked: no wallet is selected (or configured) for Ethereum in the current session. Select a wallet, then retry — do NOT re-quote.",
  // Unreachable on the redeem path (redeem carries no unbindable params), but the
  // reason map must be total over GateBlockReason.
  unbindable_param:
    "Redeem blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const MINT_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Mint blocked: could not verify a fresh mint quote. Re-run pendle__py_quote (direction mint) for this PT and retry.",
  no_session:
    "Mint blocked: could not verify a fresh mint quote (no session). Re-run pendle__py_quote and retry.",
  unresolved_token:
    "Mint blocked: the PT could not be resolved to an active Pendle market. Re-check the PT address, then retry.",
  no_quote:
    "Mint blocked: no fresh mint quote for this exact PT/token/amount. Call pendle__py_quote (direction mint) first, then retry.",
  safety_fail:
    "Mint blocked: the quoted mint was flagged unsafe. Aborting.",
  wallet_setup:
    "Mint blocked: the mission is still in setup (no active run), so mints cannot broadcast yet. Accept and start the mission run, then mint — do NOT re-quote.",
  wallet_scope:
    "Mint blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Mint blocked: no wallet is selected (or configured) for this mint's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Mint blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const REDEEM_PY_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Redeem blocked: could not verify a fresh redeem quote. Re-run pendle__py_quote (direction redeem) for this PT and retry.",
  no_session:
    "Redeem blocked: could not verify a fresh redeem quote (no session). Re-run pendle__py_quote and retry.",
  unresolved_token:
    "Redeem blocked: the PT could not be resolved to an active Pendle market. Re-check the PT address, then retry.",
  no_quote:
    "Redeem blocked: no fresh redeem quote for this exact PT/output/amount. Call pendle__py_quote (direction redeem) first, then retry. A MATURED PT (PT only, no YT) uses pendle__pt_redeem instead.",
  safety_fail:
    "Redeem blocked: the quoted redemption was flagged unsafe. Aborting.",
  wallet_setup:
    "Redeem blocked: the mission is still in setup (no active run), so redeems cannot broadcast yet. Accept and start the mission run, then redeem — do NOT re-quote.",
  wallet_scope:
    "Redeem blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Redeem blocked: no wallet is selected (or configured) for this redeem's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Redeem blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const LP_ADD_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Add liquidity blocked: could not verify a fresh LP quote. Re-run pendle__lp_quote (direction add) for this market and retry.",
  no_session:
    "Add liquidity blocked: could not verify a fresh LP quote (no session). Re-run pendle__lp_quote and retry.",
  unresolved_token:
    "Add liquidity blocked: the market could not be resolved to an active Pendle market. Re-check the market address, then retry.",
  no_quote:
    "Add liquidity blocked: no fresh add quote for this exact market/token/amount. Call pendle__lp_quote (direction add) first, then retry.",
  safety_fail:
    "Add liquidity blocked: the quoted add was flagged unsafe. Aborting.",
  wallet_setup:
    "Add liquidity blocked: the mission is still in setup (no active run), so LP adds cannot broadcast yet. Accept and start the mission run, then add — do NOT re-quote.",
  wallet_scope:
    "Add liquidity blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Add liquidity blocked: no wallet is selected (or configured) for this add's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Add liquidity blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const LP_REMOVE_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Remove liquidity blocked: could not verify a fresh LP quote. Re-run pendle__lp_quote (direction remove) for this market and retry.",
  no_session:
    "Remove liquidity blocked: could not verify a fresh LP quote (no session). Re-run pendle__lp_quote and retry.",
  unresolved_token:
    "Remove liquidity blocked: the market could not be resolved to an active Pendle market. Re-check the market address, then retry.",
  no_quote:
    "Remove liquidity blocked: no fresh remove quote for this exact market/output/amount. Call pendle__lp_quote (direction remove) first, then retry.",
  safety_fail:
    "Remove liquidity blocked: the quoted removal was flagged unsafe. Aborting.",
  wallet_setup:
    "Remove liquidity blocked: the mission is still in setup (no active run), so LP removes cannot broadcast yet. Accept and start the mission run, then remove — do NOT re-quote.",
  wallet_scope:
    "Remove liquidity blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Remove liquidity blocked: no wallet is selected (or configured) for this remove's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Remove liquidity blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/**
 * Morpho vault DEPOSIT (E3b-2). These exist because the selector below falls
 * back to the SWAP map: without them, the first blocked Morpho deposit would
 * tell the agent to re-run a SWAP quote, which is not a tool that can authorize
 * this operation, and the agent would loop on advice that cannot work.
 *
 * Every message names `morpho.vault.quote` with the direction, because that is
 * the ONLY tool whose prequote this execute matches.
 */
const LEND_DEPOSIT_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Vault deposit blocked: could not verify a fresh vault quote. Re-run morpho__vault_quote (direction deposit) for this vault and retry.",
  no_session:
    "Vault deposit blocked: could not verify a fresh vault quote (no session). Re-run morpho__vault_quote and retry.",
  unresolved_token:
    "Vault deposit blocked: the vault address could not be resolved on this chain. Re-check the vault address and the chain, then retry.",
  no_quote:
    "Vault deposit blocked: no fresh quote for these exact params. The deposit must use EXACTLY the params the quote used, including the vault, the chain, depositAmountRaw and slippageBps (same value, or omitted on both sides). Call morpho__vault_quote (direction deposit) with those params first, then retry.",
  safety_fail:
    "Vault deposit blocked: the quoted vault was flagged unsafe by the pre-quote check. Do not retry; report it and pick a different vault.",
  wallet_setup:
    "Vault deposit blocked: the mission is still in setup (no active run), so deposits cannot broadcast yet. Accept and start the mission run, then deposit; do NOT re-quote.",
  wallet_scope:
    "Vault deposit blocked: the selected wallet can't be used. It may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry; do NOT re-quote.",
  wallet_not_selected:
    "Vault deposit blocked: no wallet is selected (or configured) for this vault's chain in the current session. Select a wallet, then retry; do NOT re-quote.",
  unbindable_param:
    "Vault deposit blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/** Morpho vault WITHDRAW (E3b-2). The mirror map; see the deposit map above. */
const LEND_WITHDRAW_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Vault withdrawal blocked: could not verify a fresh vault quote. Re-run morpho__vault_quote (direction withdraw) for this vault and retry.",
  no_session:
    "Vault withdrawal blocked: could not verify a fresh vault quote (no session). Re-run morpho__vault_quote and retry.",
  unresolved_token:
    "Vault withdrawal blocked: the vault address could not be resolved on this chain. Re-check the vault address and the chain, then retry.",
  no_quote:
    "Vault withdrawal blocked: no fresh quote for these exact params. The withdrawal must use EXACTLY the params the quote used, including the vault, the chain, withdrawAmountRaw and slippageBps (same value, or omitted on both sides). A DEPOSIT quote does not authorize a withdrawal. Call morpho__vault_quote (direction withdraw) with those params first, then retry.",
  safety_fail:
    "Vault withdrawal blocked: the quoted vault was flagged unsafe by the pre-quote check. This block is not protecting a wallet that is trying to EXIT: report it and stop rather than retrying.",
  wallet_setup:
    "Vault withdrawal blocked: the mission is still in setup (no active run), so withdrawals cannot broadcast yet. Accept and start the mission run, then withdraw; do NOT re-quote.",
  wallet_scope:
    "Vault withdrawal blocked: the selected wallet can't be used. It may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry; do NOT re-quote.",
  wallet_not_selected:
    "Vault withdrawal blocked: no wallet is selected (or configured) for this vault's chain in the current session. Select a wallet, then retry; do NOT re-quote.",
  unbindable_param:
    "Vault withdrawal blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/**
 * Morpho Blue BORROW lane (E3c, migration 081). Four maps, one per operation,
 * for the same reason there are four kinds: the operations run against one
 * market and one wallet, so an agent told the wrong one would re-quote the
 * wrong side of its own position.
 *
 * They exist in the SAME batch as the kinds deliberately. A kind registered
 * without a map falls through to the SWAP map below, and the first blocked
 * borrow execute would then tell the agent to re-run a SWAP quote, which is not
 * a tool that can authorize this operation. The agent would loop on advice that
 * cannot work.
 *
 * Each message names `morpho.market.quote` AND the `direction` to pass it, which
 * is the pair the agent has to get right: the toolId alone would send it back
 * with whichever direction it used last, and that is the quote that does not
 * authorize this execute.
 */
const LEND_SUPPLY_COLLATERAL_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Collateral supply blocked: could not verify a fresh quote. Re-run morpho__market_quote (direction supplyCollateral) for this market, then retry.",
  no_session:
    "Collateral supply blocked: could not verify a fresh quote (no session). Re-run morpho__market_quote (direction supplyCollateral) and retry.",
  unresolved_token:
    "Collateral supply blocked: the market or its collateral token could not be resolved on this chain. Re-check the market id and the chain, then retry.",
  no_quote:
    "Collateral supply blocked: no fresh quote for these exact params. The execute must use EXACTLY the params the quote used, including the market id, the chain, the raw collateral amount and slippageBps. Call morpho__market_quote (direction supplyCollateral) with those params first, then retry. A borrow or repay quote does NOT authorize a collateral supply.",
  safety_fail:
    "Collateral supply blocked: the market failed the pre-quote check (it is outside the allowed oracle/IRM set, or its collateral was flagged). Do not retry; pick a different market and report it.",
  wallet_setup:
    "Collateral supply blocked: the mission is still in setup (no active run), so market writes cannot broadcast yet. Accept and start the mission run, then retry; do NOT re-quote.",
  wallet_scope:
    "Collateral supply blocked: the selected wallet can't be used. It may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry; do NOT re-quote.",
  wallet_not_selected:
    "Collateral supply blocked: no wallet is selected (or configured) for this market's chain in the current session. Select a wallet, then retry; do NOT re-quote.",
  unbindable_param:
    "Collateral supply blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/** Morpho Blue collateral WITHDRAW. Reduces the wallet's safety margin. */
const LEND_WITHDRAW_COLLATERAL_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Collateral withdrawal blocked: could not verify a fresh quote. Re-run morpho__market_quote (direction withdrawCollateral) for this market, then retry.",
  no_session:
    "Collateral withdrawal blocked: could not verify a fresh quote (no session). Re-run morpho__market_quote (direction withdrawCollateral) and retry.",
  unresolved_token:
    "Collateral withdrawal blocked: the market or its collateral token could not be resolved on this chain. Re-check the market id and the chain, then retry.",
  no_quote:
    "Collateral withdrawal blocked: no fresh quote for these exact params. The execute must use EXACTLY the params the quote used, including the market id, the chain, the raw collateral amount and slippageBps. Call morpho__market_quote (direction withdrawCollateral) with those params first, then retry. A supplyCollateral quote does NOT authorize a withdrawal, and withdrawing collateral LOWERS the health factor while a supply raises it.",
  safety_fail:
    "Collateral withdrawal blocked: the market failed the pre-quote check. This block is not protecting a wallet that is trying to REDUCE its position: report it and stop rather than retrying.",
  wallet_setup:
    "Collateral withdrawal blocked: the mission is still in setup (no active run), so market writes cannot broadcast yet. Accept and start the mission run, then retry; do NOT re-quote.",
  wallet_scope:
    "Collateral withdrawal blocked: the selected wallet can't be used. It may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry; do NOT re-quote.",
  wallet_not_selected:
    "Collateral withdrawal blocked: no wallet is selected (or configured) for this market's chain in the current session. Select a wallet, then retry; do NOT re-quote.",
  unbindable_param:
    "Collateral withdrawal blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/** Morpho Blue BORROW: the operation that takes on debt. */
const LEND_BORROW_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Borrow blocked: could not verify a fresh quote. Re-run morpho__market_quote (direction borrow) for this market, then retry.",
  no_session:
    "Borrow blocked: could not verify a fresh quote (no session). Re-run morpho__market_quote (direction borrow) and retry.",
  unresolved_token:
    "Borrow blocked: the market or its loan token could not be resolved on this chain. Re-check the market id and the chain, then retry.",
  no_quote:
    "Borrow blocked: no fresh quote for these exact params. The execute must use EXACTLY the params the quote used, including the market id, the chain, the raw loan-token amount and slippageBps. Call morpho__market_quote (direction borrow) with those params first, then retry. A collateral quote does NOT authorize a borrow: putting collateral in and drawing debt out are different operations, and only the borrow quote checks the resulting health factor.",
  safety_fail:
    "Borrow blocked: the market failed the pre-quote check (outside the allowed oracle/IRM set, insufficient liquidity, or the resulting health factor is below the policy floor). Do not retry the same size; borrow less or add collateral first.",
  wallet_setup:
    "Borrow blocked: the mission is still in setup (no active run), so market writes cannot broadcast yet. Accept and start the mission run, then retry; do NOT re-quote.",
  wallet_scope:
    "Borrow blocked: the selected wallet can't be used. It may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry; do NOT re-quote.",
  wallet_not_selected:
    "Borrow blocked: no wallet is selected (or configured) for this market's chain in the current session. Select a wallet, then retry; do NOT re-quote.",
  unbindable_param:
    "Borrow blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/** Morpho Blue REPAY: the operation that reduces debt. */
const LEND_REPAY_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Repay blocked: could not verify a fresh quote. Re-run morpho__market_quote (direction repay) for this market, then retry.",
  no_session:
    "Repay blocked: could not verify a fresh quote (no session). Re-run morpho__market_quote (direction repay) and retry.",
  unresolved_token:
    "Repay blocked: the market or its loan token could not be resolved on this chain. Re-check the market id and the chain, then retry.",
  no_quote:
    "Repay blocked: no fresh quote for these exact params. The execute must use EXACTLY the params the quote used, including the market id, the chain, the raw amount (or repayFullDebt) and slippageBps. Call morpho__market_quote (direction repay) with those params first, then retry. A borrow quote does NOT authorize a repay, and repaying the wrong amount leaves dust debt behind.",
  safety_fail:
    "Repay blocked: the market failed the pre-quote check. A repay REDUCES risk, so this block is not protecting the wallet: report it and stop rather than retrying.",
  wallet_setup:
    "Repay blocked: the mission is still in setup (no active run), so market writes cannot broadcast yet. Accept and start the mission run, then retry; do NOT re-quote.",
  wallet_scope:
    "Repay blocked: the selected wallet can't be used. It may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry; do NOT re-quote.",
  wallet_not_selected:
    "Repay blocked: no wallet is selected (or configured) for this market's chain in the current session. Select a wallet, then retry; do NOT re-quote.",
  unbindable_param: "Repay blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

/**
 * The map for a gated kind. Written as a lookup rather than another if/else
 * limb: the chain had grown to seven levels, and its SWAP fallback is exactly
 * how a Morpho block would have been worded as a swap. A kind with no entry
 * still falls back to SWAP, which is the historical caller's wording.
 */
const BLOCK_MESSAGES_BY_KIND: Partial<Record<PrequoteKind, Record<GateBlockReason, string>>> = {
  bridge: BRIDGE_BLOCK_MESSAGES,
  redeem: REDEEM_BLOCK_MESSAGES,
  mint: MINT_BLOCK_MESSAGES,
  redeem_py: REDEEM_PY_BLOCK_MESSAGES,
  lp_add: LP_ADD_BLOCK_MESSAGES,
  lp_remove: LP_REMOVE_BLOCK_MESSAGES,
  lend_deposit: LEND_DEPOSIT_BLOCK_MESSAGES,
  lend_withdraw: LEND_WITHDRAW_BLOCK_MESSAGES,
  lend_supply_collateral: LEND_SUPPLY_COLLATERAL_BLOCK_MESSAGES,
  lend_withdraw_collateral: LEND_WITHDRAW_COLLATERAL_BLOCK_MESSAGES,
  lend_borrow: LEND_BORROW_BLOCK_MESSAGES,
  lend_repay: LEND_REPAY_BLOCK_MESSAGES,
};

export function block(reason: GateBlockReason, kind: PrequoteKind): GateDecision {
  const messages = BLOCK_MESSAGES_BY_KIND[kind] ?? SWAP_BLOCK_MESSAGES;
  return { kind: "block", reason, message: messages[reason] };
}
