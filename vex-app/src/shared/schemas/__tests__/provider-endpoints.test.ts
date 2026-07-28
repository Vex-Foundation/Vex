import { describe, expect, it } from "vitest";
import {
  providerEndpointOptionSchema,
  providerListEndpointsInputSchema,
  providerListEndpointsResultSchema,
  splitOpenRouterModelId,
} from "../provider-endpoints.js";
import { providerPersistInputSchema } from "../provider.js";

const endpoint = {
  tag: "google-vertex/global",
  providerName: "Google",
  contextLength: 1_000_000,
  quantization: "unknown",
  pricingInputPerMillion: 3,
  pricingOutputPerMillion: 15,
  pricingCacheReadPerMillion: 0.3,
  pricingCacheWritePerMillion: 3.75,
};

describe("providerListEndpoints schemas", () => {
  it("round-trips a result payload", () => {
    const payload = { modelId: "anthropic/claude-sonnet-4.5", endpoints: [endpoint] };
    expect(providerListEndpointsResultSchema.parse(payload)).toEqual(payload);
  });

  it("rejects unknown keys on an endpoint row", () => {
    expect(
      providerEndpointOptionSchema.safeParse({ ...endpoint, latency: 12 }).success,
    ).toBe(false);
  });

  it.each([
    ["anthropic/claude-sonnet-4.5", true],
    ["openai/gpt-4o-mini:free", true],
    ["anthropic", false],
    ["anthropic/claude/extra", false],
    ["../../etc/passwd", false],
    ["anthropic/claude sonnet", false],
    ["/leading-slash", false],
    ["anthropic/", false],
  ])("model id %s accepted=%s", (modelId, accepted) => {
    expect(providerListEndpointsInputSchema.safeParse({ modelId }).success).toBe(
      accepted,
    );
  });

  it("splits on the FIRST slash only for accepted ids, and refuses the rest", () => {
    expect(splitOpenRouterModelId("anthropic/claude-sonnet-4.5")).toEqual({
      author: "anthropic",
      slug: "claude-sonnet-4.5",
    });
    expect(splitOpenRouterModelId("anthropic/claude/extra")).toBeNull();
  });
});

describe("providerPersistInput endpointTag", () => {
  const base = {
    provider: "openrouter" as const,
    apiKey: "sk-or-test",
    model: "anthropic/claude-sonnet-4.5",
  };

  it("is optional — Auto omits it entirely", () => {
    expect(providerPersistInputSchema.parse(base)).toEqual(base);
  });

  it("accepts live-shaped tags", () => {
    for (const endpointTag of [
      "anthropic",
      "anthropic/2",
      "google-vertex/global",
      "amazon-bedrock/eu-west-1",
    ]) {
      expect(
        providerPersistInputSchema.safeParse({ ...base, endpointTag }).success,
      ).toBe(true);
    }
  });

  it("rejects a blank or hostile tag rather than persisting it", () => {
    for (const endpointTag of ["", "   ", "<script>", "tag with space", "a".repeat(201)]) {
      expect(
        providerPersistInputSchema.safeParse({ ...base, endpointTag }).success,
      ).toBe(false);
    }
  });
});
