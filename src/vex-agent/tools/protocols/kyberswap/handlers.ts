/**
 * KyberSwap protocol handlers - aggregator.
 *
 * One module: swap (chains/tokens/swap). Limit-order + zap handlers were
 * deleted (Agent Scan plan §4.2/§1.4-5).
 */

import type { ProtocolHandler } from "../types.js";
import { SWAP_HANDLERS } from "./handlers/swap.js";

export const KYBERSWAP_HANDLERS: Record<string, ProtocolHandler> = {
  ...SWAP_HANDLERS,
};
