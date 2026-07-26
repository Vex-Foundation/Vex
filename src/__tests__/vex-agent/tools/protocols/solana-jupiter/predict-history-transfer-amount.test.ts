/**
 * `GET /history` — `transferAmountToken` unit labelling (phase-3 W2).
 *
 * The defect: the field reached the agent as `transferAmountTokenRaw:
 * "266025"` — a bare integer with NO mint and NO decimals, sitting among a
 * dozen converted `*Usd` dollar strings. "A raw amount must travel with the
 * decimals needed to read it" is the standing money rule; this field broke it.
 *
 * Driven by the REAL tracked recording (`fixtures/prediction/history-rows.json`,
 * captured 2026-07-25 while the gate wallet actually held a position), not a
 * hand-written shape — the same fixture whose absence let the 2026-07-25
 * outage through when only the empty-list case was encoded.
 *
 * The asset is JupUSD, and this fixture is itself part of the proof: on the
 * `order_closed` row, `transferAmountToken` (266025) equals both
 * `depositAmountUsd − totalCostUsd − feeUsd` across the order's rows
 * (4994898 − 4665593 − 63280) and the wallet's observed on-chain JupUSD credit
 * over the same window (4999 → 271024).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { jupiterPredictionHistoryResponseSchema } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/schemas/history.js";
import type { JupiterPredictionHistoryEvent } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/types.js";
import {
  convertPredictionHistoryEventMoney,
  describePredictionTransferAmount,
} from "@vex-agent/tools/protocols/solana-jupiter/predict-money.js";
import {
  JUPITER_PREDICTION_PAYOUT_DECIMALS,
  JUPITER_PREDICTION_PAYOUT_MINT,
  JUPITER_PREDICTION_PAYOUT_SYMBOL,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";

const history = jupiterPredictionHistoryResponseSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../../solana/fixtures/prediction/history-rows.json"),
      "utf8",
    ),
  ),
);

function projectRow(index: number): Record<string, unknown> {
  const row = history.data[index];
  if (!row) throw new Error(`fixture has no history row at index ${index}`);
  return convertPredictionHistoryEventMoney(row as JupiterPredictionHistoryEvent);
}

describe("convertPredictionHistoryEventMoney — transferAmountToken carries its unit", () => {
  it("labels a real transfer amount with mint, symbol, decimals AND an exact human rendering", () => {
    const projected = projectRow(0); // order_closed, transferAmountToken "266025"

    expect(projected.transferAmountTokenRaw).toBe("266025");
    expect(projected.transferAmountTokenMint).toBe(JUPITER_PREDICTION_PAYOUT_MINT);
    expect(projected.transferAmountTokenSymbol).toBe(JUPITER_PREDICTION_PAYOUT_SYMBOL);
    expect(projected.transferAmountTokenDecimals).toBe(JUPITER_PREDICTION_PAYOUT_DECIMALS);
    // 266025 at 6 decimals. NOT 266,025 and not $266,025 — the ambiguity the label removes.
    expect(projected.transferAmountTokenHuman).toBe("0.266025");
  });

  it("keeps the wire field name retired — the raw value is only reachable under its explicit *Raw label", () => {
    const projected = projectRow(0);
    expect(projected).not.toHaveProperty("transferAmountToken");
  });

  it("a null transfer amount stays null across every sibling — never a fabricated 0", () => {
    const projected = projectRow(2); // order_created, transferAmountToken null

    expect(projected.transferAmountTokenRaw).toBeNull();
    expect(projected.transferAmountTokenMint).toBeNull();
    expect(projected.transferAmountTokenSymbol).toBeNull();
    expect(projected.transferAmountTokenDecimals).toBeNull();
    expect(projected.transferAmountTokenHuman).toBeNull();
  });

  it("labels every row in the real fixture consistently", () => {
    expect(history.data).toHaveLength(3);
    for (const [index, row] of history.data.entries()) {
      const projected = projectRow(index);
      const labelled = row.transferAmountToken !== null;
      expect(projected.transferAmountTokenMint).toBe(labelled ? JUPITER_PREDICTION_PAYOUT_MINT : null);
      expect(projected.transferAmountTokenRaw).toBe(row.transferAmountToken);
    }
  });

  it("does NOT touch the micro-USD conversion of the surrounding dollar fields", () => {
    const projected = projectRow(1); // order_filled
    expect(projected.totalCostUsd).toBe("4.665593");
    expect(projected.totalCostUsdMicro).toBe("4665593");
    expect(projected.feeUsd).toBe("0.063280");
  });
});

describe("describePredictionTransferAmount — degrade, never fabricate", () => {
  it("keeps a non-integer raw value but refuses to invent a human rendering", () => {
    const described = describePredictionTransferAmount("not-a-number");
    expect(described.transferAmountTokenRaw).toBe("not-a-number");
    expect(described.transferAmountTokenHuman).toBeNull();
    // The asset identity is still stated — it is a property of the protocol,
    // not of whether this particular value parsed.
    expect(described.transferAmountTokenMint).toBe(JUPITER_PREDICTION_PAYOUT_MINT);
  });

  it("renders a negative amount exactly, sign preserved", () => {
    expect(describePredictionTransferAmount("-266025").transferAmountTokenHuman).toBe("-0.266025");
  });

  it("treats undefined like null", () => {
    expect(describePredictionTransferAmount(undefined).transferAmountTokenRaw).toBeNull();
  });
});
