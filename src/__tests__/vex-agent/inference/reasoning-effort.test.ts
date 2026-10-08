/**
 * Kairos E-1: model effort support, the never-higher clamp, and the
 * background-call (`AUX_REASONING_EFFORT`) effort.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenRouter, HTTPClient } from "@openrouter/sdk";

import { fetchModelInferenceConfig } from "@vex-agent/inference/openrouter/model-catalog.js";

import {
  AUX_FALLBACK_REASONING_EFFORT,
  clampReasoningEffort,
  lowestSupportedReasoningEffort,
  normalizeReasoningSupport,
  raiseReasoningEffort,
  readAuxReasoningEffortSetting,
  resolveAuxReasoningEffort,
  withAuxReasoningEffort,
} from "@vex-agent/inference/reasoning-effort.js";
import { parseAuxReasoningEffortEnv } from "../../../lib/agent-config.js";
import type { InferenceConfig, ReasoningEffortSupport } from "@vex-agent/inference/types.js";

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    contextLimit: 256_000,
    maxOutputTokens: 16_384,
    inputPricePerM: 0.1,
    outputPricePerM: 0.2,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: true,
    ...overrides,
  };
}

const HIGH_ONLY: ReasoningEffortSupport = { efforts: ["high", "xhigh"] };
const OPTIONAL: ReasoningEffortSupport = { efforts: ["none", "low", "medium", "high"] };
const MANDATORY: ReasoningEffortSupport = { efforts: ["minimal", "low", "high"] };

describe("normalizeReasoningSupport", () => {
  it("treats a missing block or a missing list as unknown", () => {
    expect(normalizeReasoningSupport(undefined)).toBeNull();
    expect(normalizeReasoningSupport({ mandatory: false })).toBeNull();
    expect(normalizeReasoningSupport("high")).toBeNull();
  });

  it("reads an explicit null list as every positive effort, plus off when not mandatory", () => {
    expect(normalizeReasoningSupport({ supportedEfforts: null, mandatory: false })).toEqual({
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(normalizeReasoningSupport({ supportedEfforts: null, mandatory: true })?.efforts).not.toContain("none");
  });

  it("keeps known positive efforts, drops unknown ones and ignores a listed none on a mandatory model", () => {
    expect(
      normalizeReasoningSupport({ supportedEfforts: ["high", "bogus", "none", "low"], mandatory: true }),
    ).toEqual({ efforts: ["low", "high"] });
  });

  it("is unknown when no positive effort survives", () => {
    expect(normalizeReasoningSupport({ supportedEfforts: ["none"], mandatory: false })).toBeNull();
  });
});

describe("clampReasoningEffort", () => {
  it("keeps a supported request", () => {
    expect(clampReasoningEffort("medium", OPTIONAL)).toBe("medium");
  });

  it("clamps DOWN to the nearest lower supported effort, never up", () => {
    expect(clampReasoningEffort("medium", MANDATORY)).toBe("low");
    expect(clampReasoningEffort("max", OPTIONAL)).toBe("high");
    expect(clampReasoningEffort("minimal", OPTIONAL)).toBe("none");
  });

  it("uses the lowest supported effort only when nothing at or below the request exists", () => {
    expect(clampReasoningEffort("medium", HIGH_ONLY)).toBe("high");
    expect(clampReasoningEffort("none", MANDATORY)).toBe("minimal");
  });

  it("leaves the request unchanged when support is unknown", () => {
    expect(clampReasoningEffort("xhigh", null)).toBe("xhigh");
    expect(clampReasoningEffort("xhigh", undefined)).toBe("xhigh");
  });
});

describe("raiseReasoningEffort (mission path)", () => {
  // The live deepseek-v4.1-flash catalog row: low, high, max (and off).
  const DEEPSEEK_FLASH: ReasoningEffortSupport = { efforts: ["none", "low", "high", "max"] };

  it("keeps a supported request", () => {
    expect(raiseReasoningEffort("low", DEEPSEEK_FLASH)).toBe("low");
    expect(raiseReasoningEffort("high", DEEPSEEK_FLASH)).toBe("high");
  });

  it("raises UP to the nearest higher supported effort, never down", () => {
    expect(raiseReasoningEffort("medium", DEEPSEEK_FLASH)).toBe("high");
    expect(raiseReasoningEffort("xhigh", DEEPSEEK_FLASH)).toBe("max");
    expect(raiseReasoningEffort("minimal", DEEPSEEK_FLASH)).toBe("low");
    expect(raiseReasoningEffort("medium", MANDATORY)).toBe("high");
  });

  it("uses the highest supported effort only when nothing at or above the request exists", () => {
    expect(raiseReasoningEffort("max", OPTIONAL)).toBe("high");
    expect(raiseReasoningEffort("max", HIGH_ONLY)).toBe("xhigh");
  });

  it("leaves the request unchanged when support is unknown", () => {
    expect(raiseReasoningEffort("medium", null)).toBe("medium");
    expect(raiseReasoningEffort("medium", undefined)).toBe("medium");
  });
});

describe("lowestSupportedReasoningEffort", () => {
  it("is off only where the model supports disabling", () => {
    expect(lowestSupportedReasoningEffort(OPTIONAL)).toBe("none");
    expect(lowestSupportedReasoningEffort(MANDATORY)).toBe("minimal");
  });

  it("falls back to low when support is unknown", () => {
    expect(AUX_FALLBACK_REASONING_EFFORT).toBe("low");
    expect(lowestSupportedReasoningEffort(null)).toBe("low");
  });
});

describe("AUX_REASONING_EFFORT", () => {
  it("defaults to lowest and accepts every option case-insensitively", () => {
    expect(parseAuxReasoningEffortEnv({})).toEqual({ value: "lowest", error: null });
    expect(parseAuxReasoningEffortEnv({ AUX_REASONING_EFFORT: "  " })).toEqual({ value: "lowest", error: null });
    expect(parseAuxReasoningEffortEnv({ AUX_REASONING_EFFORT: "Provider" })).toEqual({ value: "provider", error: null });
    expect(parseAuxReasoningEffortEnv({ AUX_REASONING_EFFORT: "low" })).toEqual({ value: "low", error: null });
  });

  it("reports an unknown value and falls back to the default", () => {
    const parsed = parseAuxReasoningEffortEnv({ AUX_REASONING_EFFORT: "turbo" });
    expect(parsed.value).toBe("lowest");
    expect(parsed.error).toMatch(/AUX_REASONING_EFFORT="turbo" is invalid/);
    expect(readAuxReasoningEffortSetting({ AUX_REASONING_EFFORT: "turbo" })).toBe("lowest");
  });

  it("resolves lowest, provider and an explicit clamped effort", () => {
    const c = config({ reasoningSupport: MANDATORY });
    expect(resolveAuxReasoningEffort(c, "lowest")).toBe("minimal");
    expect(resolveAuxReasoningEffort(c, "provider")).toBeUndefined();
    expect(resolveAuxReasoningEffort(c, "medium")).toBe("low");
  });

  it("sends nothing to a model that does not advertise the reasoning parameter", () => {
    expect(resolveAuxReasoningEffort(config({ supportsReasoningEffort: false }), "lowest")).toBeUndefined();
  });

  it("withAuxReasoningEffort replaces a chat pick on a copy and leaves the input untouched", () => {
    const input = config({ reasoningSupport: OPTIONAL, reasoningEffort: "high" });
    const out = withAuxReasoningEffort(input, "lowest");
    expect(out.reasoningEffort).toBe("none");
    expect(input.reasoningEffort).toBe("high");
    expect(withAuxReasoningEffort(input, "provider").reasoningEffort).toBeUndefined();
  });

  it("returns a value that is not an inference config unchanged", () => {
    const stub = { model: "stub" };
    expect(withAuxReasoningEffort(stub, "lowest")).toBe(stub);
  });
});

describe("fetchModelInferenceConfig - reasoning support", () => {
  const FIXTURE = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/openrouter-models/models-subset.json", import.meta.url)),
      "utf8",
    ),
  );

  function clientWithEfforts(efforts: unknown): OpenRouter {
    const body = {
      ...FIXTURE,
      data: FIXTURE.data.map((row: Record<string, unknown>) =>
        row.id === "deepseek/deepseek-chat-v3.1"
          ? { ...row, reasoning: { mandatory: false, supported_efforts: efforts } }
          : row,
      ),
    };
    const httpClient = new HTTPClient({
      fetcher: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    return new OpenRouter({ apiKey: "", httpClient });
  }

  async function supportFor(efforts: unknown): Promise<unknown> {
    const result = await fetchModelInferenceConfig(clientWithEfforts(efforts), {
      providerId: "openrouter",
      model: "deepseek/deepseek-chat-v3.1",
      contextLimit: 256_000,
      temperature: undefined,
      maxOutputTokens: 16_384,
      endpointTag: undefined,
    });
    if (result.kind !== "success") return `failed:${result.kind}`;
    return result.config.reasoningSupport;
  }

  it("carries the catalogue's supported efforts through the real SDK deserialisation", async () => {
    expect(await supportFor(["high", "medium", "low"])).toEqual({
      efforts: ["none", "low", "medium", "high"],
    });
  });

  it("is unknown when the catalogue lists no efforts", async () => {
    expect(await supportFor(undefined)).toBeNull();
  });
});
