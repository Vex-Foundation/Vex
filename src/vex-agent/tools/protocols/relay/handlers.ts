/**
 * Relay protocol handlers - aggregates the module handler maps.
 */

import type { ProtocolHandler } from "../types.js";
import { RELAY_BRIDGE_HANDLERS } from "./handlers/bridge.js";

export const RELAY_HANDLERS: Record<string, ProtocolHandler> = {
  ...RELAY_BRIDGE_HANDLERS,
};
