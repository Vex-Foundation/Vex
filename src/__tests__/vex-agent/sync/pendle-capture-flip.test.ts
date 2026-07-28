/**
 * Batch B card B2 — the Pendle capture flip + auto-pin, as one atom.
 *
 * Three behaviours are pinned here, all of which must hold TOGETHER or the
 * Pendle feed silently loses rows:
 *
 *   1. `pinConfirmedPendleAcquisition` pins an acquired PT/YT/LP into
 *      `tracked_tokens` — the replacement discovery source now that the tools
 *      no longer write `proj_activity` capture rows for the enrichment scan.
 *   2. Every Pendle mutating tool is `capture: "none"`, so the legacy
 *      projection pipeline never writes a second, quote-derived truth beside
 *      the handler's own `agent_activity` (`kind: 'yield'`) rows.
 *   3. A FAILED Pendle attempt still reaches the transactions failure half —
 *      under the `yield` product, including the LP and reward-claim tools that
 *      the pre-flip `lp`/`reward` products excluded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockPin = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: (...a: unknown[]) => mockPin(...a),
}));

const { pinConfirmedPendleAcquisition } = await import("@vex-agent/sync/pendle-acquisition-pin.js");
const { MUTATION_MATRIX } = await import("@vex-agent/tools/protocols/mutation-matrix.js");
const { validateCaptureContract } = await import("@vex-agent/tools/protocols/capture-validator.js");
const { FAILURE_TOOL_PRODUCTS, TRANSACTION_PRODUCTS, failureToolsForProduct } = await import(
  "@vex-agent/db/repos/transactions-failure-tools.js"
);

/** Every mutating Pendle tool flipped by this card. */
const PENDLE_MUTATING_TOOLS = [
  "pendle.pt.buy",
  "pendle.pt.sell",
  "pendle.pt.redeem",
  "pendle.yt.buy",
  "pendle.yt.sell",
  "pendle.py.mint",
  "pendle.py.redeem",
  "pendle.lp.add",
  "pendle.lp.remove",
  "pendle.claim",
] as const;

const WALLET = "0x1111111111111111111111111111111111111111";
/** PT-SIERRA-6AUG2026 on Ethereum (lowercase on purpose — pins store checksummed). */
const PT_LOWER = "0x0ee083964c815baed1a2d7f5e3cec851ec394e7d";
const PT_CHECKSUM = "0x0ee083964C815bAED1A2d7F5E3Cec851eC394E7d";

describe("pendle acquisition auto-pin", () => {
  beforeEach(() => {
    mockPin.mockReset();
    mockPin.mockResolvedValue({ inserted: true });
  });

  it("pins each acquired token into tracked_tokens, checksummed, source 'swap'", async () => {
    await pinConfirmedPendleAcquisition(WALLET, 1, [
      { address: PT_LOWER, symbol: "PT-SIERRA", decimals: 6 },
      { address: "0x9fc74f8ed616b5baf52a170caa97d6d3898602d1", symbol: null, decimals: null },
    ]);
    expect(mockPin).toHaveBeenCalledTimes(2);
    expect(mockPin).toHaveBeenNthCalledWith(1, {
      walletAddress: WALLET,
      chainId: 1,
      tokenAddress: PT_CHECKSUM,
      source: "swap",
    });
  });

  it("never throws when the pin write fails — a settled on-chain action must not unwind", async () => {
    mockPin.mockRejectedValue(new Error("db down"));
    await expect(
      pinConfirmedPendleAcquisition(WALLET, 1, [{ address: PT_LOWER, symbol: null, decimals: null }]),
    ).resolves.toBeUndefined();
  });

  it("skips a malformed address without aborting the remaining pins", async () => {
    await pinConfirmedPendleAcquisition(WALLET, 1, [
      { address: "not-an-address", symbol: null, decimals: null },
      { address: PT_LOWER, symbol: null, decimals: null },
    ]);
    expect(mockPin).toHaveBeenCalledTimes(1);
    expect(mockPin).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: PT_CHECKSUM }));
  });

  it("writes nothing for a chain Pendle does not serve", async () => {
    await pinConfirmedPendleAcquisition(WALLET, 999999, [
      { address: PT_LOWER, symbol: null, decimals: null },
    ]);
    expect(mockPin).not.toHaveBeenCalled();
  });
});

describe("pendle mutation matrix — capture flip", () => {
  it("every Pendle mutating tool is capture:'none' with no required fields", () => {
    for (const toolId of PENDLE_MUTATING_TOOLS) {
      const contract = MUTATION_MATRIX.get(toolId);
      expect(contract, `${toolId} missing from the matrix`).toBeDefined();
      expect(contract!.capture, `${toolId} must not project proj_activity`).toBe("none");
      expect(contract!.requiredFields).toEqual([]);
      expect(contract!.expectedType).toBe("yield");
    }
  });

  it("the capture validator no longer demands a _tradeCapture from a Pendle tool", () => {
    for (const toolId of PENDLE_MUTATING_TOOLS) {
      // Pre-flip this returned false for a null capture (capture:"full").
      expect(validateCaptureContract(toolId, null), toolId).toBe(true);
    }
  });
});

describe("pendle failures reach the transactions failure half", () => {
  it("'yield' is a transaction product", () => {
    expect(TRANSACTION_PRODUCTS.has("yield")).toBe(true);
  });

  it("every Pendle mutating tool derives the 'yield' product", () => {
    for (const toolId of PENDLE_MUTATING_TOOLS) {
      expect(FAILURE_TOOL_PRODUCTS.get(toolId), toolId).toBe("yield");
    }
  });

  it("the LP and reward-claim tools are no longer excluded (P2-11)", () => {
    // Pre-flip these three were deliberately absent: their `lp` / `reward`
    // products were not transaction products.
    expect(FAILURE_TOOL_PRODUCTS.has("pendle.lp.add")).toBe(true);
    expect(FAILURE_TOOL_PRODUCTS.has("pendle.lp.remove")).toBe(true);
    expect(FAILURE_TOOL_PRODUCTS.has("pendle.claim")).toBe(true);
  });

  it("failureToolsForProduct('yield') is exactly the Pendle mutating set", () => {
    expect([...failureToolsForProduct("yield")].sort()).toEqual([...PENDLE_MUTATING_TOOLS].sort());
  });

  it("Pendle tools do NOT leak into the 'spot' allowlist any more", () => {
    expect(failureToolsForProduct("spot")).not.toContain("pendle.pt.buy");
  });
});
