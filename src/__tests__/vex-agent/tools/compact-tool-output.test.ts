/**
 * Model-facing tool result text is COMPACT JSON: the `output` string is sent
 * to the model on every later round, so indentation is pure prompt weight.
 * The values must be exactly what the pretty form carried; only whitespace
 * between tokens is gone. The host renderer parses the text and pretty-prints
 * it itself, so nothing visible depends on the indentation.
 */

import { describe, it, expect } from "vitest";

import { ok } from "@vex-agent/tools/internal/wallet/send/results.js";
import { withApprovedGasFees } from "@vex-agent/tools/protocols/quote-authority/fee-ceiling-disclosure.js";
import { boundDebitPlanSchema } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";

const payload = {
  txHash: "0xabc",
  chain: "base",
  status: "confirmed",
  nested: { amounts: ["1.5", "2"], note: "line one\nline two" },
};

describe("compact model-facing tool output", () => {
  it("wallet send ok() emits compact JSON with the same values", () => {
    const result = ok(payload);
    expect(result.output).toBe(JSON.stringify(payload));
    expect(result.output).not.toMatch(/\n\s/);
    expect(JSON.parse(result.output)).toEqual(payload);
    expect(result.output.length).toBeLessThan(JSON.stringify(payload, null, 2).length);
  });

  it("gas-fee ceiling disclosure keeps a JSON output compact and value-equal", () => {
    const plan = boundDebitPlanSchema.parse({
      feeHeadroomBps: 2_000,
      legs: [{
        role: "swap",
        feeCap: { mode: "eip1559", maxFeePerGasWei: "100", maxPriorityFeePerGasWei: "2" },
        pricing: "measured",
      }],
      reserve: {
        kind: "zero_value_self_transfer",
        feeCap: { mode: "legacy", gasPriceWei: "50" },
      },
    });
    const result = withApprovedGasFees(
      { success: true, output: JSON.stringify(payload, null, 2) },
      plan,
    );
    const approvedGasFees = {
      unit: "wei/gas",
      feeHeadroomBps: 2_000,
      legs: [{
        role: "swap",
        feeCap: { mode: "eip1559", maxFeePerGasWei: "100", maxPriorityFeePerGasWei: "2" },
      }],
      gasUnits: "freshly estimated; no fixed total gas bill",
    };
    expect(result.output).not.toMatch(/\n\s/);
    expect(JSON.parse(result.output)).toEqual({ ...payload, approvedGasFees });
    expect(result.success).toBe(true);
  });

  it("gas-fee ceiling disclosure leaves a prose output as prose", () => {
    const plan = boundDebitPlanSchema.parse({
      legs: [{ role: "swap", feeCap: { mode: "legacy", gasPriceWei: "7" }, pricing: "conservative" }],
      reserve: { kind: "zero_value_self_transfer", feeCap: { mode: "legacy", gasPriceWei: "7" } },
    });
    const result = withApprovedGasFees({ success: false, output: "Broadcast status unknown." }, plan);
    expect(result.output.startsWith("Broadcast status unknown.\nApproved gas fee ceilings: {")).toBe(true);
    expect(result.success).toBe(false);
  });
});
