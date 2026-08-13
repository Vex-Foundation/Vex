import { describe, expect, it } from "vitest";
import { apiKeysSetInputSchema } from "../api-keys.js";

describe("apiKeysSetInputSchema", () => {
  it("accepts an empty payload (all fields optional)", () => {
    const parsed = apiKeysSetInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("accepts a payload with supported key fields", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      jupiterApiKey: "j",
      tavilyApiKey: "t",
      rettiwtApiKey: "r",
      relayApiKey: "relay",
      lighterCoreReadOnlyToken: "ro:1:single:2000000000:abcdef",
      lighterRhcReadOnlyToken: "ro:1:single:2000000000:abcdef",
      lighterCoreTradingAccountIndex: 42,
      lighterCoreTradingApiKeyIndex: 7,
      lighterCoreTradingApiPrivateKey: `0x${"1".repeat(80)}`,
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 9,
      lighterRhcTradingApiPrivateKey: `0x${"2".repeat(80)}`,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects reserved Lighter trading API-key indexes before IPC", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 3,
      lighterRhcTradingApiPrivateKey: `0x${"2".repeat(80)}`,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a payload carrying an unrecognized key (.strict())", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      polymarket: { apiKey: "k", apiSecret: "s", passphrase: "p" },
    });
    expect(parsed.success).toBe(false);
  });
});
