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
import { morphoWalletBalance } from "./handlers/wallet-balance.js";
import { morphoVaultQuote } from "./handlers/vault-quote.js";
import { morphoVaultDeposit, morphoVaultWithdraw } from "./handlers/vault-execute.js";

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
};
