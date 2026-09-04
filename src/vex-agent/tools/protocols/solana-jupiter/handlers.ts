/**
 * Solana/Jupiter protocol handlers - aggregator.
 * Split into modules: core (prices/tokens/swap), predict, predict-orders,
 * predict-social, lend (Earn), lend-borrow (Borrow).
 */

import type { ProtocolHandler } from "../types.js";
import { CORE_HANDLERS } from "./handlers/core.js";
import { PREDICT_HANDLERS } from "./handlers/predict.js";
import { PREDICT_ORDER_HANDLERS } from "./handlers/predict-orders.js";
import { PREDICT_SOCIAL_HANDLERS } from "./handlers/predict-social.js";
import { LEND_HANDLERS } from "./handlers/lend.js";
import { LEND_BORROW_HANDLERS } from "./handlers/lend-borrow.js";

export const SOLANA_JUPITER_HANDLERS: Record<string, ProtocolHandler> = {
  ...CORE_HANDLERS,
  ...PREDICT_HANDLERS,
  ...PREDICT_ORDER_HANDLERS,
  ...PREDICT_SOCIAL_HANDLERS,
  ...LEND_HANDLERS,
  ...LEND_BORROW_HANDLERS,
};
