/**
 * P1.4 — effective context limit = min(AGENT_CONTEXT_LIMIT, model's real window).
 *
 * Two layers:
 *
 *  1. `resolveEffectiveContextLimit` as a pure unit — the clamp arithmetic plus
 *     every way an untrusted catalog row can fail to carry a usable window.
 *  2. `fetchModelInferenceConfig` end to end against a RECORDED, non-empty
 *     `GET /models` response replayed through a real `@openrouter/sdk` client
 *     (`fixtures/openrouter-models/README.md` for provenance). That proves the
 *     wire field `context_length` actually reaches the clamp through the SDK's
 *     own deserialisation — a hand-written camelCase double could not.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

import { OpenRouter, HTTPClient } from "@openrouter/sdk";

import {
  MODEL_CONTEXT_WINDOW_FLOOR,
  parseModelContextWindow,
  resolveEffectiveContextLimit,
} from "../../../vex-agent/inference/context-window.js";
import { fetchModelInferenceConfig } from "../../../vex-agent/inference/openrouter/model-catalog.js";
import { AGENT_CONTEXT_LIMIT } from "../../../lib/agent-config.js";

const FIXTURE_BODY = readFileSync(
  fileURLToPath(
    new URL("./fixtures/openrouter-models/models-subset.json", import.meta.url),
  ),
  "utf8",
);

/** Real SDK client whose transport replays the recorded catalogue. */
function fixtureClient(): OpenRouter {
  const httpClient = new HTTPClient({
    fetcher: async () =>
      new Response(FIXTURE_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  // Keyless posture — `/models` is public and no user key may be attached.
  return new OpenRouter({ apiKey: "", httpClient });
}

function specFor(model: string, contextLimit: number) {
  return {
    providerId: "openrouter",
    model,
    contextLimit,
    temperature: undefined,
    maxOutputTokens: 16_384,
    endpointTag: undefined,
  };
}

const CONFIGURED_DEFAULT = AGENT_CONTEXT_LIMIT.default ?? 256_000;

describe("resolveEffectiveContextLimit", () => {
  it("keeps the configured value when it fits inside the model window", () => {
    const resolved = resolveEffectiveContextLimit(128_000, 1_000_000);

    expect(resolved.effective).toBe(128_000);
    expect(resolved.modelWindow).toBe(1_000_000);
    expect(resolved.reason).toBe("within_model_window");
  });

  it("clamps DOWN to the model window when the configured value overshoots", () => {
    const resolved = resolveEffectiveContextLimit(256_000, 131_072);

    expect(resolved.effective).toBe(131_072);
    expect(resolved.configured).toBe(256_000);
    expect(resolved.reason).toBe("clamped_to_model_window");
  });

  it("never RAISES the configured value to meet a larger window", () => {
    const resolved = resolveEffectiveContextLimit(64_000, 1_000_000);

    expect(resolved.effective).toBe(64_000);
  });

  it("treats an equal window as no clamp", () => {
    const resolved = resolveEffectiveContextLimit(131_072, 131_072);

    expect(resolved.effective).toBe(131_072);
    expect(resolved.reason).toBe("within_model_window");
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "131072"],
    ["fractional", 131_072.5],
    ["zero", 0],
    ["negative", -131_072],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "leaves the configured value untouched when the window is %s — the catalogue never blocks a run",
    (_label, raw) => {
      const resolved = resolveEffectiveContextLimit(256_000, raw);

      expect(resolved.effective).toBe(256_000);
      expect(resolved.modelWindow).toBeNull();
      expect(resolved.reason).toBe("model_window_unknown");
    },
  );

  it("refuses an absurdly small window rather than throttling the agent into it", () => {
    // A hostile or malformed row claiming a 1-token window must not become the
    // effective limit — below the floor it is discarded, not clamped to.
    const resolved = resolveEffectiveContextLimit(256_000, 1);

    expect(resolved.effective).toBe(256_000);
    expect(resolved.reason).toBe("model_window_unusable");
  });

  it("accepts a window exactly AT the floor", () => {
    const resolved = resolveEffectiveContextLimit(256_000, MODEL_CONTEXT_WINDOW_FLOOR);

    expect(resolved.effective).toBe(MODEL_CONTEXT_WINDOW_FLOOR);
    expect(resolved.reason).toBe("clamped_to_model_window");
  });

  it("shares its floor with the operator-facing AGENT_CONTEXT_LIMIT minimum", () => {
    expect(MODEL_CONTEXT_WINDOW_FLOOR).toBe(AGENT_CONTEXT_LIMIT.min);
  });

  it("parses a window only when it is a positive integer", () => {
    expect(parseModelContextWindow(131_072)).toBe(131_072);
    expect(parseModelContextWindow("131072")).toBeNull();
    expect(parseModelContextWindow(null)).toBeNull();
  });
});

describe("fetchModelInferenceConfig — recorded /models response drives the clamp", () => {
  it("bands a 128k-window model against 128k even at the 256k configured default", async () => {
    // The defect P1.4 exists for: at the 256_000 default every pressure band
    // (0.80/0.88/0.92) would sit above this model's real window, so no graceful
    // compact could ever fire before a hard context_length_exceeded.
    const result = await fetchModelInferenceConfig(
      fixtureClient(),
      specFor("aion-labs/aion-3.0", CONFIGURED_DEFAULT),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.config.contextLimit).toBe(131_072);
    // 0.80 of the EFFECTIVE limit is now inside the provider's window.
    expect(result.config.contextLimit * 0.8).toBeLessThan(131_072);
  });

  it("clamps to a window that is only slightly below the configured value", async () => {
    const result = await fetchModelInferenceConfig(
      fixtureClient(),
      specFor("deepseek/deepseek-chat-v3.1", CONFIGURED_DEFAULT),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.config.contextLimit).toBe(163_840);
  });

  it("leaves the configured value alone on a model whose window is larger", async () => {
    const result = await fetchModelInferenceConfig(
      fixtureClient(),
      specFor("anthropic/claude-sonnet-4.5", CONFIGURED_DEFAULT),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    // 1M window > 256k configured — the operator throttle still governs.
    expect(result.config.contextLimit).toBe(CONFIGURED_DEFAULT);
  });

  it("honours a real 4k window, which no longer echoes the env value back", async () => {
    const result = await fetchModelInferenceConfig(
      fixtureClient(),
      specFor("openai/gpt-3.5-turbo-0613", CONFIGURED_DEFAULT),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.config.contextLimit).toBe(4_095);
  });

  it("still resolves the rest of the config from the same row", async () => {
    const result = await fetchModelInferenceConfig(
      fixtureClient(),
      specFor("anthropic/claude-sonnet-4.5", CONFIGURED_DEFAULT),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.config.model).toBe("anthropic/claude-sonnet-4.5");
    expect(result.config.inputPricePerM).toBeGreaterThan(0);
    expect(result.config.supportsReasoningEffort).toBe(true);
  });

  it("keeps the recorded catalogue non-empty and window-bearing (rules/90)", async () => {
    const client = fixtureClient();
    const pages = await client.models.list({});
    const rows = [];
    for await (const page of pages) rows.push(...(page.result.data ?? []));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.contextLength).toBe("number");
      expect(row.contextLength).toBeGreaterThan(0);
    }
  });
});

describe("model-catalog logging — bounded, and no longer echoes the env value", () => {
  it("warns once per catalogue read when the configured limit is clamped", async () => {
    const logger = (await import("@utils/logger.js")).default;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      await fetchModelInferenceConfig(
        fixtureClient(),
        specFor("aion-labs/aion-3.0", CONFIGURED_DEFAULT),
      );

      const adjusted = warn.mock.calls.filter(
        ([event]) => event === "inference.openrouter.context_limit_adjusted",
      );
      expect(adjusted).toHaveLength(1);
      expect(adjusted[0]?.[1]).toMatchObject({
        configured: CONFIGURED_DEFAULT,
        effective: 131_072,
        modelContextWindow: 131_072,
        reason: "clamped_to_model_window",
      });

      const loaded = info.mock.calls.find(
        ([event]) => event === "inference.openrouter.config_loaded",
      );
      expect(loaded?.[1]).toMatchObject({ contextLimit: 131_072 });
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("stays silent when the configured limit already fits", async () => {
    const logger = (await import("@utils/logger.js")).default;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await fetchModelInferenceConfig(
        fixtureClient(),
        specFor("anthropic/claude-sonnet-4.5", CONFIGURED_DEFAULT),
      );

      expect(
        warn.mock.calls.filter(
          ([event]) => event === "inference.openrouter.context_limit_adjusted",
        ),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
