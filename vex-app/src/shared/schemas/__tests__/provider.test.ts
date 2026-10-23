import { describe, expect, it } from "vitest";
import {
  PROVIDER_MODEL_CATALOG_MAX,
  providerListModelsResultSchema,
  providerModelOptionSchema,
} from "../provider.js";

const validModel = {
  modelId: "anthropic/claude-sonnet-4.5",
  displayName: "Anthropic: Claude Sonnet 4.5",
  providerId: "anthropic",
  contextLength: 200_000,
  pricingInputPerMillion: "3",
  pricingOutputPerMillion: "15",
};

describe("provider model catalogue schemas", () => {
  it("accepts renderer-safe metadata", () => {
    expect(providerModelOptionSchema.safeParse(validModel).success).toBe(true);
    expect(
      providerListModelsResultSchema.safeParse({ models: [validModel] }).success,
    ).toBe(true);
  });

  it("rejects unknown fields and negative prices", () => {
    expect(
      providerModelOptionSchema.safeParse({ ...validModel, raw: "nope" }).success,
    ).toBe(false);
    expect(
      providerModelOptionSchema.safeParse({
        ...validModel,
        pricingInputPerMillion: "-1",
      }).success,
    ).toBe(false);
  });

  it("carries per-1M prices as exact decimal text, never a float", () => {
    expect(providerModelOptionSchema.safeParse({ ...validModel, pricingInputPerMillion: "0.14375" }).success).toBe(true);
    // A number, an exponent and a padded zero are not the canonical text.
    for (const bad of [0.14375, "1.4375e-1", "0.5750", "00.5", ""]) {
      expect(providerModelOptionSchema.safeParse({ ...validModel, pricingInputPerMillion: bad }).success).toBe(false);
    }
  });

  it("enforces the catalogue bound", () => {
    expect(
      providerListModelsResultSchema.safeParse({
        models: Array.from(
          { length: PROVIDER_MODEL_CATALOG_MAX + 1 },
          (_, index) => ({ ...validModel, modelId: `provider/model-${index}` }),
        ),
      }).success,
    ).toBe(false);
  });
});
