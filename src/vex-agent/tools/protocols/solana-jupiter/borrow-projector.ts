/**
 * Jupiter Lend Borrow vaults/positions concise projectors (Agent Scan Phase 3
 * Batch 5, card B1; wire shape corrected in card B3 — see
 * `../../../../../src/tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.ts`).
 *
 * `GET /borrow/vaults` and `GET /borrow/positions` are already small,
 * flat-ish shapes (unlike Earn's ~30-field-per-token nesting) — this
 * projector's main job is not size-trimming but UNIT LABELING.
 *
 * TOKEN IDENTITY (2026-07-25 restoration, live hazard): every `*Raw` field
 * below — and every one of `solana.lend.borrowOperate`'s six amount params —
 * is raw ATOMIC units of a specific leg's token. An earlier revision of this
 * projector emitted only the two mint ADDRESSES, so `minimumBorrowingRaw:
 * "1047061"` next to a bare mint was unreadable: 1.05 at 6 decimals, or
 * 0.00105 at 9. Both legs therefore now carry `symbol` + `decimals` +
 * the provider's own `price`, all of which the vault row ALREADY carries on
 * the wire (`JupiterLendBorrowToken`) — pure projection, no extra fetch. This
 * mirrors the Earn sibling (`./lend-projector.ts`'s `assetDecimals`/
 * `assetSymbol`/`assetPriceUsd`) so both Lend shelves read the same way.
 * `uiSymbol` is deliberately NOT surfaced: it renders WSOL as "SOL", and
 * Borrow's `/operate` never wraps or unwraps native SOL (see
 * `../../../../tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/
 * types.ts`) — the mint's real `symbol` is the non-misleading one here.
 *
 * The other job is UNIT LABELING:
 * `collateralFactor`/`liquidationThreshold` are provider-scaled DIGIT-STRING
 * integers with no unit suffix on the wire (verified live: "collateralFactor
 * (max LTV, where 800 corresponds to 80%)" — raw/10 = percent, one implied
 * decimal digit). Every formatted percent field carries its raw sibling
 * (OWNER RULE: a scaled agent-visible field must expose its own raw form
 * too), via pure decimal-point shifting on the STRING form — no
 * `parseFloat`/division, so no precision can be invented or lost (mirrors
 * `./lend-projector.ts`'s `formatBasisPointsAsPercent`, which shifts a
 * DIFFERENT number of digits for Earn's distinct 1e4-scaled rate fields —
 * the two are not shared because the divisor differs and each lives with
 * its own confirmed-vs-assumed unit note).
 *
 * `liquidationThreshold`'s own scale is NOT independently confirmed by prose
 * in the live docs (only `collateralFactor`'s is) — three recorded live
 * fixtures (`__tests__/solana/fixtures/lend-borrow/vaults-main.json` ids 1 +
 * 40, `vaults-ethena.json` id 5) all show a plausible
 * collateralFactor < liquidationThreshold < liquidationMaxLimit ordering
 * under the SAME raw/10 scale, so this shelf projects it that way — see
 * `liquidationThresholdPercent`'s doc below and `../../../../tools/
 * solana-ecosystem/jupiter/jupiter-lend/borrow-api/JupiterLendBorrowApi.md`'s
 * "Unit-scale caveat".
 *
 * NO field is ever dropped by count/window (OWNER RULE) — filtering is
 * always an explicit, agent-controlled `vaultIds` allow-list, never a silent
 * default cap.
 */

