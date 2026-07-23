import { describe, expect, it } from "vitest";
import { apiKeysSetInputSchema } from "../api-keys.js";

describe("apiKeysSetInputSchema", () => {
  it("accepts an empty payload (all fields optional)", () => {
    const parsed = apiKeysSetInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("accepts a payload with jupiter/tavily/rettiwt keys", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      jupiterApiKey: "j",
      tavilyApiKey: "t",
      rettiwtApiKey: "r",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload carrying an unrecognized key (.strict())", () => {
    const parsed = apiKeysSetInputSchema.safeParse({
      polymarket: { apiKey: "k", apiSecret: "s", passphrase: "p" },
    });
    expect(parsed.success).toBe(false);
  });
});
