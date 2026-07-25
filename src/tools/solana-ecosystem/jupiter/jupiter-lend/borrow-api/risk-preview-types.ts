/**
 * `LendBorrowRiskPreview` — the Jupiter Lend Borrow LTV/health disclosure
 * shape shown in a restricted-mode approval preview before
 * `solana.lend.borrowOperate` (Agent Scan Phase 3 Batch 5, card B1).
 *
 * Deliberately kept in the SDK layer (zero imports beyond this shelf's own
 * wire types) rather than alongside the evaluator that COMPUTES it
 * (`vex-agent/tools/protocols/solana-jupiter/borrow-risk-preview.ts`, which
 * needs wallet resolution + `ProtocolExecutionContext`): `vex-agent/tools/
 * types.ts` (`ToolResult.prequote.riskPreview`) and `vex-agent/tools/
 * protocols/runtime/gates.ts` both need this TYPE without pulling in the
 * evaluator's higher-layer dependencies — mirrors how `JupiterFeePreview`
 * (`src/tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.ts`) already
 * crosses the SAME two call sites from the SDK layer.
 */

import type { JupiterLendBorrowMarket } from "./types.js";

export interface LendBorrowRiskPreview {
  readonly vaultId: number;
  readonly market: JupiterLendBorrowMarket;
  /** `0` = a NEW position is being created by this call. */
  readonly positionId: number;
  readonly supplyTokenAddress: string;
  /**
   * Collateral mint symbol + decimals, copied from the vault the preview was
   * computed against. Without `decimals` the raw amounts below are
   * uninterpretable to the human approving them (a `1047061` debt is 1.05 at
   * 6 decimals and 0.00105 at 9) — see `borrow-projector.ts`'s token-identity
   * note. `uiSymbol` is deliberately not mirrored: it renders WSOL as "SOL",
   * and `/operate` never wraps native SOL.
   */
  readonly supplyTokenSymbol: string;
  readonly supplyTokenDecimals: number;
  readonly borrowTokenAddress: string;
  /** Debt mint symbol + decimals — same reason as the supply leg above. */
  readonly borrowTokenSymbol: string;
  readonly borrowTokenDecimals: number;
  /** Vault's own max-LTV threshold, CONFIRMED scale (see `borrow-projector.ts`). `null` if the vault could not be read. */
  readonly maxLtvPercent: string | null;
  /** Vault's own liquidation threshold, ASSUMED scale (see `borrow-projector.ts`). `null` if the vault could not be read. */
  readonly liquidationThresholdPercent: string | null;
  readonly existingSupplyRaw: string;
  readonly existingBorrowRaw: string;
  readonly projectedSupplyRaw: string;
  readonly projectedBorrowRaw: string;
  /** Best-effort current-market-price LTV estimate. `null` when price data was unavailable or the amount was too large to estimate safely — see `riskNote`. */
  readonly estimatedLtvPercent: string | null;
  /** Always present — explains what the estimate is based on, or why it is unavailable. Never silently omitted. */
  readonly riskNote: string;
}
