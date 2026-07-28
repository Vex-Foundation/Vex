/**
 * The wizard's pinned endpoint reaching the wire.
 *
 * `OPENROUTER_ENDPOINT_TAG` → `loadEnvConfig` → `InferenceConfig.endpointTag`
 * → `buildProviderPreferences` → `provider.order`. Before this wiring the
 * `endpointTag` argument existed but had no producer, so a pin chosen in the
 * wizard changed nothing about the request.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadEnvConfig } from "../../../vex-agent/inference/config.js";
import { buildOpenRouterParams } from "../../../vex-agent/inference/openrouter/params.js";
import type { InferenceConfig, ToolDefinition } from "../../../vex-agent/inference/types.js";

const ORIGINAL_TAG = process.env.OPENROUTER_ENDPOINT_TAG;

afterEach(() => {
  if (ORIGINAL_TAG === undefined) delete process.env.OPENROUTER_ENDPOINT_TAG;
  else process.env.OPENROUTER_ENDPOINT_TAG = ORIGINAL_TAG;
});

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    contextLimit: 200_000,
    maxOutputTokens: 4_096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
    ...overrides,
  };
}

const TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "noop",
    description: "noop",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

describe("OPENROUTER_ENDPOINT_TAG", () => {
  it("is read as a pin when set", () => {
    process.env.OPENROUTER_ENDPOINT_TAG = "google-vertex/global";
    expect(loadEnvConfig().openrouterEndpointTag).toBe("google-vertex/global");
  });

  it.each(["", "   "])("treats %j as Auto (no pin)", (raw) => {
    process.env.OPENROUTER_ENDPOINT_TAG = raw;
    expect(loadEnvConfig().openrouterEndpointTag).toBeNull();
  });

  it("is absent from the config when the key is unset", () => {
    delete process.env.OPENROUTER_ENDPOINT_TAG;
    expect(loadEnvConfig().openrouterEndpointTag).toBeNull();
  });
});

describe("pin on the wire", () => {
  it("becomes provider.order with fallbacks disabled", () => {
    const params = buildOpenRouterParams(
      [{ role: "user", content: "hi" }],
      [TOOL],
      config({ endpointTag: "anthropic/2" }),
      false,
    );
    expect(params.provider).toEqual({
      requireParameters: true,
      order: ["anthropic/2"],
      allowFallbacks: false,
    });
  });

  it("sends no order at all on Auto — today's request shape is preserved", () => {
    const params = buildOpenRouterParams(
      [{ role: "user", content: "hi" }],
      [TOOL],
      config(),
      false,
    );
    expect(params.provider).toEqual({ requireParameters: true });
  });
});
