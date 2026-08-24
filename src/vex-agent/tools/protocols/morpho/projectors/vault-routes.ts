/**
 * The ROUTE COMPARISON: one curated vault and one Blue market, described in the
 * same vocabulary so an agent can rank them without doing arithmetic in prose.
 *
 * Why this file exists at all. On Base every curated USDC vault allocates into
 * the SAME handful of markets, so they all earn the same gross rate and differ
 * only by the curator's cut: a live read on 2026-08-14 put four of them at a
 * gross 4.13% and net 4.13%, 3.92%, 3.71% and 3.08% as the fee went 0%, 5%, 10%,
 * 25%. Supplying the cbBTC/USDC market directly earned that same 4.13% with no
 * curator in the way. That is a real, sizeable choice, and before this file the
 * agent could not see the two sides in one call.
 *
 * Three rules govern what is emitted here.
 *
 * ONE BASIS, STATED. A vault's `netApy` and a market's `netSupplyApy` are both
 * rewards-INCLUSIVE and both are what the depositor keeps, so those two - and
 * only those two - are the comparable pair. They are emitted under the shared
 * key `netApyPercent`, and every other rate keeps a key naming its own basis.
 * A vault's `apyPercent` (before the fee) is NEVER compared against a market's
 * supply APY: that comparison flatters the vault by exactly the fee.
 *
 * THE COMPARISON IS DATA. The delta against the best direct option is computed
 * and emitted in PERCENTAGE POINTS. No sentence anywhere tells the agent which
 * side to pick, because the answer depends on how the user prices concentration
 * risk, and that is not a fact this tool holds.
 *
 * A POINTER IS CHECKED BEFORE IT IS PRINTED, AND IT PRINTS A CALLABLE NAME.
 * Every option names the tool it is acted on with and the params that tool
 * already knows. The name emitted is the model-visible `publicName`, resolved
 * through the namespace's own manifest: a dotted `toolId` is the internal and
 * audit identity and the catalog rejects it as a call, so printing one would
 * send the agent at a guaranteed rejection. Resolution doubles as the presence
 * check, so a build in which the direct execute tool is not present says so
 * rather than naming something that does not resolve.
 */

import type { ProjectedMarketRow } from "./markets.js";
import type { ProjectedVaultRow } from "./vaults.js";

/** The one sentence the whole comparison is qualified by. */
export const MORPHO_ROUTE_COMPARISON_NOTE =
  "`netApyPercent` is the ONLY field comparable across the two kinds: on a curated option it is the vault's net APY "
  + "after the curator's fee, on a direct option it is the market's net supply APY, and both include incentives. "
  + "The tradeoff the numbers do not contain: a curator's fee buys diversification across many markets and the right "
  + "to reallocate when one of them deteriorates, while a direct supply pays no fee and concentrates the whole "
  + "position in ONE market's collateral, oracle and LLTV.";

/** What a curated option's market count would take to establish, said plainly. */
const CURATED_DIVERSIFICATION_BASIS =
  "A vault spreads deposits across several markets, but the allocation table is not on a screening page. Read "
  + "`morpho__vault_get` with `includeAllocations` for the exact market count and the cap on each.";

const DIRECT_DIVERSIFICATION_BASIS =
  "Exactly one market: one collateral asset, one oracle and one LLTV. There is no curator to reallocate out of it "
  + "if that collateral or oracle deteriorates.";

const DIRECT_EXIT_BASIS =
  "A direct supply has no gate, but it is not unconditionally liquid either: withdrawal is bounded by the market's "
  + "available liquidity, and at high utilization a supplier can be unable to exit until borrowers repay.";

const CURATED_EXIT_BASIS =
  "A vault's exit is bounded by its own liquidity and, on V2 vaults only, by a gate contract that can refuse a "
  + "withdrawal outright. Read `gating` before assuming an exit is available.";

