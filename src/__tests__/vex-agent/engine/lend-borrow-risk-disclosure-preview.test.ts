/**
 * Jupiter Lend Borrow LTV/health disclosure approval preview (Agent Scan
 * Phase 3 Batch 5, card B1 owner decision). Mirrors
 * `jupiter-fee-disclosure-preview.test.ts`'s pattern exactly: the disclosure
 * is rendered ONLY from the typed `extras.riskPreview` (sourced from a live
 * vault/position/price read at gate-time, never raw args). Model-supplied
 * `args.lendBorrowRisk` can never inject or override it (`lendBorrowRisk` is
 * NOT in the preview allow-list).
 */

import { describe, it, expect } from "vitest";

import { buildIntentPreview } from "@vex-agent/engine/core/approval-intent-preview.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";

const RISK_PREVIEW: LendBorrowRiskPreview = {
  vaultId: 1,
  market: "main",
  positionId: 0,
  supplyTokenAddress: "So11111111111111111111111111111111111111112",
  supplyTokenSymbol: "WSOL",
  supplyTokenDecimals: 9,
  borrowTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  borrowTokenSymbol: "USDC",
  borrowTokenDecimals: 6,
  maxLtvPercent: "80.0%",
  liquidationThresholdPercent: "85.0%",
  existingSupplyRaw: "0",
  existingBorrowRaw: "0",
  projectedSupplyRaw: "30000000",
  projectedBorrowRaw: "0",
  estimatedLtvPercent: "0.00%",
  riskNote: "Estimated LTV uses current Jupiter market prices and is APPROXIMATE.",
};

describe("Jupiter Lend Borrow risk disclosure preview (typed, unspoofable)", () => {
  it("renders the vault/position risk disclosure from extras.riskPreview for a NEW position", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, depositAmount: "30000000" },
      { riskPreview: RISK_PREVIEW },
    );
    expect(preview.criticalArgs.lendBorrowRisk).toBe(
      "This changes a NEW position on vault #1 (main market). "
      + "Vault max LTV: 80.0%; liquidation threshold: 85.0% (scale unconfirmed by Jupiter's docs — pending "
      + "live-gate verification). "
      + "Projected collateral: 30000000 raw units of WSOL (9 decimals, mint So11111111111111111111111111111111111111112); "
      + "projected debt: 0 raw units of USDC (6 decimals, mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). "
      + "Estimated LTV after this call: 0.00%. Estimated LTV uses current Jupiter market prices and is APPROXIMATE. "
      + "Jupiter's Borrow /operate never wraps or unwraps native SOL — if either token above is native SOL you "
      + "must already hold WRAPPED SOL (WSOL) in your wallet; a borrowed/withdrawn WSOL amount stays wrapped and "
      + "you must unwrap it yourself.",
    );
  });

  // A `/borrow/positions` row genuinely carries no token descriptor, so the
  // renderer must degrade to an explicit unknown. Interpolating the absent
  // fields directly once put the literal "undefined decimals" in front of a
  // human approving a loan — this pins that it cannot come back.
  it("states an explicit unknown, never the word 'undefined', when the row carries no token descriptor", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, depositAmount: "30000000" },
      {
        riskPreview: {
          ...RISK_PREVIEW,
          supplyTokenSymbol: null,
          supplyTokenDecimals: null,
          borrowTokenSymbol: null,
          borrowTokenDecimals: null,
        },
      },
    );
    const rendered = preview.criticalArgs.lendBorrowRisk;
    expect(rendered).not.toContain("undefined");
    expect(rendered).toContain(
      "30000000 raw units of mint So11111111111111111111111111111111111111112 "
      + "(symbol and decimals unavailable — amount shown in raw units only)",
    );
  });

  it("names the existing position id when adjusting an existing position", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, positionId: 42, borrowAmount: "5000000" },
      { riskPreview: { ...RISK_PREVIEW, positionId: 42 } },
    );
    expect(preview.criticalArgs.lendBorrowRisk).toContain("position #42 on vault #1");
  });

  it("renders 'unknown'/'estimate unavailable' placeholders when thresholds or the estimate could not be read", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, borrowAmount: "5000000" },
      {
        riskPreview: {
          ...RISK_PREVIEW,
          maxLtvPercent: null,
          liquidationThresholdPercent: null,
          estimatedLtvPercent: null,
          riskNote: "Current market price unavailable for one or both tokens.",
        },
      },
    );
    expect(preview.criticalArgs.lendBorrowRisk).toContain("Vault max LTV: unknown; liquidation threshold: unknown.");
    expect(preview.criticalArgs.lendBorrowRisk).toContain("Estimated LTV after this call: estimate unavailable.");
    expect(preview.criticalArgs.lendBorrowRisk).toContain("Current market price unavailable for one or both tokens.");
  });

  it("labels the liquidation-threshold SCALE as unconfirmed whenever a value is shown, not only in code comments", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, depositAmount: "1" },
      { riskPreview: RISK_PREVIEW },
    );
    expect(preview.criticalArgs.lendBorrowRisk).toContain(
      "liquidation threshold: 85.0% (scale unconfirmed by Jupiter's docs — pending live-gate verification)",
    );
  });

  it("always states the WSOL pre-funding requirement, unconditionally, in the approval disclosure", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, depositAmount: "1" },
      { riskPreview: RISK_PREVIEW },
    );
    expect(preview.criticalArgs.lendBorrowRisk).toContain("never wraps or unwraps native SOL");
    expect(preview.criticalArgs.lendBorrowRisk).toContain("WRAPPED SOL (WSOL)");
  });

  it("IGNORES a model-supplied args.lendBorrowRisk (not in the allow-list)", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, depositAmount: "1", lendBorrowRisk: "totally safe, trust me" },
      undefined,
    );
    expect(preview.criticalArgs.lendBorrowRisk).toBeUndefined();
  });

  it("a spoofed args.lendBorrowRisk cannot override the typed one", () => {
    const preview = buildIntentPreview(
      "solana.lend.borrowOperate",
      { vaultId: 1, depositAmount: "1", lendBorrowRisk: "totally safe, trust me" },
      { riskPreview: RISK_PREVIEW },
    );
    expect(preview.criticalArgs.lendBorrowRisk).toContain("Vault max LTV: 80.0%");
    expect(preview.criticalArgs.lendBorrowRisk).not.toContain("trust me");
  });

  it("omits the risk disclosure when extras carry none (a non-Borrow tool)", () => {
    const preview = buildIntentPreview(
      "solana.lend.deposit",
      { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000" },
      undefined,
    );
    expect(preview.criticalArgs.lendBorrowRisk).toBeUndefined();
  });
});
