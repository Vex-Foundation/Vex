/**
 * Indexify handler registry — toolId → handler, consumed by catalog.ts.
 */

import type { ProtocolHandler } from "../types.js";
import {
  indexifySearchHandler,
  indexifyStackHandler,
  indexifyStacksHandler,
  indexifyTokensHandler,
} from "./handlers/discover.js";
import { indexifyCreatorsHandler } from "./handlers/creators.js";
import {
  indexifyHistoryHandler,
  indexifyHoldingsHandler,
  indexifyOrdersHandler,
  indexifyPortfolioHandler,
} from "./handlers/account.js";
import {
  indexifyFeesHandler,
  indexifyOrderResolveHandler,
  indexifyTradeExecuteHandler,
} from "./handlers/trade.js";
import { indexifyStackCreateHandler } from "./handlers/create.js";

export const INDEXIFY_HANDLERS: Readonly<Record<string, ProtocolHandler>> = {
  "indexify.stacks": indexifyStacksHandler,
  "indexify.search": indexifySearchHandler,
  "indexify.stack": indexifyStackHandler,
  "indexify.tokens": indexifyTokensHandler,
  "indexify.creators": indexifyCreatorsHandler,
  "indexify.portfolio": indexifyPortfolioHandler,
  "indexify.holdings": indexifyHoldingsHandler,
  "indexify.orders": indexifyOrdersHandler,
  "indexify.history": indexifyHistoryHandler,
  "indexify.fees": indexifyFeesHandler,
  "indexify.trade_execute": indexifyTradeExecuteHandler,
  "indexify.order_resolve": indexifyOrderResolveHandler,
  "indexify.stack_create": indexifyStackCreateHandler,
};
