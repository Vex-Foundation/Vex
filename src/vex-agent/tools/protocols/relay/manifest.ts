/**
 * Relay protocol manifest - keyless cross-chain bridge (quote + bridge).
 * The only bridge to/from Robinhood Chain (Khalani does not cover 4663).
 */

import type { ProtocolToolManifest } from "../types.js";
import { RELAY_BRIDGE_TOOLS } from "./manifests/bridge.js";

export const RELAY_TOOLS: readonly ProtocolToolManifest[] = [...RELAY_BRIDGE_TOOLS];
