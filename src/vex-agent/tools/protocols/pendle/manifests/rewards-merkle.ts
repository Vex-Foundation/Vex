import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";

/**
 * `pendle.rewards.merkle` — merkle-distributed rewards, read-only forever.
 *
 * TWO CONTRACTS ARE ENCODED IN THIS MANIFEST, not just in the handler:
 *   - the description states that Vex cannot claim these, because the public
 *     endpoint publishes no merkle proof (live-verified). An agent that saw a
 *     claimable balance and looked for a claim tool would loop;
 *   - there is NO wallet param. The wallet is the session's own, resolved in the
 *     privileged path. A wallet key here would let model output aim the read at
 *     a third party (rules/06), and the protocol runtime refuses undeclared
 *     keys, so its absence is the enforcement.
 *
 * Contract only; registration, passage and facet live where `market-get.ts` names them.
 */
export const PENDLE_REWARDS_MERKLE_TOOL: ProtocolToolManifest = {
  toolId: "pendle.rewards.merkle",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "List the merkle-distributed Pendle rewards accrued to the session wallet — per reward token, with the raw amount " +
    "and its decimals, the accrual window, the chain, and a USD value where the token can be priced. These are " +
    "campaign and incentive rewards distributed off-market, separate from the YT interest and LP rewards that " +
    "pendle.claim sweeps on-chain. VEX CANNOT CLAIM THEM: Pendle's public API publishes the amount but not the merkle " +
    "proof a claim transaction needs, so no Vex tool can ever execute this claim — claim at app.pendle.finance " +
    "instead. Reads the session's own wallet only; it takes no wallet address. Read-only.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chain",
      type: "string",
      description:
        "Optional chain slug or numeric id (e.g. 'ethereum', 42161) to narrow the list. Omit to see every chain's rewards in one call. An unsupported chain is rejected by name.",
    },
  ],
  exampleParams: { chain: "ethereum" },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.rewards.merkle"],
};
