/**
 * Pendle read handlers — discovery (pendle.yields) + valuation
 * (pendle.position.value). Read-only: no wallet signing, no mutations.
 *
 * Both are multichain: `pendle.yields` merges the 11 Pendle chains (or one when a
 * `chain` param is given) into a single ranked list with per-row chain labels;
 * `pendle.position.value` projects EVERY chain the dashboard returns. Every
 * provider response is untrusted → validated by the client, then narrowed again
 * through the trusted-fields projector boundary before the model sees it.
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import { getPendleClient } from "@tools/pendle/client.js";
import {
  PENDLE_SUPPORTED_CHAIN_IDS,
  pendleChainSlug,
  resolvePendleChainId,
} from "@tools/pendle/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { num, str, ok, fail } from "../../handler-helpers.js";
import type { PendleAsset, PendleMarket } from "@tools/pendle/types.js";
import {
  compareMarketsBy,
  projectMarket,
  projectLpPositions,
  projectPtPositions,
  type ProjectedMarket,
} from "../projectors.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Model-facing failure detail — code-keyed + bounded, never upstream text. */
function failureDetail(toolId: string, err: unknown): string {
  logger.warn("pendle.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
  if (err instanceof VexError) return err.hint ? `${err.code}: ${err.hint}` : err.code;
  return "unexpected error";
}

function clampLimit(requested: number | undefined): number {
  if (requested !== undefined && requested > 0) return Math.min(Math.floor(requested), MAX_LIMIT);
  return DEFAULT_LIMIT;
}

/** A projected market row labeled with the chain it lives on. */
type ChainMarketRow = ProjectedMarket & { chain: string };

/** Per-chain market count (or an error marker) for the merged summary. */
interface ChainMarketCount {
  chain: string;
  markets: number;
  error?: true;
}

async function pendleYields(p: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
  const sortRaw = str(p, "sort").trim().toLowerCase();
  const sort = sortRaw === "apy" ? "apy" : "liquidity";
  const limit = clampLimit(num(p, "limit"));
  const chainRaw = str(p, "chain").trim().toLowerCase();

  // Resolve the target chain set: a specific chain, or all 11 when omitted/"all".
  let targetChainIds: readonly number[];
  if (chainRaw === "" || chainRaw === "all") {
    targetChainIds = PENDLE_SUPPORTED_CHAIN_IDS;
  } else {
    const resolved = resolvePendleChainId(chainRaw);
    if (resolved === undefined) {
      return fail(`Pendle does not support chain "${chainRaw}". Supported: ${PENDLE_SUPPORTED_CHAIN_IDS.map((id) => pendleChainSlug(id)).join(", ")}.`);
    }
    targetChainIds = [resolved];
  }

  const client = getPendleClient();
  const rows: ChainMarketRow[] = [];
  const chainCounts: ChainMarketCount[] = [];

  // Fetch per chain, FAIL-SOFT: a single chain's outage never blanks the view.
  for (const chainId of targetChainIds) {
    const slug = pendleChainSlug(chainId) ?? String(chainId);
    try {
      const markets = await client.getActiveMarkets(chainId);
      for (const m of markets) rows.push({ chain: slug, ...projectMarket(m) });
      chainCounts.push({ chain: slug, markets: markets.length });
    } catch (err) {
      logger.warn("pendle.yields.chain_failed", {
        chain: slug,
        code: err instanceof VexError ? err.code : "UNEXPECTED",
      });
      chainCounts.push({ chain: slug, markets: 0, error: true });
    }
  }

  // Sort the MERGED set by the requested key, then apply the limit POST-merge so a
  // deep chain cannot crowd out the single best market elsewhere.
  rows.sort(compareMarketsBy(sort));
  const limited = rows.slice(0, limit);

  return ok({
    scope: chainRaw === "" || chainRaw === "all" ? "all" : (pendleChainSlug(targetChainIds[0]!) ?? chainRaw),
    sort,
    count: limited.length,
    totalMarkets: rows.length,
    chainCounts,
    markets: limited,
  });
}

async function pendlePositionValue(
  _p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ReturnType<typeof ok>> {
  let wallet: string;
  try {
    wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return fail(`Pendle positions unavailable — no EVM wallet selected (${failureDetail("pendle.position.value", err)})`);
  }

  try {
    const client = getPendleClient();
    // Positions are grouped per chain; the asset catalogue is per chain too, so
    // it is fetched INSIDE the loop — only for chains this wallet actually holds
    // a position on, and each one is TTL-cached per URL. A chain whose markets or
    // assets cannot be read PROPAGATES (same as the pre-existing per-chain
    // markets read): reporting an unpriceable position as $0 would be a lie.
    const positionsByChain = await client.getPositions(wallet);

    const positions: Array<Record<string, unknown>> = [];
    for (const chainPos of positionsByChain) {
      const slug = pendleChainSlug(chainPos.chainId);
      if (!slug) continue; // only chains in the Pendle registry
      // Chain-scoped market + asset maps (no cross-chain address collisions).
      const [markets, assets] = await Promise.all([
        client.getActiveMarkets(chainPos.chainId),
        client.getAssetsForChain(chainPos.chainId),
      ]);
      const marketByAddress = new Map<string, PendleMarket>();
      for (const m of markets) marketByAddress.set(m.address.toLowerCase(), m);
      const assetByAddress = new Map<string, PendleAsset>();
      for (const a of assets) {
        if (a.chainId === null || a.chainId === chainPos.chainId) {
          assetByAddress.set(a.address.toLowerCase(), a);
        }
      }
      // PT legs (fixed-yield principal) + LP legs (liquidity) from the SAME
      // dashboard response, each tagged with `kind` so the model can tell them
      // apart. LP legs value at the dashboard/spot LP price and flag matured markets.
      const projectedPt = projectPtPositions(chainPos.openPositions, marketByAddress, assetByAddress);
      for (const pos of projectedPt) positions.push({ chain: slug, kind: "pt", ...pos });
      const projectedLp = projectLpPositions(chainPos.openPositions, marketByAddress, assetByAddress);
      for (const pos of projectedLp) positions.push({ chain: slug, kind: "lp", ...pos });
    }

    const totalValueUsd = positions.reduce((sum, pos) => sum + ((pos.valueUsd as number | null) ?? 0), 0);
    const redeemableCount = positions.filter((pos) => pos.redeemable === true).length;
    const lpCount = positions.filter((pos) => pos.kind === "lp").length;

    return ok({
      wallet,
      count: positions.length,
      redeemableCount,
      lpCount,
      totalValueUsd,
      positions,
    });
  } catch (err) {
    return fail(`Pendle positions unavailable (${failureDetail("pendle.position.value", err)})`);
  }
}

export const PENDLE_READ_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.yields": (p) => pendleYields(p),
  "pendle.position.value": (p, ctx) => pendlePositionValue(p, ctx),
};