/**
 * The catalog's `toolId -> publicName` projection, for the tools this projector
 * can route to.
 *
 * A MAP rather than the former set of ids, because the pointer has to emit a
 * CALLABLE name and the two identities are not derivable from each other by
 * string surgery (`protocols/types.ts`). Membership still answers "does this
 * build ship the tool", so the map subsumes what the set proved.
 */
export type MorphoCallableNames = ReadonlyMap<string, string>;

/** One step the agent takes next, with the params this call can already fill. */
export interface MorphoRoutePointer {
  /**
   * The MODEL-VISIBLE callable name, and the one the agent must emit.
   *
   * The route pointer is prose-adjacent: the manifest tells the model to act on
   * the option with the tool named here, so this field has to be callable. A
   * dotted `toolId` is the internal and audit identity only and the catalog
   * rejects it as a call, so naming one here would route the agent at a
   * guaranteed rejection. Null only when this build does not ship the tool, in
   * which case `available` is false and there is no name to call.
   */
  publicName: string | null;
  /** The durable internal identity, retained for audit and telemetry correlation. */
  toolId: string;
  /** False when this build does not ship that tool; the agent must not call it. */
  available: boolean;
  params: Record<string, unknown>;
  /** Params the agent must still decide, chiefly the size of the position. */
  stillNeeded: readonly string[];
}

export interface MorphoRouteOption {
  kind: "curated" | "direct";
  label: string;
  chain: string | null;
  chainId: number;
  /** The comparable rate. Rewards-inclusive and after every fee, on both kinds. */
  netApyPercent: number | null;
  netApyBasis: string;
  apyExcludingRewardsPercent: number | null;
  /** The rate before the curator's cut. Equal to the supply APY on a direct option. */
  grossApyPercent: number | null;
  curatorFeePercent: number | null;
  managementFeePercent: number | null;
  /** Gross minus net, both rewards-excluded: what the fee actually costs, in points. */
  feeDragPercentagePoints: number | null;
  /** This option's net APY minus the best DIRECT option's, in percentage points. */
  deltaVsBestDirectPercentagePoints: number | null;
  diversification: { marketCount: number | null; basis: string };
  exit: {
    liquidity: unknown;
    utilizationPercent: number | null;
    gating: unknown;
    basis: string;
  };
  risk: Record<string, unknown>;
  routing: { quote: MorphoRoutePointer; execute: MorphoRoutePointer; note: string };
}

function pointer(
  toolId: string,
  callableNames: MorphoCallableNames,
  params: Record<string, unknown>,
  stillNeeded: readonly string[],
): MorphoRoutePointer {
  const publicName = callableNames.get(toolId) ?? null;
  return { publicName, toolId, available: publicName !== null, params, stillNeeded };
}

