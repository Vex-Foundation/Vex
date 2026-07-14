/**
 * Synthetic capture contract (B-006).
 *
 * Synthetic captures (settlement_sync.*) bypass MUTATION_MATRIX, so
 * synthetic-capture.ts owns their boundary contract. These tests pin:
 * - unknown synthetic tool-ids REJECT (no fail-open for the synthetic family),
 * - the wallet/position/valuation triple is required and each missing field
 *   is reported,
 * - the type discriminator must match the registered contract,
 * - the real settlement_sync.jupiter / .polymarket captures pass.
 */

import { describe, it, expect, vi } from "vitest";

// Stub the pipeline import chain — we only exercise the pure validator here.
vi.mock("@vex-agent/tools/protocols/capture-pipeline.js", () => ({
  extractExternalRefs: vi.fn().mockReturnValue({}),
  populateCaptureItems: vi.fn().mockResolvedValue(undefined),
}));

const { validateSyntheticCapture, isSyntheticToolId } = await import(
  "../../../vex-agent/sync/synthetic-capture.js"
);

// Minimal valid prediction capture for an allowlisted synthetic source.
function validCapture(): Record<string, unknown> {
  return {
    type: "prediction",
    status: "closed",
    walletAddress: "GoVYsnz1111",
    positionKey: "PK1",
    instrumentKey: "solana:predict:POLY-123:yes",
    valuationSource: "none",
  };
}

function validHyperliquidCapture(): Record<string, unknown> {
  return {
    type: "perps",
    status: "open",
    walletAddress: "0x1111111111111111111111111111111111111111",
    positionKey: "hyperliquid:perp:BTC:0x1111111111111111111111111111111111",
    instrumentKey: "hyperliquid:perp:BTC",
    valuationSource: "hyperliquid_clearinghouse",
  };
}

describe("isSyntheticToolId", () => {
  it("recognizes the registered synthetic sources", () => {
    expect(isSyntheticToolId("settlement_sync.jupiter")).toBe(true);
    expect(isSyntheticToolId("settlement_sync.polymarket")).toBe(true);
    expect(isSyntheticToolId("hyperliquid_reconcile.position")).toBe(true);
  });

  it("matches by family prefix so unregistered settlement_sync.* still routes to the validator", () => {
    // Membership is by prefix, not allowlist — an unregistered member is
    // still "synthetic" so it gets rejected by the validator rather than
    // falling through to the fail-open non-synthetic path.
    expect(isSyntheticToolId("settlement_sync.unknown")).toBe(true);
    expect(isSyntheticToolId("hyperliquid_reconcile.unknown")).toBe(true);
  });

  it("does not match non-synthetic tool-ids or the bare prefix word", () => {
    expect(isSyntheticToolId("kyberswap.swap.sell")).toBe(false);
    expect(isSyntheticToolId("settlement_sync")).toBe(false); // no trailing dot
    expect(isSyntheticToolId("")).toBe(false);
  });
});

describe("validateSyntheticCapture — allowlist", () => {
  it("rejects an unknown synthetic tool-id", () => {
    expect(() => validateSyntheticCapture("settlement_sync.unknown", validCapture()))
      .toThrow(/unknown synthetic tool-id/);
  });

  it("accepts a valid settlement_sync.jupiter capture", () => {
    expect(() => validateSyntheticCapture("settlement_sync.jupiter", validCapture())).not.toThrow();
  });

  it("accepts a valid settlement_sync.polymarket capture", () => {
    const cap = { ...validCapture(), walletAddress: "0xEOA", positionKey: "polymarket:0xCOND1:YES" };
    expect(() => validateSyntheticCapture("settlement_sync.polymarket", cap)).not.toThrow();
  });

  it("accepts a valid Hyperliquid reconciliation capture", () => {
    expect(() => validateSyntheticCapture("hyperliquid_reconcile.position", validHyperliquidCapture())).not.toThrow();
  });
});

describe("validateSyntheticCapture — required field rejection", () => {
  it.each(["walletAddress", "positionKey", "valuationSource"] as const)(
    "rejects when %s is missing",
    (field) => {
      const cap = validCapture();
      delete cap[field];
      expect(() => validateSyntheticCapture("settlement_sync.jupiter", cap))
        .toThrow(new RegExp(`missing required field\\(s\\)[^]*${field}`));
    },
  );

  it.each(["walletAddress", "positionKey", "valuationSource"] as const)(
    "rejects when %s is an empty string",
    (field) => {
      const cap = { ...validCapture(), [field]: "" };
      expect(() => validateSyntheticCapture("settlement_sync.jupiter", cap)).toThrow(/missing required field/);
    },
  );

  it("rejects when type is missing", () => {
    const cap = validCapture();
    delete cap.type;
    expect(() => validateSyntheticCapture("settlement_sync.jupiter", cap)).toThrow(/missing required field/);
  });

  it("rejects when status is missing", () => {
    const cap = validCapture();
    delete cap.status;
    expect(() => validateSyntheticCapture("settlement_sync.jupiter", cap)).toThrow(/missing required field/);
  });

  it("reports every missing field at once", () => {
    expect(() => validateSyntheticCapture("settlement_sync.jupiter", { type: "prediction", status: "closed" }))
      .toThrow(/walletAddress, positionKey, valuationSource/);
  });
});

describe("validateSyntheticCapture — type discriminator", () => {
  it("rejects a capture whose type does not match the contract", () => {
    const cap = { ...validCapture(), type: "swap" };
    expect(() => validateSyntheticCapture("settlement_sync.jupiter", cap))
      .toThrow(/unexpected type "swap"/);
  });

  it("accepts the claimed valuation variant (valuationSource present, non-'none')", () => {
    const cap = { ...validCapture(), status: "claimed", valuationSource: "prediction_exact", outputValueUsd: "3000000" };
    expect(() => validateSyntheticCapture("settlement_sync.jupiter", cap)).not.toThrow();
  });
});
