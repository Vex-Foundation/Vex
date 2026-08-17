import type { ProtocolNamespaceNavigation } from "./types.js";
import { KHALANI_NAVIGATION } from "./entries-market/khalani.js";
import { RELAY_NAVIGATION } from "./entries-market/relay.js";
import { KYBERSWAP_NAVIGATION } from "./entries-market/kyberswap.js";
import { UNISWAP_NAVIGATION } from "./entries-market/uniswap.js";
import { MORPHO_NAVIGATION } from "./entries-market/morpho.js";
import { PENDLE_NAVIGATION } from "./entries-market/pendle.js";
import { SOLANA_NAVIGATION } from "./entries-market/solana.js";
import { DEXSCREENER_NAVIGATION } from "./entries-market/dexscreener.js";
import { VIRTUALS_NAVIGATION } from "./entries-market/virtuals.js";
import { TRENCH_NAVIGATION } from "./entries-market/trench.js";

export const MARKET_PROTOCOL_NAVIGATION: readonly ProtocolNamespaceNavigation[] = [
  KHALANI_NAVIGATION,
  RELAY_NAVIGATION,
  KYBERSWAP_NAVIGATION,
  UNISWAP_NAVIGATION,
  MORPHO_NAVIGATION,
  PENDLE_NAVIGATION,
  SOLANA_NAVIGATION,
  DEXSCREENER_NAVIGATION,
  VIRTUALS_NAVIGATION,
  TRENCH_NAVIGATION,
] as const;
