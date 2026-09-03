/**
 * Khalani protocol handlers - aggregator.
 * Split into modules: read (chains/tokens/quotes/orders), bridge (mutating).
 */

import type { ProtocolHandler } from "../types.js";
import { READ_HANDLERS } from "./handlers/read.js";
import { BRIDGE_HANDLERS } from "./handlers/bridge.js";

export const KHALANI_HANDLERS: Record<string, ProtocolHandler> = {
  ...READ_HANDLERS,
  ...BRIDGE_HANDLERS,
};
