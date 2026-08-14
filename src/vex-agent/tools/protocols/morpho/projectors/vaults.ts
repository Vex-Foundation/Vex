/**
 * Projection of validated Morpho VAULT reads into agent-facing rows.
 *
 * The vault APY contract is DIFFERENT from the market one, and conflating them
 * is the single most expensive mistake available in this namespace.
 *
 *   A MARKET's `supplyApyPercent` is GROSS: nobody has taken a cut of it yet.
 *   A VAULT's `netApyPercent` is NET: the curator's fee has already been
 *   deducted. Ranking one against the other flatters the market by exactly the
 *   fee. On the 2026-08-14 capture, Steakhouse USDC reported apy 4.121% with a
 *   25% fee and netApy 3.075% - a gap larger than the spread between most of the
 *   vaults in the same list.
 *
 * So every vault APY here is emitted under a key naming its own basis, and the
 * block carries a `basis` sentence the agent can quote verbatim:
 *
 *   apyPercent                     - BEFORE the vault's fee.
 *   netApyPercent                  - after the fee, incentive streams included.
 *   netApyExcludingRewardsPercent  - after the fee, incentive streams excluded.
 *   rewards[].supplyAprPercent     - a separate APR paid in ITS OWN token.
 *
 * GATING is surfaced with the same prominence as the yield. A Morpho V2 vault
 * can route share and asset transfers through gate contracts, and a gate on the
 * withdrawal side means the vault can refuse to let a depositor out. The
 * 2026-08-14 scan of 100 V2 vaults found live gate contracts installed on real
 * vaults, so this is a present hazard rather than a theoretical one.
 */

import { morphoChainSlug } from "@tools/morpho/chains.js";
import { wadToPercent } from "@tools/morpho/request.js";
import type {
  MorphoVault,
  MorphoVaultAllocation,
  MorphoVaultApy,
  MorphoVaultDetail,
  MorphoVaultGating,
} from "@tools/morpho/types.js";
import {
  formatRawAmount,
  projectAmount,
  projectAsset,
  toPercent,
  type ProjectedAmount,
  type ProjectedAsset,
} from "./_shared.js";

/** The sentence every vault APY block is qualified by. */
export const MORPHO_VAULT_APY_DISCLAIMER =
  "A VAULT APY IS NET OF THE VAULT'S FEE, unlike a market APY which is gross. `apyPercent` is the yield BEFORE the "
  + "curator's fee is taken, `netApyPercent` is what a depositor actually earns with incentive streams included, "
  + "`netApyExcludingRewardsPercent` is the same after the fee but without incentives, and each `rewards[]` entry is a "
  + "separate APR paid in its OWN token whose price moves independently. Never rank a vault's net figure against a "
  + "market's `supplyApyPercent`, and never add a reward APR onto a net APY.";

/** The sentence every gating block is qualified by. */
export const MORPHO_VAULT_GATING_NOTE =
  "Gates exist only on V2 vaults. A gate with a non-null `address` routes that transfer through a contract that can "
  + "REFUSE it: a gate on the withdrawal side (`sendShares`, `receiveAssets`) can stop a depositor getting their money "
  + "out, and one on the deposit side (`receiveShares`, `sendAssets`) can stop them getting in. `abdicated: true` is "
  + "the opposite assurance, meaning the curator permanently gave up the right to ever install that gate. Never "
  + "recommend depositing into a vault whose withdrawal side is gated without saying so first.";

/** The sentence every curator/timelock block is qualified by. */
export const MORPHO_VAULT_CURATOR_NOTE =
  "A vault is a MANAGED product: the curator chooses which lending markets it supplies and can change that choice, "
  + "subject to a timelock measured in hours to weeks. Today's allocations, and therefore today's risk profile, are "
  + "not a property of the vault - they drift. Re-read the vault before acting on an allocation list you saw earlier, "
  + "and treat `pendingConfigCount` above zero as a change already queued.";

interface ProjectedVaultApy {
  basis: string;
  apyPercent: number | null;
  netApyPercent: number | null;
  netApyExcludingRewardsPercent: number | null;
  rewards: Array<{
    tokenAddress: string;
    symbol: string | null;
    decimals: number;
    supplyAprPercent: number | null;
  }>;
}

function projectApy(apy: MorphoVaultApy): ProjectedVaultApy {
  return {
    basis: MORPHO_VAULT_APY_DISCLAIMER,
    apyPercent: toPercent(apy.apy),
    netApyPercent: toPercent(apy.netApy),
    netApyExcludingRewardsPercent: toPercent(apy.netApyExcludingRewards),
    rewards: apy.rewards.map((reward) => ({
      tokenAddress: reward.asset.address,
      symbol: reward.asset.symbol,
      decimals: reward.asset.decimals,
      supplyAprPercent: toPercent(reward.supplyApr),
    })),
  };
}

function projectGating(gating: MorphoVaultGating | null): Record<string, unknown> | null {
  if (gating === null) return null;
  return {
    gated: gating.gated,
    depositGated: gating.depositGated,
    withdrawalGated: gating.withdrawalGated,
    gates: gating.gates,
    note: MORPHO_VAULT_GATING_NOTE,
  };
}

