/**
 * `morpho.positions.get` - one wallet's whole Morpho footprint.
 *
 * THREE COMPOSITION DECISIONS ARE LOAD-BEARING HERE, and each of them exists
 * because the obvious single query would have produced an answer that looked
 * complete and was not.
 *
 * 1. THE MARKET HALF IS A UNION OF THREE READS. Morpho keeps a `MarketPosition`
 *    row for every market an address has EVER touched, so a bare
 *    `userAddress_in` read of a busy address returns thousands of closed rows
 *    (measured 2026-08-14: 2,002 for `0x...dEaD`). GraphQL filters are ANDed, so
 *    "has collateral OR has supply OR has debt" cannot be expressed as one
 *    predicate. The three reads are issued, deduped by position id and merged.
 *    Like the vaults lane's cross-generation merge, a union can only be paged
 *    exactly inside one window, which is why the param boundary refuses an
 *    offset+limit past the page ceiling.
 *
 *    When `maxHealthFactor` is set the union is unnecessary: `healthFactor_lte`
 *    already selects borrowing positions only, and Morpho pages and ranks that
 *    server-side over ALL matches. That path is a plain page.
 *
 * 2. RISK ORDERING, NOT SIZE ORDERING. The merged rows are sorted by health
 *    factor ASCENDING with the null-health-factor rows last. A position read is
 *    consulted when somebody is worried, and the row that is about to be
 *    liquidated belongs at the top of the first page rather than wherever its
 *    dollar size puts it. Supply-only rows have no health factor and go last
 *    because they cannot be liquidated at all - not because they are safe in
 *    every sense.
 *
 * 3. VAULT V2 COVERAGE IS COMPOSED AND REPORTED. The schema has no per-user V2
 *    position list: `vaultPositions` resolves to V1 vaults only, and
 *    `vaultV2PositionByAddress` needs a vault address. So the wallet's V2
 *    transaction history is scanned for the vaults it has touched and each one
 *    is read. That scan is bounded, so the reply carries a coverage block
 *    stating what it actually covered. Returning V1 vaults alone and calling the
 *    result "your vault positions" would be the silent omission rules/90
 *    forbids.
 *
 * NOTHING IS FILTERED OUT FOR BEING UNLISTED. Every other Morpho screening tool
 * defaults to curated rows only; this one must not. An unlisted market is
 * exactly where a user's forgotten, worst position tends to be - the live
 * capture behind this batch found a wallet holding a position at health factor
 * 0.3053 on an UNLISTED Ethereum market flagged `bad_debt_unrealized`. Hiding a
 * user's own money from them is never the safe default.
 */

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { getMorphoClient } from "@tools/morpho/client.js";
import type { MorphoMarketPosition, MorphoVaultPosition, MorphoVaultV2Coverage } from "@tools/morpho/types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  MORPHO_V2_MAX_VAULTS,
  MORPHO_V2_SCAN_LIMIT,
  parseMorphoPositionsParams,
  type MorphoPositionsQuery,
} from "../read-params.js";
import {
  MORPHO_HEALTH_FACTOR_NOTE,
  MORPHO_POSITION_USD_NOTE,
  MORPHO_PRICE_DROP_NOTE,
  MORPHO_SHARES_NOTE,
  MORPHO_VAULT_APY_DISCLAIMER,
  projectMarketPosition,
  projectPortfolioTotals,
  projectVaultPosition,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

/** A `MorphoClient`, narrowed to what this handler calls. */
type Client = ReturnType<typeof getMorphoClient>;

interface MarketHalf {
  positions: MorphoMarketPosition[];
  /** Exact per-predicate totals from Morpho. They OVERLAP and must not be summed. */
  matchedByFilter: Record<string, number>;
  droppedRows: number;
  /** True when Morpho paged the result itself, so `hasMore` is exact. */
  serverPaged: boolean;
  serverTotal: number;
}

/** Riskiest first, with the rows that cannot be liquidated at the end. */
function byRisk(a: MorphoMarketPosition, b: MorphoMarketPosition): number {
  if (a.healthFactor === null && b.healthFactor === null) return 0;
  if (a.healthFactor === null) return 1;
  if (b.healthFactor === null) return -1;
  return a.healthFactor - b.healthFactor;
}

async function readMarketHalf(client: Client, q: MorphoPositionsQuery, signal?: AbortSignal): Promise<MarketHalf> {
  const base = {
    userAddress_in: [q.walletAddress],
    ...(q.chainIds ? { chainId_in: q.chainIds } : {}),
  };

  if (q.maxHealthFactor !== undefined) {
    const page = await client.getMarketPositionPage(
      {
        first: q.limit,
        skip: q.offset,
        orderBy: "healthFactor",
        order: "asc",
        where: { ...base, healthFactor_lte: q.maxHealthFactor },
      },
      signal,
    );
    return {
      positions: page.positions,
      matchedByFilter: { withHealthFactorAtOrBelowBound: page.countTotal },
      droppedRows: page.droppedRows,
      serverPaged: true,
      serverTotal: page.countTotal,
    };
  }

  const window = q.offset + q.limit;
  const lanes = [
    { label: "withCollateral", where: { ...base, collateral_gte: "1" }, orderBy: "collateral" as const },
    { label: "withSupply", where: { ...base, supplyShares_gte: "1" }, orderBy: "supplyShares" as const },
    { label: "withDebt", where: { ...base, borrowShares_gte: "1" }, orderBy: "borrowShares" as const },
  ];

  const seen = new Set<string>();
  const positions: MorphoMarketPosition[] = [];
  const matchedByFilter: Record<string, number> = {};
  let droppedRows = 0;
  for (const lane of lanes) {
    const page = await client.getMarketPositionPage(
      { first: window, skip: 0, orderBy: lane.orderBy, order: "desc", where: lane.where },
      signal,
    );
    matchedByFilter[lane.label] = page.countTotal;
    droppedRows += page.droppedRows;
    for (const position of page.positions) {
      if (seen.has(position.id)) continue;
      seen.add(position.id);
      positions.push(position);
    }
  }
  return {
    positions: [...positions].sort(byRisk),
    matchedByFilter,
    droppedRows,
    serverPaged: false,
    serverTotal: positions.length,
  };
}

interface VaultHalf {
  positions: MorphoVaultPosition[];
  /** V1 rows returned on this page, which is the half Morpho pages server-side. */
  v1Returned: number;
  matchedV1: number;
  droppedRows: number;
  coverage: MorphoVaultV2Coverage | null;
}

async function readVaultHalf(client: Client, q: MorphoPositionsQuery, signal?: AbortSignal): Promise<VaultHalf> {
  const page = await client.getVaultPositionPage(
    {
      first: q.limit,
      skip: q.offset,
      order: "desc",
      where: {
        userAddress_in: [q.walletAddress],
        ...(q.chainIds ? { chainId_in: q.chainIds } : {}),
        shares_gte: "1",
      },
    },
    signal,
  );

  if (!q.includeVaultV2) {
    return {
      positions: page.positions,
      v1Returned: page.positions.length,
      matchedV1: page.countTotal,
      droppedRows: page.droppedRows,
      coverage: null,
    };
  }

  const scan = await client.getVaultV2UserVaults(q.walletAddress, q.chainIds, MORPHO_V2_SCAN_LIMIT, signal);
  const candidates = scan.vaults.slice(0, MORPHO_V2_MAX_VAULTS);
  const v2Positions: MorphoVaultPosition[] = [];
  let vaultsRead = 0;
  for (const candidate of candidates) {
    let position: MorphoVaultPosition | null = null;
    try {
      position = await client.getVaultV2Position(
        { userAddress: q.walletAddress, vaultAddress: candidate.address, chainId: candidate.chainId },
        signal,
      );
    } catch (err) {
      // A vault the transaction scan named that the position read cannot resolve
      // is a coverage gap in ONE vault, not a reason to fail a whole portfolio
      // read. It is excluded from `vaultsRead`, which is what makes `complete`
      // false and puts the gap in the reply.
      if (!(err instanceof VexError) || err.code !== ErrorCodes.MORPHO_VAULT_NOT_FOUND) throw err;
      continue;
    }
    vaultsRead += 1;
    // A fully exited vault resolves to null on a perfectly valid query, and a
    // dust row is not a position anybody wants listed.
    if (position !== null && position.assets.raw !== "0") v2Positions.push(position);
  }

  return {
    positions: page.positions.concat(v2Positions),
    v1Returned: page.positions.length,
    matchedV1: page.countTotal,
    droppedRows: page.droppedRows,
    coverage: {
      scannedTransactions: scan.scanned,
      totalTransactions: scan.total,
      vaultsFound: scan.vaults.length,
      vaultsRead,
      complete: scan.scanned >= scan.total && vaultsRead === scan.vaults.length,
    },
  };
}

export async function morphoPositionsGet(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoPositionsParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const client = getMorphoClient();
  const signal = context?.abortSignal;

  let markets: MarketHalf | null = null;
  let vaults: VaultHalf | null = null;
  try {
    if (q.scope !== "vaults") markets = await readMarketHalf(client, q, signal);
    if (q.scope !== "markets") vaults = await readVaultHalf(client, q, signal);
  } catch (err) {
    return fail(`morpho.positions.get failed ${morphoFailureDetail(err)}`);
  }

  const marketRows = (markets?.positions ?? []).slice(
    markets?.serverPaged === true ? 0 : q.offset,
    markets?.serverPaged === true ? undefined : q.offset + q.limit,
  );
  const vaultRows = vaults?.positions ?? [];
  const totals = projectPortfolioTotals(marketRows, vaultRows);
  const atRisk = marketRows.filter((p) => p.healthFactor !== null && p.healthFactor < 1.25);
  const liquidatable = marketRows.filter((p) => p.healthFactor !== null && p.healthFactor <= 1);

  const marketHasMore =
    markets === null
      ? false
      : markets.serverPaged
        ? q.offset + marketRows.length < markets.serverTotal
        : q.offset + marketRows.length < markets.positions.length;
  // Only the V1 half is server-paged; the V2 half is a bounded sweep whose
  // completeness is reported by its own coverage block, not by `hasMore`.
  const vaultHasMore = vaults !== null && q.offset + vaults.v1Returned < vaults.matchedV1;

  return ok({
    summary: buildSummary(
      q,
      markets === null ? null : marketRows.length,
      vaults === null ? null : vaultRows.length,
      liquidatable.length,
      atRisk.length,
    ),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    walletAddress: q.walletAddress,
    portfolioTotalsUsd: totals,
    marketPositions:
      markets === null
        ? null
        : {
          returned: marketRows.length,
          offset: q.offset,
          limit: q.limit,
          hasMore: marketHasMore,
          nextOffset: marketHasMore ? q.offset + marketRows.length : null,
          droppedRows: markets.droppedRows,
          matchedByFilter: markets.matchedByFilter,
          ranking: markets.serverPaged
            ? "Morpho filtered by health factor and ranked ALL matching positions server-side, so this page is exact."
            : "Three server-side reads were merged: positions with collateral, with supplied assets, and with debt. "
              + "Morpho keeps a row for every market a wallet has ever touched, so those three predicates are what "
              + "separates a real position from a closed one, and their totals in `matchedByFilter` OVERLAP and must "
              + "not be added together. The merged rows are ordered by health factor ascending, riskiest first, with "
              + "positions that carry no debt last.",
          rows: marketRows.map(projectMarketPosition),
        },
    vaultPositions:
      vaults === null
        ? null
        : {
          returned: vaultRows.length,
          // The two halves are counted separately because they are paged
          // differently: `limit` bounds the V1 page, while the V2 rows come
          // from a bounded sweep whose completeness is `vaultV2Coverage`. So
          // `returned` can exceed `limit`, and saying which part came from
          // where is the honest way to report that.
          v1Returned: vaults.v1Returned,
          v2Returned: vaultRows.length - vaults.v1Returned,
          matchedV1: vaults.matchedV1,
          droppedRows: vaults.droppedRows,
          hasMore: vaultHasMore,
          vaultV2Coverage: vaults.coverage,
          rows: vaultRows.map(projectVaultPosition),
        },
    riskFlags: {
      liquidatableNow: liquidatable.length,
      belowHealthFactor1point25: atRisk.length,
      // The rows are already ordered riskiest first, so the first row carrying a
      // health factor holds the lowest one on this page. Emitted as a decimal
      // string for the same reason every health factor in this lane is.
      lowestHealthFactor: (() => {
        const lowest = marketRows.find((p) => p.healthFactor !== null)?.healthFactor;
        return lowest === undefined ? null : String(lowest);
      })(),
    },
    notes: {
      healthFactor: MORPHO_HEALTH_FACTOR_NOTE,
      priceDropToLiquidation: MORPHO_PRICE_DROP_NOTE,
      shares: MORPHO_SHARES_NOTE,
      usd: MORPHO_POSITION_USD_NOTE,
      vaultApy: MORPHO_VAULT_APY_DISCLAIMER,
      vaultPaging:
        "`limit` and `offset` page the V1 vault positions, which Morpho pages server-side. The V2 rows are added "
        + "by a separate bounded sweep, so the vault section's `returned` can exceed `limit`; `v1Returned` and "
        + "`v2Returned` say which part came from where.",
      oneWallet:
        "This read covers ONE wallet. Positions held by another address the same person controls are not included "
        + "and their absence is not evidence that none exist.",
      listing:
        "Unlisted markets and vaults are INCLUDED here, unlike every screening tool in this namespace. A user's "
        + "worst position is often on a market nobody curated, and hiding a wallet's own money would be the more "
        + "dangerous default.",
      ...(vaults?.coverage !== null && vaults?.coverage !== undefined && !vaults.coverage.complete
        ? {
          vaultV2:
            "V2 vault coverage is PARTIAL. Morpho serves no per-user list of V2 vault positions, so Vex finds "
            + "candidate vaults from this wallet's V2 transaction history and reads each one; that scan hit its "
            + "bound here, so a V2 position may exist that is not listed. Read a specific one with "
            + "morpho.vault.get plus the vault address if you suspect it.",
        }
        : {}),
    },
    nextStep:
      liquidatable.length > 0
        ? "At least one position is liquidatable NOW. Read the market with morpho.market.get to see the oracle and "
          + "the liquidity, and check morpho.markets.activity for liquidations already happening there. Vex has no "
          + "Morpho mutating tools yet, so it cannot repay or add collateral: say so plainly."
        : "Read any market that concerns you with morpho.market.get, and its recent liquidations with "
          + "morpho.markets.activity. This namespace is read-only; Vex cannot change a position on Morpho today.",
  });
}

/**
 * The headline sentence.
 *
 * A SECTION THAT WAS NOT READ IS NOT COUNTED. `scope: "markets"` used to report
 * "0 vault position(s)" for a half nobody looked at, and a checked zero and an
 * unread section are different answers - the trailing scope qualifier came after
 * the number, which is not where a reader stops.
 */
function buildSummary(
  q: MorphoPositionsQuery,
  marketRows: number | null,
  vaultRows: number | null,
  liquidatable: number,
  atRisk: number,
): string {
  const counted = [
    ...(marketRows === null ? [] : [`${marketRows} lending-market position(s)`]),
    ...(vaultRows === null ? [] : [`${vaultRows} vault position(s)`]),
  ].join(" and ");
  const unread =
    marketRows === null
      ? " Lending-market positions were NOT read on this call."
      : vaultRows === null
        ? " Vault positions were NOT read on this call."
        : "";
  const parts = [
    `${q.walletAddress} holds ${counted}`
    + `${q.chainIds ? " on the selected chains" : " across every chain Vex reads Morpho on"}.${unread}`,
  ];
  if (liquidatable > 0) {
    parts.push(
      `${liquidatable} position(s) are LIQUIDATABLE NOW at a health factor at or below 1. Morpho has no close `
      + "factor, so a single liquidation can take the whole position.",
    );
  } else if (atRisk > 0) {
    parts.push(`${atRisk} position(s) sit below a health factor of 1.25, which is close enough to be an emergency.`);
  }
  if (q.maxHealthFactor !== undefined) {
    parts.push(
      `Only positions at or below health factor ${q.maxHealthFactor} were read, so supply-only positions, which `
      + "have no health factor at all, are absent by construction rather than because none exist.",
    );
  }
  return parts.join(" ");
}
