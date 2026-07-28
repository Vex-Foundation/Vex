/**
 * `pendle.position.value` — every Pendle leg the session wallet holds.
 *
 * PT, YT, LP, SY and cross-chain PT, on every chain, valued and stated. The
 * handler this replaces projected PT and LP only: a YT position the agent can
 * open through `pendle.yt.buy` was one it could never see or exit, and a MATURED
 * PT — the exact position the redeem product exists for — projected as
 * `pt: null, expiry: null, redeemable: false` because the resolver behind it was
 * active-only (G-16, G-18).
 *
 * Maturity now comes from the read lane's `resolveMarketForRead`, which sees
 * matured markets; the frozen mutating resolvers stay active-only.
 */

import { buildAssetMap } from "../market-lookup.js";
import { getPendleReadClient } from "@tools/pendle/read/client.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { PendleAsset } from "@tools/pendle/types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  parsePendlePositionParams,
  type PendlePositionKind,
  type PendlePositionsQuery,
} from "../read-params.js";
import {
  projectPositionLeg,
  projectSyLeg,
  totalPositionValue,
  type ProjectedPositionLeg,
} from "../projectors.js";
import { resolveMarketForRead } from "../market-read.js";
import { countBy, failureDetail, STALENESS_WARNING_MS, type FailedChain } from "./read-shared.js";

/** Per-chain provenance: when Pendle last recomputed the numbers below. */
interface ChainFreshness {
  chain: string;
  dataAsOf: string | null;
  ageHours: number | null;
  stalenessWarning?: string;
}

function chainFreshness(slug: string, updatedAt: string | null, nowMs: number): ChainFreshness {
  const updatedMs = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) {
    return {
      chain: slug,
      dataAsOf: null,
      ageHours: null,
      stalenessWarning:
        "Pendle did not report when this chain's positions were last recomputed — treat these balances as of unknown age.",
    };
  }
  const ageMs = nowMs - updatedMs;
  const freshness: ChainFreshness = {
    chain: slug,
    dataAsOf: new Date(updatedMs).toISOString(),
    ageHours: Math.max(0, Math.round(ageMs / 3_600_000)),
  };
  if (ageMs > STALENESS_WARNING_MS) {
    const days = Math.floor(ageMs / 86_400_000);
    freshness.stalenessWarning =
      `Pendle last recomputed this chain's positions ${days} day${days === 1 ? "" : "s"} ago. ` +
      "Balances and accrued amounts may be well out of date; confirm on-chain before acting on them.";
  }
  return freshness;
}

function selectPositionFields(
  leg: ProjectedPositionLeg,
  fields: PendlePositionsQuery["fields"],
): Record<string, unknown> {
  if (fields === undefined) return { ...leg };
  const kept: Record<string, unknown> = {
    chain: leg.chain,
    kind: leg.kind,
    state: leg.state,
    stateDetermined: leg.stateDetermined,
    ...(leg.stateNote === undefined ? {} : { stateNote: leg.stateNote }),
  };
  for (const field of fields) {
    switch (field) {
      case "identity":
        Object.assign(kept, { market: leg.market, token: leg.token });
        break;
      case "balance":
        Object.assign(kept, {
          balance: leg.balance,
          activeBalance: leg.activeBalance,
          activeBalanceNote: leg.activeBalanceNote,
        });
        break;
      case "value":
        Object.assign(kept, { valueUsd: leg.valueUsd, valuationBasis: leg.valuationBasis });
        break;
      case "expiry":
        Object.assign(kept, { expiry: leg.expiry, daysToExpiry: leg.daysToExpiry });
        break;
      case "accrued":
        Object.assign(kept, { accrued: leg.accrued });
        break;
    }
  }
  return kept;
}

function wantsKind(kind: PendlePositionKind, kinds: PendlePositionsQuery["kinds"]): boolean {
  return kinds === undefined || kinds.includes(kind);
}

function comparePositionLegs(sort: PendlePositionsQuery["sort"]) {
  return (a: ProjectedPositionLeg, b: ProjectedPositionLeg): number => {
    if (sort === "expiry") {
      return (a.daysToExpiry ?? Number.MAX_SAFE_INTEGER) - (b.daysToExpiry ?? Number.MAX_SAFE_INTEGER);
    }
    if (sort === "chain") return a.chain.localeCompare(b.chain);
    return Number(b.valueUsd ?? "-Infinity") - Number(a.valueUsd ?? "-Infinity");
  };
}

function describePositionFilters(q: PendlePositionsQuery): Record<string, unknown> {
  const applied: Record<string, unknown> = {
    includeAccrued: q.includeAccrued,
    redeemableOnly: q.redeemableOnly,
    sort: q.sort,
  };
  if (q.chainIds !== undefined) applied.chains = q.chainIds.map((id) => pendleChainSlug(id) ?? String(id));
  if (q.kinds !== undefined) applied.kinds = q.kinds;
  if (q.minValueUsd !== undefined) applied.minValueUsd = q.minValueUsd;
  if (q.fields !== undefined) applied.fields = q.fields;
  return applied;
}

