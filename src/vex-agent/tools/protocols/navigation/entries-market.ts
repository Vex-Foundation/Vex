/**
 * Market-protocol navigation registry.
 *
 * Aggregator only. Each namespace's entry lives in the same-named file under
 * `entries-market/`, one responsibility per file, so adding a protocol is a new
 * file plus one row here instead of an edit inside a single growing array. The
 * public export keeps its name and its order, so no consumer of this module
 * changed.
 *
 * ORDER IS MEANINGFUL: `getGroupedAdvertisedProtocolNavigation` takes each
 * group's label from its FIRST member, and the built prompt renders namespaces
 * in this sequence.
 */

import type { ProtocolNamespaceNavigation } from "./types.js";
import { KHALANI_NAVIGATION } from "./entries-market/khalani.js";
import { RELAY_NAVIGATION } from "./entries-market/relay.js";
import { KYBERSWAP_NAVIGATION } from "./entries-market/kyberswap.js";
import { UNISWAP_NAVIGATION } from "./entries-market/uniswap.js";
import { PENDLE_NAVIGATION } from "./entries-market/pendle.js";
import { SOLANA_NAVIGATION } from "./entries-market/solana.js";
import { DEXSCREENER_NAVIGATION } from "./entries-market/dexscreener.js";
import { VIRTUALS_NAVIGATION } from "./entries-market/virtuals.js";
import { TRENCH_NAVIGATION } from "./entries-market/trench.js";
import { POOLS_NAVIGATION } from "./entries-market/pools.js";

export const MARKET_PROTOCOL_NAVIGATION: readonly ProtocolNamespaceNavigation[] = [
  KHALANI_NAVIGATION,
  RELAY_NAVIGATION,
  KYBERSWAP_NAVIGATION,
  UNISWAP_NAVIGATION,
  PENDLE_NAVIGATION,
  SOLANA_NAVIGATION,
  DEXSCREENER_NAVIGATION,
  VIRTUALS_NAVIGATION,
  TRENCH_NAVIGATION,
  POOLS_NAVIGATION,
] as const;
