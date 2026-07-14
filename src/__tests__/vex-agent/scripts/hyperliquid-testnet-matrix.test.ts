import { describe, expect, it } from "vitest";

import { readMatrixConfig } from "@vex-agent/scripts/hyperliquid-testnet-matrix.js";

describe("Hyperliquid testnet atomicity matrix configuration", () => {
  it("refuses to run without a throwaway testnet key", () => {
    expect(() => readMatrixConfig({})).toThrow(/VEX_HL_TESTNET_PK/);
  });

  it("accepts only a 32-byte key and keeps the default evidence artifact under ignored .claude", () => {
    const config = readMatrixConfig({
      VEX_HL_TESTNET_PK: "0x0123456789012345678901234567890123456789012345678901234567890123",
    });
    expect(config.coin).toBe("BTC");
    expect(config.evidencePath).toMatch(/[\\/]\.claude[\\/]plan[\\/]hl-matrix-evidence\.json$/);
  });

  it("rejects a malformed key and unsafe market symbol before any network client is created", () => {
    expect(() => readMatrixConfig({ VEX_HL_TESTNET_PK: "0x1234" })).toThrow(/32-byte/);
    expect(() => readMatrixConfig({
      VEX_HL_TESTNET_PK: "0x0123456789012345678901234567890123456789012345678901234567890123",
      VEX_HL_TESTNET_COIN: "BTC/USDC",
    })).toThrow(/market symbol/);
  });
});
