import { describe, expect, it } from "vitest";
import {
  providerListModelsResultSchema,
  providerModelOptionSchema,
} from "../provider.js";

const validModel = {
  modelId: "anthropic/claude-sonnet-4.5",
  displayName: "Anthropic: Claude Sonnet 4.5",
  providerId: "anthropic",
  contextLength: 200_000,
  pricingInputPerMillion: 3,
  pricingOutputPerMillion: 15,
};

describe("provider model catalogue schemas", () => {
  it("accepts renderer-safe model metadata", () => {
    expect(providerModelOptionSchema.safeParse(validModel).success).toBe(true);
    expect(
      providerListModelsResultSchema.safeParse({
        models: [validModel],
        fetchedAt: "2026-07-11T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields and invalid prices", () => {
    expect(
      providerModelOptionSchema.safeParse({
        ...validModel,
        rawProviderPayload: { secret: "nope" },
      }).success,
    ).toBe(false);
    expect(
      providerModelOptionSchema.safeParse({
        ...validModel,
        pricingInputPerMillion: -1,
      }).success,
    ).toBe(false);
  });
});
