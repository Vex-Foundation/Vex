/**
 * DexScreener protocol manifest - aggregates all module manifests.
 *
 * 4 modules, 18 tools, every one of them reaching DexScreener's own website
 * channels:
 *
 *  - `manifests/screening.ts`: the six leaderboard boards, the launchpad
 *    board, the chain catalog and the token screen;
 *  - `manifests/resolve.ts`: the single-pair snapshot, the spotlight feeds,
 *    the explicit-identity batch, the pair search and one token's pools;
 *  - `manifests/market-context.ts`: the narratives;
 *  - `manifests/deep-dive.ts`: one pool in depth - its safety report, its
 *    candles, its trades and its trader leaderboard. The only tools in this
 *    namespace that reach contract-level and wallet-level facts.
 *
 * THE PUBLIC-API SURFACE IS GONE. The 12 tools that spoke
 * `api.dexscreener.com` were retired whole in S3.5 (owner decision D-DS2:
 * total and alias-free). No deprecation alias row was created and none is
 * wanted: a call to one of the nine retired public names falls through to the
 * ordinary unknown-tool path. Three identities were RECLAIMED rather than
 * retired, because the same user question is still answered, now off the
 * website channel: `dexscreener.search`, `dexscreener.tokenPairs` and
 * `dexscreener.trending`. Their toolIds and publicNames are unchanged, which
 * is what keeps every durable row and audit record meaningful without a
 * migration (`tool-surface-spec/identity-and-migration.md` section 1).
 *
 * All read-only. No API key required. Multi-chain.
 */

import type { ProtocolToolManifest } from "../types.js";
import { SCREENING_TOOLS } from "./manifests/screening.js";
import { RESOLVE_TOOLS } from "./manifests/resolve.js";
import { MARKET_CONTEXT_TOOLS } from "./manifests/market-context.js";
import { DEEP_DIVE_TOOLS } from "./manifests/deep-dive.js";

export const DEXSCREENER_TOOLS: readonly ProtocolToolManifest[] = [
  ...SCREENING_TOOLS,
  ...RESOLVE_TOOLS,
  ...MARKET_CONTEXT_TOOLS,
  ...DEEP_DIVE_TOOLS,
];