import type {
  JupiterLendBorrowMarket,
  JupiterLendBorrowPosition,
  JupiterLendBorrowVault,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";
import {
  computeBorrowPositionRisk,
  formatTenthsAsPercent,
  readLiquidationStatus,
  sumRawDebt,
  unknownBorrowPositionRisk,
  type JupiterLendBorrowLiquidationStatus,
  type JupiterLendBorrowPositionRisk,
} from "./borrow-health.js";

// ── Concise output shapes ────────────────────────────────────────

export interface ConciseJupiterLendBorrowVault {
  /** Pass this as `solana.lend.borrowOperate`'s `vaultId` param. */
  vaultId: string;
  /** Collateral leg mint. Deposits/withdrawals (`depositAmountRaw`/`withdrawAmountRaw`) are denominated in THIS token. */
  supplyTokenAddress: string;
  /** Collateral mint symbol as the provider reports it (e.g. "WSOL" — the wrapped mint, not "SOL"). */
  supplyTokenSymbol: string;
  /** Collateral token decimals — REQUIRED to read `withdrawableRaw` and to build `depositAmountRaw`/`withdrawAmountRaw`. */
  supplyTokenDecimals: number;
  /** Provider's own point-in-time USD quote for the collateral token, exact decimal string (Jupiter's number, not a Vex valuation). */
  supplyTokenPriceUsd: string;
  /** Debt leg mint. Borrows/repayments (`borrowAmountRaw`/`repayAmountRaw`) are denominated in THIS token. */
  borrowTokenAddress: string;
  /** Debt mint symbol as the provider reports it. */
  borrowTokenSymbol: string;
  /** Debt token decimals — REQUIRED to read `borrowableRaw`/`minimumBorrowingRaw` and to build `borrowAmountRaw`/`repayAmountRaw`. */
  borrowTokenDecimals: number;
  /** Provider's own point-in-time USD quote for the debt token, exact decimal string (Jupiter's number, not a Vex valuation). */
  borrowTokenPriceUsd: string;
  /** Max LTV as an exact percent string (e.g. "80.0%") — CONFIRMED scale (see module doc). */
  maxLtvPercent: string | null;
  /** Raw `collateralFactor` exactly as given by the provider (digit string). */
  maxLtvRaw: string;
  /** Liquidation threshold as an exact percent string — scale ASSUMED same as `maxLtvPercent`, NOT independently confirmed (see module doc). */
  liquidationThresholdPercent: string | null;
  /** Raw `liquidationThreshold` exactly as given by the provider (digit string). */
  liquidationThresholdRaw: string;
  /** Available liquidity to borrow, raw atomic units of `borrowTokenAddress` (see `borrowTokenDecimals`). */
  borrowableRaw: string;
  /** Available liquidity to withdraw, raw atomic units of `supplyTokenAddress` (see `supplyTokenDecimals`). */
  withdrawableRaw: string;
  /**
   * Smallest non-zero debt allowed, documented as raw atomic units of
   * `borrowTokenAddress` — read it with `borrowTokenDecimals` (the figure is
   * meaningless without them). SCALE CAVEAT (owner, 2026-07-24): under that
   * documented reading two live vaults disagree by four orders of magnitude
   * (1047061 on a 6-decimal USDC-debt vault ≈ $1.05, 1054 on a 9-decimal
   * WSOL-debt vault ≈ $0.0000002), so the reading is NOT confirmed for
   * non-6-decimal debt tokens. Surfaced verbatim with its decimals and never
   * gated on, rounded, or turned into a USD claim.
   */
  minimumBorrowingRaw: string;
}

/**
 * One position, with the health signal an autonomous agent has no other way
 * to obtain (W4). Token identity is INLINE rather than a cross-reference the
 * agent is told to perform: the raw amounts below are meaningless without
 * their own leg's decimals, and an instruction to go fetch them is not the
 * same thing as the decimals travelling with the amount.
 *
 * Every identity/threshold field is `| null` and NEVER omitted. `null` here
 * always coincides with `risk.status === "unknown"`, whose `reason` says what
 * could not be read and what to do about it.
 */
export interface ConciseJupiterLendBorrowPosition {
  /** Pass this as `solana.lend.borrowOperate`'s `positionId` param to operate on it. */
  positionId: string;
  /** Pass this as `solana.lend.borrowOperate`'s `vaultId`. Also the key into `solana.lend.borrowVaults` for the vault's full config. */
  vaultId: string;
  /** The protocol's OWN liquidation flag. `"unknown"` means the provider did not report it — it does NOT mean the position is healthy. */
  liquidationStatus: JupiterLendBorrowLiquidationStatus;
  /** Collateral leg mint, from the vault. `null` when the vault could not be read (see `risk`). */
  supplyTokenAddress: string | null;
  supplyTokenSymbol: string | null;
  /** REQUIRED to read `supplyRaw` and to build `depositAmountRaw`/`withdrawAmountRaw`. */
  supplyTokenDecimals: number | null;
  /** Collateral, raw atomic units of the collateral token (`supplyTokenDecimals`). */
  supplyRaw: string;
  /** Debt leg mint, from the vault. `null` when the vault could not be read. */
  borrowTokenAddress: string | null;
  borrowTokenSymbol: string | null;
  /** REQUIRED to read `borrowRaw`/`dustBorrowRaw`/`totalDebtRaw` and to build `borrowAmountRaw`/`repayAmountRaw`. */
  borrowTokenDecimals: number | null;
  /** Debt principal, raw atomic units of the debt token. NOT the whole debt — see `totalDebtRaw`. */
  borrowRaw: string;
  /** Accrued-interest residue, ADDITIONAL to `borrowRaw` (see the wire type's `dustBorrow` doc). Raw atomic units of the debt token. */
  dustBorrowRaw: string;
  /** `borrowRaw + dustBorrowRaw` — the true debt, and what `risk` is computed from. `null` only if a raw amount was unreadable. */
  totalDebtRaw: string | null;
  /** The vault's borrow ceiling, exact percent string. A new borrow/withdrawal must keep the position under it. */
  maxLtvPercent: string | null;
  /** The LTV at or above which this position can be liquidated. Provider scale INFERRED, not documented (see module doc) — leave margin. */
  liquidationThresholdPercent: string | null;
  /** Current LTV and distance to liquidation, or a NAMED reason neither could be computed. Branch on `risk.status` before acting. */
  risk: JupiterLendBorrowPositionRisk;
}

/**
 * The vault list the position read's decimals, prices and thresholds come
 * from. A discriminated union rather than a nullable array because "the vault
 * read failed" and "there are no vaults" have opposite safety meanings, and
 * the failure REASON has to reach the agent.
 */
export type BorrowVaultLookup =
  | { readonly status: "read"; readonly vaults: readonly JupiterLendBorrowVault[] }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * `solana.lend.borrowPositions`' full output. The interpretation guidance is
 * stated ONCE here rather than repeated per row — it is long because, with no
 * approval gate in autonomous mode, it is the safety control.
 */
export interface JupiterLendBorrowPositionsReadout {
  readonly market: JupiterLendBorrowMarket;
  /** Whether the vault list backing every decimals/price/threshold below could be read. */
  readonly vaultDataStatus: BorrowVaultLookup["status"];
  /** Why it could not be read. `null` when it was read — never omitted. */
  readonly vaultDataReason: string | null;
  readonly howToReadRisk: string;
  readonly positions: readonly ConciseJupiterLendBorrowPosition[];
}

/**
 * The one place the agent is told how to act on these numbers. Written for an
 * agent mid-mission with no user to ask (owner ruling: disclose, do not
 * block), so it must state what raises and lowers LTV, that `unknown` is not
 * `safe`, and that the threshold's scale is inferred.
 */
const HOW_TO_READ_RISK =
  "Every *Raw value is raw atomic units of the token named beside it: divide by that leg's *Decimals to read it, and "
  + "build solana.lend.borrowOperate amounts in the same scale. totalDebtRaw = borrowRaw + dustBorrowRaw (dust is "
  + "accrued interest, ADDITIONAL to the principal) and is what LTV is computed from. Branch on risk.status before "
  + "acting: \"computed\" means currentLtvPercent and ltvPercentagePointsToLiquidation are usable; "
  + "\"undercollateralized\" means debt against no collateral, already past liquidation; \"unknown\" means the risk "
  + "numbers could NOT be computed and is NOT a statement that the position is safe — read risk.reason, and prefer "
  + "repaying or depositing over borrowing or withdrawing until it clears. LTV is an estimate from Jupiter's own "
  + "point-in-time vault prices at read time, not the protocol's on-chain valuation: it rises when you borrow more or "
  + "withdraw collateral, falls when you repay or deposit, and moves with the market between reads. maxLtvPercent is "
  + "the ceiling a new borrow or withdrawal must stay under; at or above liquidationThresholdPercent the position can "
  + "be liquidated. The liquidation-threshold scale is inferred from provider data rather than documented, so leave "
  + "margin instead of sizing to the last point. liquidationStatus is the provider's own isLiquidated flag — "
  + "\"unknown\" means it was not reported, not that the position is healthy.";

export interface JupiterLendBorrowVaultFilters {
  /** Case-sensitive vault-id allow-list (matches the provider's own numeric `id`, stringified). Omit for all vaults — a filter, never a default cap. */
  vaultIds?: readonly string[];
}

export interface JupiterLendBorrowPositionFilters {
  /** Vault-id allow-list. Omit for all positions. */
  vaultIds?: readonly string[];
}

// ── Filtering + projection ─────────────────────────────────────
//
// `formatTenthsAsPercent` (the provider's raw/10 percent scale) now lives in
// `./borrow-health.ts`, which owns every scale this shelf reads — it was
// hand-copied into `./borrow-risk-preview.ts` as well, and two copies of a
// money scale is one too many.

function matchesVaultIdFilter(vaultId: number, filters: readonly string[]): boolean {
  const idStr = String(vaultId);
  return filters.some((filter) => filter === idStr);
}

function projectVault(vault: JupiterLendBorrowVault): ConciseJupiterLendBorrowVault {
  return {
    vaultId: String(vault.id),
    supplyTokenAddress: vault.supplyToken.address,
    supplyTokenSymbol: vault.supplyToken.symbol,
    supplyTokenDecimals: vault.supplyToken.decimals,
    supplyTokenPriceUsd: vault.supplyToken.price,
    borrowTokenAddress: vault.borrowToken.address,
    borrowTokenSymbol: vault.borrowToken.symbol,
    borrowTokenDecimals: vault.borrowToken.decimals,
    borrowTokenPriceUsd: vault.borrowToken.price,
    maxLtvPercent: formatTenthsAsPercent(vault.collateralFactor),
    maxLtvRaw: vault.collateralFactor,
    liquidationThresholdPercent: formatTenthsAsPercent(vault.liquidationThreshold),
    liquidationThresholdRaw: vault.liquidationThreshold,
    borrowableRaw: vault.borrowable,
    withdrawableRaw: vault.withdrawable,
    minimumBorrowingRaw: vault.minimumBorrowing,
  };
}

/** Project raw `GET /borrow/vaults` results, applying the caller's optional `vaultIds` allow-list first. Tolerates a non-array input defensively (external API response). */
export function projectJupiterLendBorrowVaults(
  vaults: readonly JupiterLendBorrowVault[] | null | undefined,
  filters: JupiterLendBorrowVaultFilters = {},
): ConciseJupiterLendBorrowVault[] {
  const source = Array.isArray(vaults) ? vaults : [];
  const filtered = source.filter((vault) => {
    if (filters.vaultIds && filters.vaultIds.length > 0 && !matchesVaultIdFilter(vault.id, filters.vaultIds)) {
      return false;
    }
    return true;
  });
  return filtered.map(projectVault);
}

/**
 * A position with no readable vault: identity and thresholds are explicitly
 * `null` (never omitted) and the risk block carries the reason. The raw
 * amounts still ship — withholding them would hide the position entirely —
 * but the reason says plainly that their scale is unknown, so they must not
 * be read as token amounts or used to size an operation.
 */
function projectPositionWithoutVault(
  position: JupiterLendBorrowPosition,
  reason: string,
): ConciseJupiterLendBorrowPosition {
  return {
    positionId: String(position.id),
    vaultId: String(position.vaultId),
    liquidationStatus: readLiquidationStatus(position.isLiquidated),
    supplyTokenAddress: null,
    supplyTokenSymbol: null,
    supplyTokenDecimals: null,
    supplyRaw: position.supply,
    borrowTokenAddress: null,
    borrowTokenSymbol: null,
    borrowTokenDecimals: null,
    borrowRaw: position.borrow,
    dustBorrowRaw: position.dustBorrow,
    totalDebtRaw: sumRawDebt(position.borrow, position.dustBorrow),
    maxLtvPercent: null,
    liquidationThresholdPercent: null,
    risk: unknownBorrowPositionRisk(
      `${reason} Without it this position's token decimals, USD prices and risk thresholds are all unknown: do not `
      + "read the raw amounts as token quantities and do not size a borrow or a collateral withdrawal from them.",
    ),
  };
}

function projectPosition(
  position: JupiterLendBorrowPosition,
  vault: JupiterLendBorrowVault,
): ConciseJupiterLendBorrowPosition {
  const totalDebtRaw = sumRawDebt(position.borrow, position.dustBorrow);
  return {
    positionId: String(position.id),
    vaultId: String(position.vaultId),
    liquidationStatus: readLiquidationStatus(position.isLiquidated),
    supplyTokenAddress: vault.supplyToken.address,
    supplyTokenSymbol: vault.supplyToken.symbol,
    supplyTokenDecimals: vault.supplyToken.decimals,
    supplyRaw: position.supply,
    borrowTokenAddress: vault.borrowToken.address,
    borrowTokenSymbol: vault.borrowToken.symbol,
    borrowTokenDecimals: vault.borrowToken.decimals,
    borrowRaw: position.borrow,
    dustBorrowRaw: position.dustBorrow,
    totalDebtRaw,
    maxLtvPercent: formatTenthsAsPercent(vault.collateralFactor),
    liquidationThresholdPercent: formatTenthsAsPercent(vault.liquidationThreshold),
    // LTV is computed from the WHOLE debt, principal + accrued dust.
    // Understating the debt understates LTV, and that is the direction that
    // gets a position liquidated.
    risk: totalDebtRaw === null
      ? unknownBorrowPositionRisk(
        `Position ${position.id}'s debt amounts were not readable as raw atomic integers, so no LTV could be computed.`,
      )
      : computeBorrowPositionRisk({
        vaultId: String(vault.id),
        collateralRaw: position.supply,
        collateralDecimals: vault.supplyToken.decimals,
        collateralPriceUsd: vault.supplyToken.price,
        debtRaw: totalDebtRaw,
        debtDecimals: vault.borrowToken.decimals,
        debtPriceUsd: vault.borrowToken.price,
        liquidationThresholdRaw: vault.liquidationThreshold,
      }),
  };
}

/**
 * Project raw `GET /borrow/positions` results into the health-carrying
 * readout `solana.lend.borrowPositions` returns, applying the caller's
 * optional `vaultIds` allow-list first. Tolerates a non-array input
 * defensively (external API response).
 *
 * `vaults` is passed in rather than fetched here so this stays pure and the
 * handler owns provider I/O — and, critically, so a FAILED vault read is a
 * value this projector can disclose instead of an exception that would take
 * the whole positions read down with it. Disclosure over refusal is the
 * owner's ruling for this surface.
 */
export function projectJupiterLendBorrowPositions(input: {
  readonly positions: readonly JupiterLendBorrowPosition[] | null | undefined;
  readonly market: JupiterLendBorrowMarket;
  readonly vaults: BorrowVaultLookup;
  readonly filters?: JupiterLendBorrowPositionFilters;
}): JupiterLendBorrowPositionsReadout {
  const filters = input.filters ?? {};
  const source = Array.isArray(input.positions) ? input.positions : [];
  const filtered = source.filter((position) => {
    if (filters.vaultIds && filters.vaultIds.length > 0 && !matchesVaultIdFilter(position.vaultId, filters.vaultIds)) {
      return false;
    }
    return true;
  });

  const vaultLookup = input.vaults;
  const positions = filtered.map((position) => {
    if (vaultLookup.status === "unavailable") {
      return projectPositionWithoutVault(
        position,
        `The ${input.market} market's vault list could not be read alongside these positions `
        + `(${vaultLookup.reason}).`,
      );
    }
    const vault = vaultLookup.vaults.find((v) => v.id === position.vaultId);
    if (!vault) {
      return projectPositionWithoutVault(
        position,
        `Vault ${position.vaultId} is not present in the ${input.market} market's current vault list.`,
      );
    }
    return projectPosition(position, vault);
  });

  return {
    market: input.market,
    vaultDataStatus: vaultLookup.status,
    vaultDataReason: vaultLookup.status === "unavailable" ? vaultLookup.reason : null,
    howToReadRisk: HOW_TO_READ_RISK,
    positions,
  };
}