export interface ProjectedVaultRow {
  address: string;
  version: "v1" | "v2";
  chain: string | null;
  chainId: number;
  name: string | null;
  symbol: string | null;
  listed: boolean;
  vaultType: string | null;
  asset: ProjectedAsset;
  tvl: ProjectedAmount;
  totalSupplyRaw: string | null;
  liquidity: ProjectedAmount | null;
  sharePrice: number | null;
  apy: ProjectedVaultApy;
  fees: {
    performanceFeePercent: number | null;
    managementFeePercent: number | null;
    note: string;
  };
  curatorAddress: string | null;
  curators: Array<{ id: string | null; name: string | null; verified: boolean }>;
  ownerAddress: string | null;
  timelockSeconds: number | null;
  gating: Record<string, unknown> | null;
  warnings: Array<{ type: string; level: string }>;
}

const FEE_NOTE =
  "Fees are the curator's cut of the yield, already deducted from `netApyPercent`. V1 vaults have one performance "
  + "fee; V2 vaults split it into a performance fee and a management fee, so `managementFeePercent` is null on V1 "
  + "rather than zero.";

/** One validated vault -> one agent-facing row, identical shape for both generations. */
export function projectVaultRow(vault: MorphoVault): ProjectedVaultRow {
  const asset = projectAsset(vault.asset);
  return {
    address: vault.address,
    version: vault.version,
    chain: morphoChainSlug(vault.chainId) ?? null,
    chainId: vault.chainId,
    name: vault.name,
    symbol: vault.symbol,
    listed: vault.listed,
    vaultType: vault.vaultType,
    // `projectAsset` is null-tolerant for an optional market leg; a vault always
    // has an asset, and the validator drops the row when it cannot be read.
    asset: asset ?? { address: vault.asset.address, symbol: null, decimals: vault.asset.decimals, priceUsd: null },
    tvl: projectAmount(vault.totalAssets, vault.asset.symbol) ?? {
      raw: vault.totalAssets.raw,
      decimals: vault.totalAssets.decimals,
      symbol: vault.asset.symbol,
      human: formatRawAmount(vault.totalAssets.raw, vault.totalAssets.decimals),
      usd: vault.totalAssets.usd,
    },
    totalSupplyRaw: vault.totalSupplyRaw,
    liquidity: projectAmount(vault.liquidity, vault.asset.symbol),
    sharePrice: vault.sharePrice,
    apy: projectApy(vault.apy),
    fees: {
      performanceFeePercent: toPercent(vault.fees.performance),
      managementFeePercent: toPercent(vault.fees.management),
      note: FEE_NOTE,
    },
    curatorAddress: vault.curatorAddress,
    curators: vault.curators,
    ownerAddress: vault.ownerAddress,
    timelockSeconds: vault.timelockSeconds,
    gating: projectGating(vault.gating),
    warnings: vault.warnings,
  };
}

/**
 * One allocation.
 *
 * The market's decimals, not the vault's, scale the supplied and cap amounts:
 * they are the market's loan asset, which for a well-formed vault is the same
 * token but is not guaranteed to be. `relativeCapWad` is rendered as a percent
 * of vault assets, because a bare 18-digit WAD integer beside a token amount is
 * exactly the unreadable-number hazard rules/90 names.
 */
function projectAllocation(allocation: MorphoVaultAllocation): Record<string, unknown> {
  const decimals = allocation.loanAsset?.decimals ?? null;
  const symbol = allocation.loanAsset?.symbol ?? null;
  const scaled = (raw: string | null, usd: number | null): ProjectedAmount | null =>
    raw === null || decimals === null
      ? null
      : { raw, decimals, symbol, human: formatRawAmount(raw, decimals), usd };

  return {
    marketId: allocation.marketId,
    marketListed: allocation.marketListed,
    lltvPercent: wadToPercent(allocation.lltv),
    loanAsset: projectAsset(allocation.loanAsset),
    collateralAsset: projectAsset(allocation.collateralAsset),
    /** Null collateral means an IDLE market: the vault is parking cash, not lending. */
    idle: allocation.collateralAsset === null,
    supplied: scaled(allocation.suppliedRaw, allocation.suppliedUsd),
    cap: scaled(allocation.capRaw, allocation.capUsd),
    pendingCap: scaled(allocation.pendingCapRaw, null),
    pendingCapValidAt:
      allocation.pendingCapValidAt === null ? null : new Date(allocation.pendingCapValidAt * 1_000).toISOString(),
    relativeCapPercentOfVault:
      allocation.relativeCapWad === null ? null : wadToPercent(allocation.relativeCapWad),
    supplyQueueIndex: allocation.supplyQueueIndex,
    withdrawQueueIndex: allocation.withdrawQueueIndex,
    removableAt: allocation.removableAt === null ? null : new Date(allocation.removableAt * 1_000).toISOString(),
    marketSupplyApyPercent: toPercent(allocation.marketSupplyApy),
    marketNetSupplyApyPercent: toPercent(allocation.marketNetSupplyApy),
    marketUtilizationPercent: toPercent(allocation.marketUtilization),
  };
}

