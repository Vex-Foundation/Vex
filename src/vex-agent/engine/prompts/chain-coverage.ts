/**
 * CHAIN COVERAGE - which venues exist on which chain, as one static map.
 *
 * The agent's recurring failure this section answers: it plans a whole action
 * on a chain it can reach with one venue and cannot leave, or assumes a venue
 * it has seen on Base exists everywhere. The venue half of that question is
 * fully knowable at build time, so it is answered here rather than being
 * rediscovered by a failed tool call.
 *
 * KV-CACHE SAFE BY CONSTRUCTION: every value below is derived from a registry
 * compiled into the build, so the rendered text is byte-identical for the whole
 * lifetime of a build. NO live number, no snapshot timestamp and no fetched
 * list may enter this module. The LIVE bridge truth (Khalani's real-time chain
 * list, the Relay health gate) belongs to the turn-state layer in
 * `protocols.ts`, which is re-rendered per turn precisely because it moves.
 *
 * The bridge column here is therefore a STATIC PINNED SNAPSHOT and says so in
 * the rendered text: it tells the agent where to expect reach, and the turn
 * state tells it what is true right now.
 *
 * `protocols.ts` renders it once, inside the static prefix.
 */

import { getKyberChains } from "@tools/kyberswap/chains.js";
import { MORPHO_CHAINS } from "@tools/morpho/chains.js";
import { PENDLE_CHAIN_REGISTRY } from "@tools/pendle/chains.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";

/**
 * Khalani-served EVM chain ids, pinned 2026-08-17 from the live `/v1/chains`
 * registry. A PIN, not a cache: this section must render identically on every
 * turn of a build, and the live list is served to the model separately in the
 * turn state. Re-pin this array deliberately, with a new date, when the owner
 * accepts a coverage change - never wire it to a fetch.
 */
const KHALANI_PINNED_EVM_CHAIN_IDS: readonly number[] = [
  1, 10, 56, 130, 137, 143, 324, 2741, 5000, 8453, 16661, 42161, 43114, 59144, 80094, 747474,
];

const khalaniPinned: ReadonlySet<number> = new Set(KHALANI_PINNED_EVM_CHAIN_IDS);
const morphoChainIds: ReadonlySet<number> = new Set(MORPHO_CHAINS.map((c) => c.chainId));
const pendleChainIds: ReadonlySet<number> = new Set(PENDLE_CHAIN_REGISTRY.map((c) => c.chainId));

/** What a chain can be used FOR, in the order the agent needs to read it. */
function venueLabels(chainId: number): string[] {
  const labels: string[] = ["swap"];
  if (morphoChainIds.has(chainId)) labels.push("lend");
  if (pendleChainIds.has(chainId)) labels.push("fixed yield");
  if (chainId === TRENCH_CHAIN_ID) labels.push("launch");
  return labels;
}

/**
 * The bridge annotation. Two states only, because they are the two a STATIC
 * table can honestly claim: a chain the pinned Khalani snapshot covers (both
 * bridges may serve it) and one it does not (Relay is the only candidate).
 * "Neither" is deliberately absent - proving it needs Relay's live `/chains`,
 * which is exactly the fact this module refuses to embed.
 */
function bridgeLabel(chainId: number): string {
  return khalaniPinned.has(chainId) ? "khalani+relay" : "RELAY ONLY";
}

function chainLine(name: string, chainId: number): string {
  return `- ${name} (${chainId}): ${venueLabels(chainId).join(", ")} | bridge ${bridgeLabel(chainId)}`;
}

/**
 * The rendered CHAIN COVERAGE section. Pure, deterministic, and free of live
 * data - call it anywhere in the constant prompt layer.
 */
export function buildChainCoveragePrompt(): string {
  const lines: string[] = [];

  // `##` matches the section heading discipline of the static prefix in
  // `protocols.ts`, which is the only place this section renders.
  lines.push("## Chain Coverage");
  lines.push(
    "Before planning an action on a chain, confirm you can REACH it and LEAVE it: the venues per "
    + "chain are listed below and do not change within a session, while live bridge reach is in "
    + "the turn state. A chain you can swap on but cannot bridge off is a position you can enter "
    + "and not exit, so check the bridge column before committing funds, not after.",
  );
  lines.push(
    "Bridge column: `khalani+relay` means both bridges are expected to serve the chain and the "
    + "router picks one automatically; `RELAY ONLY` means Khalani does not serve it and every "
    + "bridge goes through Relay. The column is a pinned snapshot, so confirm a route by quoting "
    + "before relying on it.",
  );

  const evmChains = [...getKyberChains()].sort((a, b) => a.chainId - b.chainId);
  for (const chain of evmChains) {
    lines.push(chainLine(chain.name, chain.chainId));
  }
  lines.push("- Solana: swap, lend via `solana.*` (Jupiter). Not an EVM chain and not in the table above; its bridge reach is in the turn state.");

  return lines.join("\n");
}
