import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";

describe("protocol discovery — metadata v1 wiring (PR3)", () => {
  const ENV_KEYS = [
    "JUPITER_API_KEY",
    "POLYMARKET_API_KEY",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_PROVIDER",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    process.env.JUPITER_API_KEY = "test-jupiter-key";
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIM;
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  // Agent Scan plan v3 (2026-07-22): the two canonicalSummary-scoring cases
  // this suite used to pin (polymarket.clob.orderbook vs
  // polymarket.data.closedPositions) were deleted along with the whole
  // Polymarket namespace — no other active manifest was verified to
  // demonstrate the same canonicalSummary-scoring invariant, so no
  // replacement was invented here. Residual coverage gap: flagged for a
  // follow-up pass using a surviving protocol's canonicalSummary-rich
  // manifest if this metadata-v1 scoring behavior needs a dedicated pin again.

  it("unfilled tools still score via inherited metadata fields", async () => {
    const result = await discoverProtocolCapabilities({
      query: "swap",
      namespace: "kyberswap",
      limit: 50,
    });
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    const swapTool = result.tools.find((t) => t.toolId.startsWith("kyberswap.swap"));
    expect(swapTool).toBeDefined();
    expect(swapTool!.score).toBeGreaterThan(0);
  });
});
