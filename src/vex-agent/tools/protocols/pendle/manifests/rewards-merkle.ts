import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";

/**
 * `pendle.rewards.merkle` — merkle-distributed rewards, read-only forever.
 *
 * TWO CONTRACTS ARE ENCODED IN THIS MANIFEST, not just in the handler:
 *   - the description states that Vex cannot claim these, because the public
 *     endpoint publishes no merkle proof (live-verified). An agent that saw a
 *     claimable balance and looked for a claim tool would loop;
 *   - the scope param stays the SINGULAR `chain`, not the `chainIds` list the two
 *     Pendle read tools take (SPEC §2.7 item 18). The handler narrows to at most
 *     one chain, so a list key would advertise a multi-chain filter the code does
 *     not have; and omission already means "every chain", which is what an agent
 *     would reach for `chainIds: "all"` to say. The description states both halves
 *     so the semantic is readable without opening the handler;
 *   - there is NO wallet param. The wallet is the session's own, resolved in the
 *     privileged path. A wallet key here would let model output aim the read at
 *     a third party (rules/06), and the protocol runtime refuses undeclared
 *     keys, so its absence is the enforcement.
 *
 * Contract only; registration, passage and facet live where `market-get.ts` names them.
 */
export const PENDLE_REWARDS_MERKLE_TOOL: ProtocolToolManifest = {
  toolId: "pendle.rewards.merkle",
  publicName: "pendle__merkle_rewards_list",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "List the merkle-distributed Pendle rewards accrued to the session wallet — per reward token, with the raw amount " +
    "and its decimals, the accrual window, the chain, and a USD value where the token can be priced. These are " +
    "campaign and incentive rewards distributed off-market, separate from the YT interest and LP rewards that " +
    "pendle__rewards_claim sweeps on-chain. Use this when the user asks about unclaimed Pendle incentives, campaign or " +
    "points rewards, or what a Pendle position has earned on top of its rate; use pendle__rewards_claim instead when they " +
    "want Vex to actually collect the on-chain interest and LP rewards, which is a different pot. RETURNS " +
    "`summary`, `wallet`, `chainFilter`, `asOf`, `note`, `claimableCount`, `claimableShown`, `claimedCount`, " +
    "`claimedShown`, `truncated`, `totalClaimableUsd`, `totalIsPartial`, `pricedRows`, `unpricedRows`, an optional " +
    "`totalNote` and `amountsNote`, `nextStep`, and the two row lists `claimable` and `claimed`, each row carrying " +
    "`chain`, `chainId`, `token` with its address, symbol and decimals, `amount` as a raw value with its decimals " +
    "and an exact human figure, `valueUsd`, and the accrual `window` with its `from` and `to`. Read " +
    "`totalIsPartial` before quoting a total: rows Pendle could not price are counted but not valued. " +
    "VEX CANNOT CLAIM THEM: Pendle's public API publishes the amount but not the merkle " +
    "proof a claim transaction needs, so no Vex tool can ever execute this claim — claim at app.pendle.finance " +
    "instead. Reads the session's own wallet only; it takes no wallet address. Rows beyond the cap are reported " +
    "in `truncated` and are not reachable by paging; narrow with `chain` instead. Read-only.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chain",
      type: "string",
      description:
        "Optional chain slug or numeric id (e.g. 'ethereum', 42161) to narrow the list to ONE chain. Omit it to see every chain's rewards in one call — there is no chainIds list here, and no 'all' literal to pass. An unsupported chain is rejected by name.",
    },
  ],
  exampleParams: { chain: "ethereum" },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.rewards.merkle"],
};
