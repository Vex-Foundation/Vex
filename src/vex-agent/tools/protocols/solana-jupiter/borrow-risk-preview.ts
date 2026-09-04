/**
 * Jupiter Lend Borrow pre-approval LTV/health risk disclosure (Agent Scan
 * Phase 3 Batch 5, card B1 owner decision: "Approval preview MUST show
 * LTV/health risk semantics before approval"; hardened in card B3 - a Codex
 * batch-5 blocker on B1's original implementation).
 *
 * The public Borrow REST API exposes NO computed `ltv`/`healthFactor` field
 * on either `vaults` or `positions` (verified live) - only the vault's own
 * risk THRESHOLDS (`collateralFactor`/`liquidationThreshold`, see
 * `../../../../tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/
 * JupiterLendBorrowApi.md`'s unit-scale caveat) and raw supply/borrow
 * amounts. A genuine current-LTV number needs a USD price for both the
 * supply and borrow tokens, which this module fetches best-effort via the
 * existing `jupiter-prices` service (the SAME provider-supplied FLOAT price
 * every other "estimated" USD valuation in this repo already uses - see W5
 * design R3's `amountBasis:'estimated'` doctrine).
 *
 * B3 correction (Codex blocker): a PRICE-lookup failure is still a graceful,
 * non-blocking degrade (identity/balances/thresholds always show; the
 * estimate alone says "estimate unavailable" - see `estimateLtv`). But an
 * EXISTING-POSITION lookup failure (positionId > 0 and the position fetch
 * throws, or no row matches this wallet's owner + this vault + this
 * position id) is DIFFERENT: silently defaulting to zero collateral/debt
 * would show a restricted human a falsely-safe preview for an operation that
 * may in fact be adjusting a large existing position. `evaluateLendBorrowRiskPreview`
 * therefore returns a 3-way `LendBorrowRiskPreviewOutcome` - `"confirmed"`
 * (safe to show / auto-execute), `"not_applicable"` (params don't resolve to
 * a real operate request - the handler's own validation will surface that),
 * or `"unverifiable"` (a safety-relevant read could not be confirmed) - and
 * `runtime/gates.ts` MUST refuse to enqueue an approval on `"unverifiable"`
 * rather than show an unverified preview or none at all.
 *
 * Money-math discipline: the EXACT raw collateral/debt amounts
 * (`existingSupplyRaw`/`projectedSupplyRaw`/etc.) are ALWAYS bigint-string
 * arithmetic, never `Number`. The ONLY floating-point step is the labeled
 * `estimatedLtvPercent`, and even that backs off (stays `null`) when a raw
 * amount is too large for a `Number` conversion to stay trustworthy for a
 * mere estimate (see `MAX_SAFE_ESTIMATE_DIGITS`).
 *
 * Called from `runtime/gates.ts` (mirrors the existing Jupiter fee-preview /
 * Pendle term-lock typed-extras channel) - NOT persisted anywhere; computed
 * fresh, in-memory, for the one approval-gate decision that needs it.
 */

