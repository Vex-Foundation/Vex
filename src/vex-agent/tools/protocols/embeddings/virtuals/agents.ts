/**
 * Retrieval metadata for Virtuals Protocol agent-token tools.
 *
 * Source-of-truth for the lexical scorer and the dense-retrieval pipeline.
 * Manifest at `virtuals/manifests/agents.ts` references entries by `toolId`.
 * Vectors are (re)built by the boot reconcile / `tool-reembed`; passages live
 * in code. All four tools are read-only (no mutating action verb required).
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { VIRTUALS_CHAIN_LABELS } from "../../virtuals/discovery-text.js";

export const VIRTUALS_AGENTS_DISCOVERY = {
  "virtuals.list": {
    embeddingText: embeddingText(
      `Browse Virtuals Protocol agent tokens on one chain — Robinhood, Base, Solana, or Ethereum — ranked by market cap, volume, newest, or most recent graduation. ` +
      `Use this when the user wants to explore, screen, or compare Virtuals agent tokens: what is trending, what just launched, or which agents have the deepest market. ` +
      `Each row carries status (bonding-curve pre-graduation versus graduated), holder count, concentration, market cap in VIRTUAL, and the anti-sniper buy-tax window. ` +
      `Example queries: list virtuals agents on robinhood, top agent tokens by market cap, newest virtuals launches, trending agents on base, screen robinhood agent tokens.`,
    ),
    aliases: ["virtuals agents", "agent tokens", "list virtuals", "robinhood agent tokens", "virtuals screener"],
    exampleIntents: ["list virtuals agents on robinhood", "top agent tokens by market cap", "newest virtuals launches"],
    chains: VIRTUALS_CHAIN_LABELS,
  },

  "virtuals.get": {
    embeddingText: embeddingText(
      `Get the full profile for one Virtuals agent token by the numeric id that virtuals.list returns — market cap and fully-diluted value in VIRTUAL, holders, concentration, graduation state, launch details, a bounded tokenomics summary, and the exact venue that trades it. ` +
      `Use this when the user names a specific Virtuals agent or id and wants deep detail before acting, or to check the anti-sniper buy-tax window before a buy. ` +
      `Example queries: get virtuals agent 96200, details for the VEX agent token, is the anti-sniper window still active, which venue trades this agent, tokenomics for this virtuals agent.`,
    ),
    aliases: ["virtuals agent detail", "agent token profile", "virtuals get", "agent id lookup", "anti-sniper window"],
    exampleIntents: ["get virtuals agent 96200", "details for the VEX agent token", "check anti-sniper window"],
    chains: VIRTUALS_CHAIN_LABELS,
  },

  "virtuals.graduations": {
    embeddingText: embeddingText(
      `List the Virtuals agent tokens that most recently graduated on one chain — Robinhood, Base, Solana, or Ethereum — newest first, each with its live anti-sniper buy-tax window status. ` +
      `Use this when the user wants the freshly graduated feed: what just moved from the bonding curve to a locked liquidity pool, and whether the sniper-protection window is still active so a buy would be heavily taxed right now. ` +
      `Example queries: what just graduated on robinhood, recent virtuals graduations, newly graduated agent tokens on base, latest agents to graduate, fresh graduations feed.`,
    ),
    aliases: ["recent graduations", "just graduated", "virtuals graduations", "newly graduated agents", "graduation feed"],
    exampleIntents: ["what just graduated on robinhood", "recent virtuals graduations", "newly graduated agent tokens"],
    chains: VIRTUALS_CHAIN_LABELS,
  },

  "virtuals.geneses": {
    embeddingText: embeddingText(
      `Browse the Virtuals genesis launch calendar — the points-sale events that precede agent-token launches, mostly on Base, newest first, with start and end windows, participant counts, and the linked agent. ` +
      `Use this when the user wants to see upcoming or past Virtuals genesis launches, track a launch schedule, or find which agents came through a genesis sale. Suspicious far-future dates are treated as spam. ` +
      `Example queries: virtuals genesis calendar, upcoming agent launches, recent genesis sales, what launched through genesis, virtuals launch schedule on base.`,
    ),
    aliases: ["genesis calendar", "virtuals launches", "launch schedule", "genesis sales", "upcoming agent launches"],
    exampleIntents: ["virtuals genesis calendar", "upcoming agent launches", "recent genesis sales"],
    chains: VIRTUALS_CHAIN_LABELS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(VIRTUALS_AGENTS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `VIRTUALS_AGENTS_DISCOVERY has ${Object.keys(VIRTUALS_AGENTS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
