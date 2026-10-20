/**
 * The one inference client factory, per mode, through the REAL
 * `OpenRouterProvider` and SDK with only the global `fetch` intercepted.
 *
 * What this pins, and why each is worth a test:
 *
 *  - Vex Cloud mode sends to the Vex Cloud host with the session bearer, and
 *    the bring-your-own-key mode to openrouter.ai with the OpenRouter key.
 *    The SDK's environment fallbacks (`OPENROUTER_BASE_URL` for the origin,
 *    `OPENROUTER_API_KEY` for the bearer) are both armed in every case: a
 *    factory that omitted either option would leak the user's OpenRouter key
 *    to our gateway, or the session to another host, and the assertion is on
 *    the bytes that would have gone over the wire;
 *  - a missing Vex Cloud session throws by name and NEVER falls back to the
 *    OpenRouter key;
 *  - the development override applies only when main allowed it;
 *  - the OpenRouter balance endpoints are not called in Vex Cloud mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnv } from "@openrouter/sdk/lib/env.js";

vi.mock("@utils/logger.js", () => {
  const quiet = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
  return { default: quiet, logger: quiet, createChildLogger: () => quiet };
});

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { allowVexCloudDevOverride } = await import("../../../lib/vex-cloud-endpoint.js");
const { resolveInferenceConnection } = await import(
  "../../../vex-agent/inference/openrouter/client-factory.js"
);
import type { InferenceConfig } from "../../../vex-agent/inference/types.js";

const OPENROUTER_KEY = "sk-or-must-never-reach-vex-cloud";
const SESSION = "vxs_session_bearer_for_tests_0001";

interface Captured {
  readonly url: string;
  readonly authorization: string | null;
}

let captured: Captured[] = [];

function requestOf(input: unknown, init?: RequestInit): Captured {
  if (input instanceof Request) {
    return { url: input.url, authorization: input.headers.get("authorization") };
  }
  const headers = new Headers(init?.headers);
  return { url: String(input), authorization: headers.get("authorization") };
}

const COMPLETION = {
  id: "gen-test",
  object: "chat.completion",
  created: 1_760_000_000,
  model: "test/model",
  system_fingerprint: null,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.00001 },
};

function config(provider: string): InferenceConfig {
  return {
    provider,
    model: "test/model",
    contextLimit: 100_000,
    maxOutputTokens: 256,
    inputPricePerM: 1,
    outputPricePerM: 2,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };
}

beforeEach(() => {
  captured = [];
  // Both SDK fallbacks armed for every case.
  vi.stubEnv("OPENROUTER_API_KEY", OPENROUTER_KEY);
  vi.stubEnv("OPENROUTER_BASE_URL", "https://redirect.invalid/api/v1");
  vi.stubEnv("AGENT_MODEL", "test/model");
  resetEnv();
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    captured.push(requestOf(input, init));
    return new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  allowVexCloudDevOverride(false);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnv();
});

describe("Vex Cloud mode", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_PROVIDER", "vexcloud");
    vi.stubEnv("VEX_CLOUD_SESSION_TOKEN", SESSION);
  });

  it("sends to the built-in Vex Cloud host with the session bearer, never the OpenRouter key", async () => {
    const provider = new OpenRouterProvider();
    expect(provider.id).toBe("vexcloud");

    await provider.chatCompletionSimple([{ role: "user", content: "hi" }], config(provider.id));

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(new URL(request?.url ?? "").origin).toBe("https://inference.projectvex.ai");
    expect(new URL(request?.url ?? "").pathname).toBe("/v1/chat/completions");
    expect(request?.authorization).toBe(`Bearer ${SESSION}`);
    expect(JSON.stringify(captured)).not.toContain(OPENROUTER_KEY);
    expect(JSON.stringify(captured)).not.toContain("redirect.invalid");
  });

  it("honours the development override only when main allowed it", async () => {
    vi.stubEnv("VEX_DEV_CLOUD_API_URL", "http://127.0.0.1:8787");

    await new OpenRouterProvider().chatCompletionSimple([{ role: "user", content: "a" }], config("vexcloud"));
    allowVexCloudDevOverride(true);
    await new OpenRouterProvider().chatCompletionSimple([{ role: "user", content: "b" }], config("vexcloud"));

    expect(captured.map((request) => new URL(request.url).origin)).toEqual([
      "https://inference.projectvex.ai",
      "http://127.0.0.1:8787",
    ]);
  });

  it("refuses a malformed override instead of half-parsing it", () => {
    allowVexCloudDevOverride(true);
    vi.stubEnv("VEX_DEV_CLOUD_API_URL", "http://127.0.0.1:8787/v1?x=1");
    expect(resolveInferenceConnection({ agentProvider: "vexcloud", openrouterApiKey: null, vexCloudSessionToken: SESSION }).serverURL)
      .toBe("https://inference.projectvex.ai/v1");
  });

  it("throws by name without a session and never borrows the OpenRouter key", () => {
    vi.stubEnv("VEX_CLOUD_SESSION_TOKEN", "");
    expect(() => new OpenRouterProvider()).toThrow(/VEX_CLOUD_SESSION_TOKEN is required/);
    expect(captured).toHaveLength(0);
  });

  it("does not call the OpenRouter balance endpoints", async () => {
    const balance = await new OpenRouterProvider().getBalance();
    expect(balance).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("offers no endpoint candidates and disables endpoint routing", async () => {
    const deps = new OpenRouterProvider().failoverDeps();
    expect(deps.endpointRouting).toBe("disabled");
    await expect(deps.loadCandidates()).resolves.toEqual([]);
    expect(captured).toHaveLength(0);
  });
});

describe("bring-your-own-key mode", () => {
  it("sends to openrouter.ai with the OpenRouter key, unchanged", async () => {
    const provider = new OpenRouterProvider();
    expect(provider.id).toBe("openrouter");

    await provider.chatCompletionSimple([{ role: "user", content: "hi" }], config(provider.id));

    expect(captured).toHaveLength(1);
    expect(new URL(captured[0]?.url ?? "").origin).toBe("https://openrouter.ai");
    expect(captured[0]?.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
  });

  it("is chosen explicitly as well as by default", () => {
    vi.stubEnv("AGENT_PROVIDER", "openrouter");
    vi.stubEnv("VEX_CLOUD_SESSION_TOKEN", SESSION);
    const connection = resolveInferenceConnection({
      agentProvider: "openrouter",
      openrouterApiKey: OPENROUTER_KEY,
      vexCloudSessionToken: SESSION,
    });
    expect(connection).toEqual({ mode: "openrouter", serverURL: "https://openrouter.ai/api/v1", apiKey: OPENROUTER_KEY });
  });
});
