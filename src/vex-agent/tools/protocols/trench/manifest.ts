/**
 * Trench Express manifest — bonding-curve launchpad on Robinhood Chain (4663).
 *
 * P1 read surface only: browse tokens, search, per-token trade tape, and a
 * read-only launch preview (dry-run of create — no signature, no broadcast).
 * The money path (curve buy/sell) and the real launch flow land in later phases.
 */

import type { ProtocolToolManifest } from "../types.js";
import { TRENCH_TOKENS_TOOLS } from "./manifests/tokens.js";
import { TRENCH_SEARCH_TOOLS } from "./manifests/search.js";
import { TRENCH_TRADES_TOOLS } from "./manifests/trades.js";
import { TRENCH_LAUNCH_PREVIEW_TOOLS } from "./manifests/launch-preview.js";
import { TRENCH_TRADE_TOOLS } from "./manifests/trade.js";
import { TRENCH_IMAGES_TOOLS } from "./manifests/images.js";
import { TRENCH_MY_LAUNCHES_TOOLS } from "./manifests/my-launches.js";

export const TRENCH_TOOLS: readonly ProtocolToolManifest[] = [
  ...TRENCH_TOKENS_TOOLS,
  ...TRENCH_SEARCH_TOOLS,
  ...TRENCH_TRADES_TOOLS,
  ...TRENCH_LAUNCH_PREVIEW_TOOLS,
  ...TRENCH_TRADE_TOOLS,
  ...TRENCH_IMAGES_TOOLS,
  ...TRENCH_MY_LAUNCHES_TOOLS,
];
