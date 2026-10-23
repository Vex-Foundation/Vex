import { describe, expect, it } from "vitest";
import {
  modelOptionDtoSchema,
  modelsListAvailableInputSchema,
  modelsListAvailableResultSchema,
  modelsListSourceSchema,
} from "../models.js";

describe("models schemas", () => {
  it("modelsListSourceSchema accepts catalogue, env-derived and unconfigured sources", () => {
    expect(modelsListSourceSchema.safeParse("catalog").success).toBe(true);
    expect(modelsListSourceSchema.safeParse("global_default").success).toBe(true);
    expect(modelsListSourceSchema.safeParse("unconfigured").success).toBe(true);
  });

  it("modelsListSourceSchema rejects direct OpenRouter catalogue source", () => {
    expect(modelsListSourceSchema.safeParse("openrouter").success).toBe(false);
  });

  it("modelOptionDtoSchema allows nullable pricing, context metadata, and reasoning", () => {
    const parsed = modelOptionDtoSchema.safeParse({
      providerId: "openrouter",
      modelId: "anthropic/claude-opus-4.7",
      displayName: "Claude Opus 4.7",
      brand: "openrouter",
      contextLength: null,
      pricingInputPerMillion: null,
      pricingOutputPerMillion: null,
      reasoning: null,
      isDefault: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("modelOptionDtoSchema requires the reasoning key (no implicit omission)", () => {
    const parsed = modelOptionDtoSchema.safeParse({
      providerId: "openrouter",
      modelId: "anthropic/claude-opus-4.7",
      displayName: "Claude Opus 4.7",
      brand: "openrouter",
      contextLength: null,
      pricingInputPerMillion: null,
      pricingOutputPerMillion: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("modelOptionDtoSchema accepts a normalized non-null reasoning capability", () => {
    const parsed = modelOptionDtoSchema.safeParse({
      providerId: "openrouter",
      modelId: "anthropic/claude-opus-4.7",
      displayName: "Claude Opus 4.7",
      brand: "openrouter",
      contextLength: null,
      pricingInputPerMillion: null,
      pricingOutputPerMillion: null,
      reasoning: {
        supportedEfforts: ["high", "medium", "low", "none"],
        defaultEffort: "medium",
        defaultEnabled: true,
        mandatory: false,
      },
      isDefault: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("modelsListAvailableInputSchema accepts an empty object", () => {
    expect(modelsListAvailableInputSchema.safeParse({}).success).toBe(true);
  });

  it("modelsListAvailableResultSchema accepts unconfigured shape", () => {
    expect(
      modelsListAvailableResultSchema.safeParse({
        source: "unconfigured",
        models: [],
        fetchedAt: null,
      }).success,
    ).toBe(true);
  });

  it("modelsListAvailableResultSchema accepts a single env-derived option", () => {
    expect(
      modelsListAvailableResultSchema.safeParse({
        source: "global_default",
        models: [
          {
            providerId: "openrouter",
            modelId: "anthropic/claude-opus-4.7",
            displayName: "anthropic/claude-opus-4.7",
            brand: "openrouter",
            contextLength: null,
            pricingInputPerMillion: null,
            pricingOutputPerMillion: null,
            reasoning: null,
            isDefault: true,
          },
        ],
        fetchedAt: null,
      }).success,
    ).toBe(true);
  });
});