export async function pendlePositionValue(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ReturnType<typeof ok>> {
  const parsed = parsePendlePositionParams(p);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const nowMs = Date.now();

  let wallet: string;
  try {
    wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return fail(
      `Pendle positions unavailable — no EVM wallet selected (${failureDetail("pendle.position.value", err)})`,
    );
  }

  let chains;
  try {
    const dashboard = await getPendleReadClient().getWalletPositions(
      wallet,
      q.minValueUsd === undefined ? {} : { minUsd: q.minValueUsd },
    );
    chains = dashboard.chains;
  } catch (err) {
    return fail(`Pendle positions unavailable (${failureDetail("pendle.position.value", err)})`);
  }

  const legs: ProjectedPositionLeg[] = [];
  const freshness: ChainFreshness[] = [];
  const failedChains: FailedChain[] = [];
  const unsupportedChains: number[] = [];
  const crossPt: Array<Record<string, unknown>> = [];

  for (const chain of chains) {
    const slug = pendleChainSlug(chain.chainId);
    if (slug === undefined) {
      // Reported, not dropped: a holding on a chain outside our registry is
      // invisible to Vex, and the agent must know that rather than believe the
      // portfolio is complete.
      unsupportedChains.push(chain.chainId);
      continue;
    }
    if (q.chainIds !== undefined && !q.chainIds.includes(chain.chainId)) continue;
    freshness.push(chainFreshness(slug, chain.updatedAt, nowMs));

    let assetMap: Map<string, PendleAsset>;
    try {
      assetMap = await buildAssetMap(chain.chainId);
    } catch (err) {
      // Without decimals every amount would be a guess, so this chain's legs are
      // withheld and NAMED rather than shown with assumed 18-decimal maths.
      failedChains.push({ chain: slug, reason: failureDetail("pendle.position.value", err) });
      continue;
    }

    for (const position of chain.open) {
      for (const entry of position.crossPt) {
        crossPt.push({
          chain: slug,
          market: position.market,
          spokePt: entry.spokePt,
          spokeChainId: entry.chainId,
          balanceRaw: entry.balanceRaw,
          note: "Cross-chain PT leg on a spoke chain. Vex has no tool that can act on it — reported so the holding is not invisible. Decimals are NOT available for spoke assets, so no human amount is shown.",
        });
      }

      let lookup;
      try {
        lookup = await resolveMarketForRead(chain.chainId, position.market, nowMs);
      } catch (err) {
        failedChains.push({ chain: slug, reason: failureDetail("pendle.position.value", err) });
        continue;
      }
      const market = lookup.status === "found" ? lookup.market : null;
      // `null` — not `false` — when maturity is unproven: an indeterminate
      // catalogue walk must never be reported as "still earning".
      const matured = lookup.status === "found" ? lookup.matured : null;

      const legInputs = [
        { kind: "pt" as const, leg: position.pt, token: market?.pt ?? null },
        { kind: "yt" as const, leg: position.yt, token: market?.yt ?? null },
        { kind: "lp" as const, leg: position.lp, token: market?.address ?? position.market },
      ];
      for (const { kind, leg, token } of legInputs) {
        if (leg === null || !wantsKind(kind, q.kinds)) continue;
        legs.push(
          projectPositionLeg({
            chain: slug,
            kind,
            leg,
            market: position.market,
            legToken: token,
            expiry: market?.expiry ?? null,
            matured,
            assetByAddress: assetMap,
            includeAccrued: q.includeAccrued,
            nowMs,
          }),
        );
      }
    }

    if (wantsKind("sy", q.kinds)) {
      for (const sy of chain.sy) {
        legs.push(
          projectSyLeg({
            chain: slug,
            sy: sy.sy,
            balanceRaw: sy.balanceRaw,
            claimable: sy.claimable,
            assetByAddress: assetMap,
            includeAccrued: q.includeAccrued,
          }),
        );
      }
    }
  }

  const shown = q.redeemableOnly ? legs.filter((leg) => leg.state === "matured_redeemable") : legs;
  shown.sort(comparePositionLegs(q.sort));
  const totals = totalPositionValue(shown);
  const stale = freshness.filter((f) => f.stalenessWarning !== undefined);

  return ok({
    summary:
      `${shown.length} open Pendle leg${shown.length === 1 ? "" : "s"} across ` +
      `${freshness.length} chain${freshness.length === 1 ? "" : "s"}, total ${totals.totalUsd} USD` +
      (totals.unvaluedLegs > 0
        ? ` (${totals.unvaluedLegs} leg(s) could not be valued and are EXCLUDED from that total)`
        : "") +
      (stale.length > 0 ? `. STALE DATA on ${stale.length} chain(s) — see chainFreshness.` : "."),
    wallet,
    asOf: new Date(nowMs).toISOString(),
    filtersApplied: describePositionFilters(q),
    count: shown.length,
    totalValueUsd: totals.totalUsd,
    valuedLegs: totals.valuedLegs,
    unvaluedLegs: totals.unvaluedLegs,
    countsByState: countBy(shown, (leg) => leg.state),
    countsByKind: countBy(shown, (leg) => leg.kind),
    partial: failedChains.length > 0 || unsupportedChains.length > 0,
    failedChains,
    unsupportedChains,
    chainFreshness: freshness,
    crossPtPositions: crossPt,
    positions: shown.map((leg) => selectPositionFields(leg, q.fields)),
    nextStep:
      "`state` is the single status field: earning | matured_redeemable | matured_removable | expired_worthless. " +
      "Redeem a matured PT with pendle.pt.redeem, remove a matured LP with pendle.lp.remove, sweep accrued income with pendle.claim. " +
      "Amounts are {raw, decimals, exact} — use `exact` to talk to the user and `raw` to build a transaction.",
  });
}
