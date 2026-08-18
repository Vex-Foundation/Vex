/**
 * Morpho protocol handlers - the markets, vaults, portfolio and wallet lanes.
 *
 * Every handler takes the execution context's `abortSignal` and pass it into the
 * client, so an operator Stop reaches the in-flight HTTP read rather than
 * leaving it running with its budget token spent (rules/90, cancellation).
 */

import type { ProtocolHandler } from "../types.js";
import { morphoMarketsDiscover } from "./handlers/markets-discover.js";
import { morphoMarketGet } from "./handlers/market-get.js";
import { morphoVaultsDiscover } from "./handlers/vaults-discover.js";
import { morphoVaultGet } from "./handlers/vault-get.js";
import { morphoPositionsGet } from "./handlers/positions-get.js";
import { morphoMarketsActivity } from "./handlers/markets-activity.js";
import { morphoRewardsGet } from "./handlers/rewards-get.js";
import { morphoRewardsClaim } from "./handlers/rewards-claim.js";
import { morphoWalletBalance } from "./handlers/wallet-balance.js";
import { morphoVaultQuote } from "./handlers/vault-quote.js";
import { morphoVaultDeposit, morphoVaultWithdraw } from "./handlers/vault-execute.js";
import { morphoMarketQuote } from "./handlers/market-quote.js";
import {
  morphoMarketBorrow,
  morphoMarketRepay,
  morphoMarketSupply,
  morphoMarketSupplyCollateral,
  morphoMarketWithdraw,
  morphoMarketWithdrawCollateral,
} from "./handlers/market-execute.js";

export const MORPHO_HANDLERS: Record<string, ProtocolHandler> = {
  "morpho.markets.discover": (params, context) =>
    morphoMarketsDiscover(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  "morpho.market.get": (params, context) =>
    morphoMarketGet(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  "morpho.vaults.discover": (params, context) =>
    morphoVaultsDiscover(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  "morpho.vault.get": (params, context) =>
    morphoVaultGet(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  "morpho.positions.get": (params, context) =>
    morphoPositionsGet(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  "morpho.markets.activity": (params, context) =>
    morphoMarketsActivity(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  "morpho.rewards.get": (params, context) =>
    morphoRewardsGet(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  // No abortSignal: the wallet read is an RPC batch through viem's own transport,
  // which owns its timeout and takes no signal from us.
  "morpho.wallet.balance": (params) => morphoWalletBalance(params),
  "morpho.vault.quote": (params, context) =>
    morphoVaultQuote(params, context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  // The two EXECUTE tools take the full execution context, not just an abort
  // signal: they need the session, the wallet resolution and the wallet policy,
  // and none of those may come from model input.
  "morpho.vault.deposit": morphoVaultDeposit,
  "morpho.vault.withdraw": morphoVaultWithdraw,
  // The BLUE MARKET lane. The quote takes the full context too: a health factor
  // has no meaning without a position, so it resolves the session's SELECTED
  // address to know whose to project. It never resolves a signing wallet.
  "morpho.market.quote": morphoMarketQuote,
  "morpho.market.supplyCollateral": morphoMarketSupplyCollateral,
  "morpho.market.withdrawCollateral": morphoMarketWithdrawCollateral,
  "morpho.market.borrow": morphoMarketBorrow,
  "morpho.market.repay": morphoMarketRepay,
  // The LENDER'S side of the same market: supplying the loan asset to earn the
  // borrow rate, and taking it back out. Same spine, same context, different
  // token and a position that has no health factor at all.
  "morpho.market.supply": morphoMarketSupply,
  "morpho.market.withdraw": morphoMarketWithdraw,
  // The CLAIM lane. Full context like the other writes: it resolves the
  // session's signing wallet, and it takes no wallet parameter precisely so the
  // model cannot name one.
  "morpho.rewards.claim": morphoRewardsClaim,
};