function subtract(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

/** One curated vault row as a comparable option. */
export function curatedRouteOption(
  row: ProjectedVaultRow,
  callableNames: MorphoCallableNames,
): MorphoRouteOption {
  const target = { vaultAddress: row.address, chain: row.chain };
  return {
    kind: "curated",
    label: `${row.name ?? row.address} (${row.version} vault)`,
    chain: row.chain,
    chainId: row.chainId,
    netApyPercent: row.apy.netApyPercent,
    netApyBasis: "the vault's net APY: after the curator's fee, incentives included.",
    apyExcludingRewardsPercent: row.apy.netApyExcludingRewardsPercent,
    grossApyPercent: row.apy.apyPercent,
    curatorFeePercent: row.fees.performanceFeePercent,
    managementFeePercent: row.fees.managementFeePercent,
    feeDragPercentagePoints: subtract(row.apy.apyPercent, row.apy.netApyExcludingRewardsPercent),
    deltaVsBestDirectPercentagePoints: null,
    diversification: { marketCount: null, basis: CURATED_DIVERSIFICATION_BASIS },
    exit: {
      liquidity: row.liquidity,
      utilizationPercent: null,
      gating: row.gating,
      basis: CURATED_EXIT_BASIS,
    },
    risk: {
      warnings: row.warnings,
      curatorAddress: row.curatorAddress,
      curators: row.curators,
      timelockSeconds: row.timelockSeconds,
      listed: row.listed,
    },
    routing: {
      quote: pointer("morpho.vault.quote", callableNames, { ...target, direction: "deposit" }, ["depositAmountRaw"]),
      execute: pointer("morpho.vault.deposit", callableNames, target, ["depositAmountRaw"]),
      note:
        "Price the deposit with morpho__vault_quote first; morpho__vault_deposit is gated on a fresh matching quote. "
        + "`depositAmountRaw` is in the vault ASSET's base units.",
    },
  };
}

/** One Blue market row as a comparable direct-supply option. */
export function directRouteOption(
  row: ProjectedMarketRow,
  callableNames: MorphoCallableNames,
): MorphoRouteOption {
  const collateral = row.collateralAsset?.symbol ?? (row.idle ? "IDLE (no collateral)" : "unknown collateral");
  const target = { marketId: row.marketId, chain: row.chain };
  return {
    kind: "direct",
    label: `${collateral}/${row.loanAsset.symbol ?? "loan asset"} market at ${row.lltvPercent}% LLTV`,
    chain: row.chain,
    chainId: row.chainId,
    netApyPercent: row.apy?.netSupplyApyPercent ?? null,
    netApyBasis: "the market's net supply APY: no curator takes a cut, incentives included.",
    apyExcludingRewardsPercent: row.apy?.supplyApyPercent ?? null,
    grossApyPercent: row.apy?.supplyApyPercent ?? null,
    curatorFeePercent: null,
    managementFeePercent: null,
    // No curator stands between the market rate and the supplier, so there is
    // nothing to subtract. The market's own `feePercent` is charged to BORROWER
    // interest and is already inside the supply APY; it is reported under risk.
    feeDragPercentagePoints: 0,
    deltaVsBestDirectPercentagePoints: null,
    diversification: { marketCount: 1, basis: DIRECT_DIVERSIFICATION_BASIS },
    exit: {
      liquidity: row.liquidity,
      utilizationPercent: row.utilizationPercent,
      gating: null,
      basis: DIRECT_EXIT_BASIS,
    },
    risk: {
      warnings: row.warnings,
      collateralAsset: row.collateralAsset,
      lltvPercent: row.lltvPercent,
      oracle: row.oracle,
      marketFeePercent: row.feePercent,
      idle: row.idle,
      listed: row.listed,
    },
    routing: {
      quote: pointer("morpho.market.quote", callableNames, { ...target, direction: "supply" }, ["depositAmountRaw"]),
      execute: pointer("morpho.market.supply", callableNames, target, ["depositAmountRaw"]),
      note:
        "Price the supply with morpho__market_quote first; morpho__market_supply is gated on a fresh matching quote. "
        + "`depositAmountRaw` is in the market's LOAN asset base units.",
    },
  };
}

/**
 * Fill every option's delta against the best direct option and rank the union.
 *
 * Best means highest net APY among the DIRECT options, because that is the
 * benchmark the fee is being paid to beat. An option whose net APY is unknown
 * gets a null delta and sorts LAST in both cases: an absent rate is not a low
 * rate, and floating it to the top would present "we do not know" as "best".
 */
export function rankRouteOptions(options: readonly MorphoRouteOption[]): {
  options: MorphoRouteOption[];
  bestDirectNetApyPercent: number | null;
} {
  const directRates = options
    .filter((option) => option.kind === "direct")
    .map((option) => option.netApyPercent)
    .filter((rate): rate is number => rate !== null);
  const best = directRates.length === 0 ? null : Math.max(...directRates);

  const withDelta = options.map((option) => ({
    ...option,
    deltaVsBestDirectPercentagePoints: subtract(option.netApyPercent, best),
  }));
  withDelta.sort((a, b) => {
    if (a.netApyPercent === null && b.netApyPercent === null) return 0;
    if (a.netApyPercent === null) return 1;
    if (b.netApyPercent === null) return -1;
    return b.netApyPercent - a.netApyPercent;
  });
  return { options: withDelta, bestDirectNetApyPercent: best };
}
