/**
 * Virtuals Protocol manifest - agent-token intelligence module.
 *
 * Read-only discovery surface for Virtuals agent tokens (Robinhood, Base,
 * Solana, Ethereum). No mutating tools: trades execute through the existing
 * venue namespaces named by each result's `tradingRoute` hint.
 */

import type { ProtocolToolManifest } from "../types.js";
import { VIRTUALS_AGENTS_TOOLS } from "./manifests/agents.js";

export const VIRTUALS_TOOLS: readonly ProtocolToolManifest[] = [...VIRTUALS_AGENTS_TOOLS];
