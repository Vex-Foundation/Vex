/**
 * Solana/Jupiter protocol manifest - retained tools only.
 *
 * Source-of-truth: src/tools/solana-ecosystem/jupiter/
 * Deferred features (perps, orders, stake, send, studio, account, history)
 * are removed until new shelf backing is implemented.
 */

import type { ProtocolToolManifest } from "../types.js";
import { CORE_TOOLS } from "./manifests/core.js";
import { SWAP_TOOLS } from "./manifests/swap.js";
import { PREDICT_TOOLS } from "./manifests/predict.js";
import { LEND_TOOLS } from "./manifests/lend.js";
import { LEND_BORROW_TOOLS } from "./manifests/lend-borrow.js";

export const SOLANA_JUPITER_TOOLS: readonly ProtocolToolManifest[] = [
  ...CORE_TOOLS,
  ...SWAP_TOOLS,
  ...PREDICT_TOOLS,
  ...LEND_TOOLS,
  ...LEND_BORROW_TOOLS,
];
