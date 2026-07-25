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
  JupiterLendBorrowPosition,
  JupiterLendBorrowVault,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";

// ── Concise output shapes ────────────────────────────────────────

export interface ConciseJupiterLendBorrowVault {
  /** Pass this as `solana.lend.borrowOperate`'s `vaultId` param. */
  vaultId: string;
  /** Collateral leg mint. Deposits/withdrawals (`depositAmount`/`withdrawAmount`) are denominated in THIS token. */
  supplyTokenAddress: string;
  /** Collateral mint symbol as the provider reports it (e.g. "WSOL" — the wrapped mint, not "SOL"). */
  supplyTokenSymbol: string;
  /** Collateral token decimals — REQUIRED to read `withdrawableRaw` and to build `depositAmount`/`withdrawAmount`. */
  supplyTokenDecimals: number;
  /** Provider's own point-in-time USD quote for the collateral token, exact decimal string (Jupiter's number, not a Vex valuation). */
  supplyTokenPriceUsd: string;
  /** Debt leg mint. Borrows/repayments (`borrowAmount`/`repayAmount`) are denominated in THIS token. */
  borrowTokenAddress: string;
  /** Debt mint symbol as the provider reports it. */
  borrowTokenSymbol: string;
  /** Debt token decimals — REQUIRED to read `borrowableRaw`/`minimumBorrowingRaw` and to build `borrowAmount`/`repayAmount`. */
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

export interface ConciseJupiterLendBorrowPosition {
  /** Pass this as `solana.lend.borrowOperate`'s `positionId` param to operate on it. */
  positionId: string;
  /** Cross-reference against `solana.lend.borrowVaults`'s `vaultId` for token identity, DECIMALS (the `*Raw` amounts below are unreadable without them), and risk thresholds. */
  vaultId: string;
  /** Collateral, raw atomic units of the vault's `supplyToken` (its `supplyTokenDecimals`). */
  supplyRaw: string;
  /** Debt (excluding dust), raw atomic units of the vault's `borrowToken` (its `borrowTokenDecimals`). */
  borrowRaw: string;
  /** Residual debt including accrued interest, ADDITIONAL to `borrowRaw` — true total debt is `borrowRaw + dustBorrowRaw` (see `../../../../tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.ts`'s `dustBorrow` doc). Raw atomic units of the vault's `borrowToken`. */
  dustBorrowRaw: string;
}

export interface JupiterLendBorrowVaultFilters {
  /** Case-sensitive vault-id allow-list (matches the provider's own numeric `id`, stringified). Omit for all vaults — a filter, never a default cap. */
  vaultIds?: readonly string[];
}

export interface JupiterLendBorrowPositionFilters {
  /** Vault-id allow-list. Omit for all positions. */
  vaultIds?: readonly string[];
}

// ── Percent formatting (string math only — see module doc) ───────

/** `collateralFactor`/`liquidationThreshold`: raw/10 = percent (one implied decimal digit). */
const LTV_PERCENT_DECIMALS = 1;

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/** Format a raw/10-scaled digit-string as an exact percent string via pure decimal-point shifting. `null` for a malformed (non-digit-string) raw value — read endpoints are validated permissively, so a bad value degrades to "unknown", never a fabricated percent. */
function formatTenthsAsPercent(raw: string): string | null {
  const match = /^(-?)(\d+)$/.exec(raw);
  if (!match) return null;
  const sign = match[1] ?? "";
  const digits = match[2];
  if (digits === undefined) return null;
  const padded = digits.padStart(LTV_PERCENT_DECIMALS + 1, "0");
  const wholePart = stripLeadingZeros(padded.slice(0, -LTV_PERCENT_DECIMALS));
  const fractionPart = padded.slice(-LTV_PERCENT_DECIMALS);
  return `${sign}${wholePart}.${fractionPart}%`;
}

// ── Filtering + projection ─────────────────────────────────────

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

function projectPosition(position: JupiterLendBorrowPosition): ConciseJupiterLendBorrowPosition {
  return {
    positionId: String(position.id),
    vaultId: String(position.vaultId),
    supplyRaw: position.supply,
    borrowRaw: position.borrow,
    dustBorrowRaw: position.dustBorrow,
  };
}

/** Project raw `GET /borrow/positions` results, applying the caller's optional `vaultIds` allow-list first. Tolerates a non-array input defensively. */
export function projectJupiterLendBorrowPositions(
  positions: readonly JupiterLendBorrowPosition[] | null | undefined,
  filters: JupiterLendBorrowPositionFilters = {},
): ConciseJupiterLendBorrowPosition[] {
  const source = Array.isArray(positions) ? positions : [];
  const filtered = source.filter((position) => {
    if (filters.vaultIds && filters.vaultIds.length > 0 && !matchesVaultIdFilter(position.vaultId, filters.vaultIds)) {
      return false;
    }
    return true;
  });
  return filtered.map(projectPosition);
}