import {
  getJupiterLendBorrowPositions,
  getJupiterLendBorrowVaults,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/service.js";
import { JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";
import type {
  JupiterLendBorrowPosition,
  JupiterLendBorrowToken,
  JupiterLendBorrowVault,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";
import { getJupiterPricesByMint } from "@tools/solana-ecosystem/jupiter/jupiter-prices/service.js";

import type { ProtocolExecutionContext } from "../types.js";
import { summarizeProtocolError } from "../runtime/errors.js";
import { walletAddress } from "./handlers/core.js";
import { resolveBorrowOperateRequest, type BorrowOperateResolvedRequest } from "./borrow-operate-params.js";
// The provider's raw/10 percent scale. Was hand-copied here AND into
// `./borrow-projector.ts`; W4 gave it one owner in `./borrow-health.ts`,
// which the autonomous-mode read path also uses. Same function, same
// confirmed-vs-assumed scale caveat - see that module's doc.
import { formatTenthsAsPercent } from "./borrow-health.js";

/** Amounts with more digits than this are not converted to `Number` for the USD estimate - the estimate degrades to unavailable rather than risk float-precision drift on an enormous position. Exact raw strings are never affected by this guard. */
const MAX_SAFE_ESTIMATE_DIGITS = 15;

function clampToZero(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function projectLeg(existing: bigint, delta: string): bigint {
  if (delta === JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL) return 0n;
  return clampToZero(existing + BigInt(delta));
}

// ── Outcome (B3: existing-position failures must BLOCK, never degrade) ────

export type LendBorrowRiskPreviewOutcome =
  /** Agent params don't resolve to a real `/operate` request - the handler's own validation surfaces the error; nothing risk-relevant to preview or block on. */
  | { readonly kind: "not_applicable" }
  /** Safe to show (or auto-execute past). `preview.estimatedLtvPercent` may still be `null` - that is a graceful, disclosed degrade, not a block. */
  | { readonly kind: "confirmed"; readonly preview: LendBorrowRiskPreview }
  /** A safety-relevant read (wallet identity, the vault, or an EXISTING position) could not be confirmed - the caller MUST refuse to enqueue approval rather than show an unverified or absent preview. */
  | { readonly kind: "unverifiable"; readonly reason: string };

/**
 * Best-effort LTV/health disclosure for `solana.lend.borrowOperate`, read
 * from the SAME resolved request the handler will use (via
 * `resolveBorrowOperateRequest`).
 */
export async function evaluateLendBorrowRiskPreview(
  params: Record<string, unknown>,
  ctx: ProtocolExecutionContext,
): Promise<LendBorrowRiskPreviewOutcome> {
  const resolution = resolveBorrowOperateRequest(params);
  if (!resolution.ok) return { kind: "not_applicable" };
  const resolved = resolution.request;

  let addr: string;
  try {
    addr = walletAddress(params, ctx);
  } catch (err) {
    return {
      kind: "unverifiable",
      reason: `Could not resolve the acting wallet for this session: ${summarizeProtocolError(err).message}`,
    };
  }

  return buildRiskPreview(resolved, addr);
}

async function buildRiskPreview(
  resolved: BorrowOperateResolvedRequest,
  walletAddr: string,
): Promise<LendBorrowRiskPreviewOutcome> {
  let vaults: readonly JupiterLendBorrowVault[];
  try {
    vaults = await getJupiterLendBorrowVaults(resolved.market);
  } catch (err) {
    return {
      kind: "unverifiable",
      reason: `Could not read the ${resolved.market} market's vault data: ${summarizeProtocolError(err).message}`,
    };
  }
  const vault = vaults.find((v) => v.id === resolved.vaultId) ?? null;
  if (!vault) {
    return {
      kind: "unverifiable",
      reason: `Vault ${resolved.vaultId} was not found in the ${resolved.market} market - its risk thresholds cannot be confirmed.`,
    };
  }

  let existingSupply = 0n;
  let existingBorrow = 0n;
  if (resolved.positionId > 0) {
    let positions: readonly JupiterLendBorrowPosition[];
    try {
      positions = await getJupiterLendBorrowPositions(walletAddr, resolved.market);
    } catch (err) {
      return {
        kind: "unverifiable",
        reason: `Could not read your existing position #${resolved.positionId} before this call: `
          + `${summarizeProtocolError(err).message}. Refusing to assume it has zero collateral/debt.`,
      };
    }
    // Match owner + vault + position identity - NEVER `positionId` alone
    // (B3 Codex blocker: the provider scopes ids per MARKET, not globally,
    // and a stale/mismatched vaultId or a different wallet's row must never
    // be silently accepted as "this call's existing position").
    const position = positions.find(
      (p) => p.id === resolved.positionId && p.vaultId === resolved.vaultId && p.ownerAddress === walletAddr,
    ) ?? null;
    if (!position) {
      return {
        kind: "unverifiable",
        reason: `Position #${resolved.positionId} on vault ${resolved.vaultId} (${resolved.market} market) was not `
          + "found for this wallet - refusing to assume it has zero collateral/debt.",
      };
    }
    existingSupply = BigInt(position.supply);
    // `dustBorrow` is ADDITIONAL residual (accrued-interest) debt, not a
    // component already inside `borrow` - see types.ts's `dustBorrow` doc
    // and the fixture README's citation. True existing debt is the sum.
    existingBorrow = BigInt(position.borrow) + BigInt(position.dustBorrow);
  }

  const projectedSupply = projectLeg(existingSupply, resolved.colAmount);
  const projectedBorrow = projectLeg(existingBorrow, resolved.debtAmount);

  const { estimatedLtvPercent, riskNote } = await estimateLtv(
    vault.supplyToken, vault.borrowToken, projectedSupply, projectedBorrow,
  );

  return {
    kind: "confirmed",
    preview: {
      vaultId: resolved.vaultId,
      market: resolved.market,
      positionId: resolved.positionId,
      supplyTokenAddress: vault.supplyToken.address,
      supplyTokenSymbol: vault.supplyToken.symbol,
      supplyTokenDecimals: vault.supplyToken.decimals,
      borrowTokenAddress: vault.borrowToken.address,
      borrowTokenSymbol: vault.borrowToken.symbol,
      borrowTokenDecimals: vault.borrowToken.decimals,
      maxLtvPercent: formatTenthsAsPercent(vault.collateralFactor),
      liquidationThresholdPercent: formatTenthsAsPercent(vault.liquidationThreshold),
      existingSupplyRaw: existingSupply.toString(),
      existingBorrowRaw: existingBorrow.toString(),
      projectedSupplyRaw: projectedSupply.toString(),
      projectedBorrowRaw: projectedBorrow.toString(),
      estimatedLtvPercent,
      riskNote,
    },
  };
}

/**
 * B4 (Codex blocker): the raw `projectedSupply`/`projectedBorrow` amounts are
 * in the VAULT's own `supplyToken`/`borrowToken` base units (B3's confirmed
 * REST unit contract - see `types.ts`'s doc), NEVER the Price API's own
 * `decimals` field, which describes a different surface (a wrapped/bridged
 * variant, a stale cache entry, or a provider bug could all make the two
 * disagree for the exact same mint). If they disagree, an estimate computed
 * under the WRONG decimals could silently understate risk - degrade to
 * unavailable instead of guessing.
 */
async function estimateLtv(
  supplyToken: JupiterLendBorrowToken,
  borrowToken: JupiterLendBorrowToken,
  projectedSupply: bigint,
  projectedBorrow: bigint,
): Promise<{ estimatedLtvPercent: string | null; riskNote: string }> {
  if (
    projectedSupply.toString().length > MAX_SAFE_ESTIMATE_DIGITS
    || projectedBorrow.toString().length > MAX_SAFE_ESTIMATE_DIGITS
  ) {
    return {
      estimatedLtvPercent: null,
      riskNote: "Position size too large to estimate a current LTV safely - compare the raw collateral/debt "
        + "amounts above against the vault's max LTV / liquidation threshold yourself before approving.",
    };
  }

  const prices = await getJupiterPricesByMint([supplyToken.address, borrowToken.address]).catch(() => null);
  const supplyPrice = prices?.[supplyToken.address];
  const borrowPrice = prices?.[borrowToken.address];
  if (!prices || !supplyPrice || !borrowPrice) {
    return {
      estimatedLtvPercent: null,
      riskNote: "Current market price unavailable for one or both tokens - a current-LTV estimate could not be "
        + "computed. Compare the raw collateral/debt amounts above against the vault's max LTV / liquidation "
        + "threshold yourself before approving.",
    };
  }

  if (supplyPrice.decimals !== supplyToken.decimals || borrowPrice.decimals !== borrowToken.decimals) {
    return {
      estimatedLtvPercent: null,
      riskNote: "The Price API's token-decimals metadata does not match the vault's own token decimals for one or "
        + "both tokens - a current-LTV estimate could not be safely computed. Compare the raw collateral/debt "
        + "amounts above against the vault's max LTV / liquidation threshold yourself before approving.",
    };
  }

  const collateralUsd = (Number(projectedSupply) / 10 ** supplyToken.decimals) * supplyPrice.usdPrice;
  const debtUsd = (Number(projectedBorrow) / 10 ** borrowToken.decimals) * borrowPrice.usdPrice;
  const estimatedLtvPercent = collateralUsd > 0
    ? `${((debtUsd / collateralUsd) * 100).toFixed(2)}%`
    : debtUsd > 0 ? ">9999%" : "0.00%";

  return {
    estimatedLtvPercent,
    // B4 (Codex blocker): do NOT claim the liquidation threshold is
    // protocol-confirmed here - its scale is still unconfirmed (see the
    // "(scale unconfirmed...)" label the disclosure attaches whenever it is
    // shown, `engine/core/approval-intent-preview.ts`); this note must never
    // contradict that label.
    riskNote: "Estimated LTV uses current Jupiter market prices and is APPROXIMATE - it is not the protocol's own "
      + "on-chain valuation and may differ, especially near liquidation. Compare it against the vault's max LTV "
      + "and liquidation threshold above before approving.",
  };
}
