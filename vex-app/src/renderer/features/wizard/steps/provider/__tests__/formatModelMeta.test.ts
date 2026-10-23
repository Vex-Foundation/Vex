import { describe, expect, it } from "vitest";
import type { ProviderModelOption } from "@shared/schemas/provider.js";
import { usdPerMillionFromPerToken } from "@shared/usd-per-million.js";
import { formatModelMeta, formatPrice, formatUsdPerMillion } from "../formatModelMeta.js";

const model: ProviderModelOption = {
  modelId: "vendor/model",
  displayName: "Model",
  providerId: "vendor",
  contextLength: 200_000,
  pricingInputPerMillion: "3",
  pricingOutputPerMillion: null,
};

describe("model metadata formatting", () => {
  it("shows context and whichever price sides are available", () => {
    expect(formatModelMeta(model)).toBe("200k ctx · $3 in per 1M");
    expect(
      formatModelMeta({ ...model, pricingInputPerMillion: null, pricingOutputPerMillion: "15" }),
    ).toBe("200k ctx · $15 out per 1M");
  });

  // The live Vex Inference catalogue (GET /v1/models, 2026-10-22): the prices
  // charged, margin included. Float rounding read them as "$0.14 in / $0.57
  // out" and "$12 out": understated and overstated money.
  it("states the exact charged price from the published per-token text", () => {
    const luna: ProviderModelOption = {
      ...model,
      modelId: "openai/gpt-6-luna",
      contextLength: null,
      pricingInputPerMillion: usdPerMillionFromPerToken("0.00000014375"),
      pricingOutputPerMillion: usdPerMillionFromPerToken("0.000000575"),
    };
    expect(formatModelMeta(luna)).toBe("$0.14375 in / $0.575 out per 1M");
    const sonnet: ProviderModelOption = {
      ...luna,
      pricingInputPerMillion: usdPerMillionFromPerToken("0.0000023"),
      pricingOutputPerMillion: usdPerMillionFromPerToken("0.0000115"),
    };
    expect(formatModelMeta(sonnet)).toBe("$2.3 in / $11.5 out per 1M");
  });

  it.each([
    ["0", "$0"],
    ["0.0004", "$0.0004"],
    ["0.14375", "$0.14375"],
    ["11.5", "$11.5"],
    ["1250", "$1,250"],
  ])("formats exact text %s as %s", (text, expected) => {
    expect(formatUsdPerMillion(text)).toBe(expected);
  });

  // The OpenRouter endpoint list carries numbers: every published digit
  // survives, only the float noise of the per-token multiplication goes.
  it.each([
    [0, "$0"],
    [0.000000575 * 1_000_000, "$0.575"],
    [0.00000014375 * 1_000_000, "$0.14375"],
    [0.0000115 * 1_000_000, "$11.5"],
    [Number("0.000000115") * 1_000_000, "$0.115"],
    [15, "$15"],
  ])("formats endpoint price %s as %s", (value, expected) => {
    expect(formatPrice(value)).toBe(expected);
  });
});