/**
 * Detail projection: the screening row plus everything only the by-address read
 * returns. Roles, timelocks and pending governance are grouped under `config`
 * because they answer one question - who can change this vault, and how fast.
 */
export function projectVaultDetail(detail: MorphoVaultDetail, includeHistory: boolean): Record<string, unknown> {
  const row = projectVaultRow(detail);
  return {
    ...row,
    config: {
      ownerAddress: detail.ownerAddress,
      pendingOwnerAddress: detail.pendingOwnerAddress,
      curatorAddress: detail.curatorAddress,
      allocatorAddresses: detail.allocatorAddresses,
      // V1 names one guardian; V2 replaces it with a sentinel list.
      guardianAddress: detail.guardianAddress,
      sentinelAddresses: detail.sentinelAddresses,
      feeRecipients: {
        performance: detail.fees.performanceRecipient,
        management: detail.fees.managementRecipient,
      },
      skimRecipient: detail.skimRecipient,
      timelockSeconds: detail.timelockSeconds,
      timelocks: detail.timelocks,
      pendingConfigCount: detail.pendingConfigCount,
      note: MORPHO_VAULT_CURATOR_NOTE,
    },
    state: {
      sharePrice: detail.sharePrice,
      totalAssets: row.tvl,
      totalSupplyRaw: detail.totalSupplyRaw,
      idleAssets: projectAmount(detail.idleAssets, detail.asset.symbol),
      liquidity: row.liquidity,
      forceDeallocatableLiquidity:
        detail.forceDeallocatableLiquidityRaw === null
          ? null
          : {
              raw: detail.forceDeallocatableLiquidityRaw,
              decimals: detail.asset.decimals,
              symbol: detail.asset.symbol,
              human: formatRawAmount(detail.forceDeallocatableLiquidityRaw, detail.asset.decimals),
              usd: null,
            },
      maxApyPercent: toPercent(detail.maxApy),
      note:
        "`totalSupplyRaw` is SHARE units, not asset units - it is not comparable with `totalAssets`. `liquidity` is "
        + "what could be withdrawn immediately; `forceDeallocatableLiquidity` needs a forced deallocation that costs "
        + "a penalty, so it is not free exit capacity.",
    },
    apyHistory: includeHistory
      ? {
          avgNetApyPercent: toPercent(detail.apy.avgNetApy),
          avgNetApyExcludingRewardsPercent: toPercent(detail.apy.avgNetApyExcludingRewards),
          note:
            "Morpho returns a single trailing average and does not name the window it covers, so treat these as "
            + "'recent average' rather than a period you can compare across vaults with confidence.",
        }
      : null,
    allocations:
      detail.allocations === null
        ? null
        : {
            count: detail.allocations.length,
            note:
              "Each entry is one lending market the vault supplies, with the cap the curator set on it. The "
              + "`market*ApyPercent` figures are the MARKET's own rates and are GROSS of this vault's fee, so they "
              + "will read higher than the vault's `netApyPercent`. " + MORPHO_VAULT_CURATOR_NOTE,
            markets: detail.allocations.map(projectAllocation),
          },
    adapters: detail.adapters,
  };
}

/** Keep only the requested field groups. `undefined` keeps the whole row. */
export function selectVaultFields(
  row: ProjectedVaultRow,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined) return { ...row };
  const kept: Record<string, unknown> = {
    address: row.address,
    version: row.version,
    chain: row.chain,
    chainId: row.chainId,
  };
  for (const field of fields) {
    switch (field) {
      case "identity":
        Object.assign(kept, { name: row.name, symbol: row.symbol, listed: row.listed, vaultType: row.vaultType });
        break;
      case "asset":
        Object.assign(kept, { asset: row.asset });
        break;
      case "apy":
        Object.assign(kept, { apy: row.apy });
        break;
      case "size":
        Object.assign(kept, {
          tvl: row.tvl,
          totalSupplyRaw: row.totalSupplyRaw,
          liquidity: row.liquidity,
          sharePrice: row.sharePrice,
        });
        break;
      case "fees":
        Object.assign(kept, { fees: row.fees });
        break;
      case "governance":
        Object.assign(kept, {
          curatorAddress: row.curatorAddress,
          curators: row.curators,
          ownerAddress: row.ownerAddress,
          timelockSeconds: row.timelockSeconds,
        });
        break;
      case "gating":
        Object.assign(kept, { gating: row.gating, warnings: row.warnings });
        break;
    }
  }
  // Gating is a hazard, not a detail: a projection that drops it must still say
  // whether the vault can refuse a withdrawal.
  if (!fields.includes("gating") && row.gating !== null) {
    kept["gated"] = row.gating.gated;
    kept["withdrawalGated"] = row.gating.withdrawalGated;
  }
  return kept;
}
