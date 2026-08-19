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
      robinhoodChainRpcUrl:
        "https://robinhood-mainnet.g.alchemy.com/v2/test-key",
      lighterCoreTradingAccountIndex: 42,
      lighterCoreTradingApiKeyIndex: 7,
      lighterCoreTradingApiPrivateKey: `0x${"1".repeat(80)}`,
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 9,
      lighterRhcTradingApiPrivateKey: `0x${"2".repeat(80)}`,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts only HTTPS Robinhood Chain RPC endpoints", () => {
    expect(apiKeysSetInputSchema.safeParse({
      robinhoodChainRpcUrl: "https://robinhood-mainnet.g.alchemy.com/v2/key",
    }).success).toBe(true);
    expect(apiKeysSetInputSchema.safeParse({
      robinhoodChainRpcUrl: "http://rpc.example.test/key",
    }).success).toBe(false);
    expect(apiKeysSetInputSchema.safeParse({
      robinhoodChainRpcUrl: "https://user:secret@rpc.example.test",
    }).success).toBe(false);
  });

  it("rejects reserved Lighter trading API-key indexes before IPC", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 3,
      lighterRhcTradingApiPrivateKey: `0x${"2".repeat(80)}`,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects separate Lighter read-only token fields in the normal API-key setup path", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      lighterRhcReadOnlyToken: "ro:1:single:2000000000:abcdef",
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
