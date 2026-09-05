/**
 * Uniswap protocol handlers - aggregates the module handler maps.
 */

import type { ProtocolHandler } from "../types.js";
import { UNISWAP_SWAP_HANDLERS } from "./handlers/swap.js";

export const UNISWAP_HANDLERS: Record<string, ProtocolHandler> = {
  ...UNISWAP_SWAP_HANDLERS,
};
