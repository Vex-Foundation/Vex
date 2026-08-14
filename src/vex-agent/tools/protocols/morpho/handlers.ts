/**
 * Morpho protocol handlers - the markets, vaults and portfolio lanes.
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
};
