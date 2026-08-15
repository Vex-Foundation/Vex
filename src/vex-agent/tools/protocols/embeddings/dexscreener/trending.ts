/**
 * Retrieval metadata for DexScreener trending / attention / narrative tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `dexscreener/manifests/trending.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_TRENDING_DISCOVERY = {
  "dexscreener.profiles": {
    embeddingText: embeddingText(
      `Read the latest token PROFILE METADATA published on DexScreener — descriptions, websites, socials, and profile update information. This is not a token-creation, launch, or newly listed pair feed. ` +
      `Use this when the user asks to browse DexScreener profile metadata or project links. Treat every field as a provider label, not verified identity or contract-safety evidence. ` +
      `Example queries: latest token profile metadata, project websites on dexscreener, browse token descriptions, token profile links, recent profile information.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.profiles.recent": {
    embeddingText: embeddingText(
      `Read RECENTLY UPDATED DexScreener token-profile metadata, including updatedAt and DexScreener's community-takeover label. It does not show when a token or pair was created. ` +
      `Use this when the user wants a change feed of profile metadata rather than the plain latest-profiles list. This endpoint is live but undocumented; provider behavior may change, and its labels are not verified identity or safety evidence. ` +
      `Example queries: recently updated profiles, what profile metadata changed on base, who refreshed their dexscreener profile, latest profile changes, recent project-link updates.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.boosts": {
    embeddingText: embeddingText(
      `Get the latest tokens that received paid boosts on DEX Screener across all chains — Ethereum, Solana, BNB, Base, Arbitrum and others. ` +
      `Use this when the user wants to see DexScreener paid-visibility labels, newly boosted tokens, or recent boost activity. A boost is promotion, never organic demand, legitimacy, or contract safety. Follow with dexscreener.orders for one exact token. ` +
      `Example queries: latest boosted tokens, what's being promoted, recent paid boosts, new memecoin boosts, who's buying visibility, fresh boost activity, who's paying for promo.`,
    ),
    aliases: ["latest paid token boosts", "recent boost activity", "newly boosted tokens"],
    exampleIntents: [
      "show the latest paid token boosts across dexscreener",
      "browse tokens that most recently received a paid boost",
    ],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.boosts.top": {
    embeddingText: embeddingText(
      `Tokens with the most active boosts on DEX Screener, ranked by total boost amount — heaviest paid attention spend right now. ` +
      `Use this when the user wants the top-promoted tokens or most active paid visibility. Boost totals are provider promotion units, not token demand, money spent, legitimacy, or safety. ` +
      `Example queries: top boosted tokens, most promoted coins, highest paid visibility, biggest boost spenders, top promo tokens by amount.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.communityTakeovers": {
    embeddingText: embeddingText(
      `Get the latest tokens carrying DexScreener's community-takeover (CTO) LABEL. This is a provider classification, not proof that ownership, admin keys, or contract control changed. ` +
      `Use this when the user explicitly wants DexScreener CTO-labeled rows or claim dates. Never infer safety, community control, or future price action from the label. ` +
      `Example queries: latest dexscreener cto labels, community takeover labeled tokens, recent cto claim dates, browse cto provider labels.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.attention": {
    embeddingText: embeddingText(
      `Merged ATTENTION signal — combines token-profiles and paid boosts into one ranked, deduplicated list, sorted by boost spend then profile presence. This is a synthetic "who's buying visibility" view, NOT the official trending narratives feed. ` +
      `Use this when the user explicitly wants Vex's synthetic merge of DexScreener profile presence and paid promotion. It is not an organic, genuine, or provider-ranked attention signal. ` +
      `Example queries: show Vex synthetic profile plus boost merge, combine profile presence with paid boosts, synthetic dexscreener attention merge.`,
    ),
    aliases: ["synthetic profile boost merge", "vex synthetic attention merge"],
    exampleIntents: ["explicitly combine dexscreener profiles and boosts into Vex's synthetic merge"],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.trending": {
    embeddingText: embeddingText(
      `DEX Screener TRENDING NARRATIVES feed — themes/metas with aggregate market cap, liquidity, volume, token count, and change windows. Returns NARRATIVES, not individual tokens; always drill into a selected slug with dexscreener.meta. This endpoint is live but undocumented, and ordering is influenced by engagement and paid promotion such as boosts, alongside verified information and audits, rather than organic demand. ` +
      `Use this when the user asks which themes or narratives are hot; it is the first hop. Do not call the ordering genuine, organic, complete, or a safety ranking. ` +
      `Example queries: what's trending in crypto, hot narratives right now, which meta is moving, top crypto narratives.`,
    ),
    // Lexical-scorer metadata (aliases weight 5, exampleIntents weight 6).
    // "trending meme tokens" is deliberately here: it is the canonical generic
    // trending ask, and its correct first hop IS this feed (find the hot meta,
    // then drill into its tokens with dexscreener.meta). Without it the
    // ubiquitous token "tokens" let launchpad browsers outscore the trending
    // surface on generic queries — the discovery-golden fixture pins this.
    aliases: ["trending narratives", "hot metas", "trending crypto themes"],
    exampleIntents: [
      "trending meme tokens",
      "what narratives are hot right now",
      "which meta is pumping",
    ],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.meta": {
    embeddingText: embeddingText(
      `Drill into ONE trending narrative/meta by its slug from dexscreener.trending (e.g. "knockoff-legends") — returns aggregate metrics plus DexScreener-indexed pairs assigned to it. This endpoint is live but undocumented, and the category is engagement/promotion-influenced rather than organic or complete. ` +
      `Use this when the user selects a theme after dexscreener.trending and wants the pairs inside it. The slug is a NARRATIVE slug, never a chain slug. Results are not token identity or contract-safety evidence. ` +
      `Example queries: show tokens in the ai narrative, what's in the dog meta, pairs for this trending theme, drill into knockoff legends, tokens in this narrative.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 8;
if (Object.keys(DEXSCREENER_TRENDING_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_TRENDING_DISCOVERY has ${Object.keys(DEXSCREENER_TRENDING_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
