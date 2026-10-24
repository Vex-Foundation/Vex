/**
 * Vex Cloud mode through the REAL `OpenRouterProvider` and SDK, with only the
 * global `fetch` intercepted and the gateway's responses taken from a LIVE
 * capture of its `/v1/models` (`fixtures/vex-cloud/`).
 *
 * Pinned:
 *  - the engine catalogue reads the gateway's `/v1/models` (never
 *    openrouter.ai) and the SDK 1.4.25 inbound schema accepts its rows;
 *  - the reasoning capability is `mandatory: true`, so no `none` is
 *    supported, and the per-model `default_effort` becomes the effort sent
 *    when no explicit one is chosen (D10), also sizing the answer headroom;
 *    bring-your-own-key mode over the same row sends no default;
 *  - D16: the `x-vex-max-tokens` disclosure is read on a JSON response AND on
 *    an SSE response and reaches the notice bus with the session's ids; a
 *    background call (no session) only logs; an unreadable value is logged
 *    and never turned into numbers.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnv } from "@openrouter/sdk/lib/env.js";

const logs = vi.hoisted(() => ({ info: [] as Array<[string, unknown]>, warn: [] as Array<[string, unknown]> }));
vi.mock("@utils/logger.js", () => {
  const quiet = {
    error: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => logs.warn.push([message, meta])),
    info: vi.fn((message: string, meta?: unknown) => logs.info.push([message, meta])),
    debug: vi.fn(),
    child: vi.fn(),
  };
  return { default: quiet, logger: quiet, createChildLogger: () => quiet };
});

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { inferenceNoticeBus } = await import("../../../vex-agent/inference/inference-notice-bus.js");
const { resetAllSessionEndpointState } = await import("../../../vex-agent/inference/openrouter/endpoint-failover.js");
import type { InferenceNoticeEvent } from "../../../vex-agent/inference/inference-notice-bus.js";
import type { InferenceConfig, StreamChunk } from "../../../vex-agent/inference/types.js";

const MODELS = readFileSync(
  new URL("./fixtures/vex-cloud/v1-models.live-2026-10-20.json", import.meta.url),
  "utf8",
);
const SESSION = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const CONTEXT = { sessionId: SESSION, missionRunId: null };

const COMPLETION = JSON.stringify({
  id: "gen-1",
  object: "chat.completion",
  created: 1_760_000_000,
  model: "anthropic/claude-haiku-5.5",
  system_fingerprint: null,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00001 },
});

function sseBody(): string {
  const envelope = { id: "gen-2", object: "chat.completion.chunk", created: 1_760_000_000, model: "anthropic/claude-haiku-5.5" };
  const chunks = [
    { ...envelope, choices: [{ index: 0, delta: { role: "assistant", reasoning: "thinking..." }, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
    {
      ...envelope,
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00002 },
    },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
}

let sent: Sent[] = [];
let clampHeader: string | null = null;
let notices: InferenceNoticeEvent[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  sent = [];
  clampHeader = null;
  notices = [];
  logs.info.length = 0;
  logs.warn.length = 0;
  resetAllSessionEndpointState();
  vi.stubEnv("AGENT_PROVIDER", "vexcloud");
  vi.stubEnv("VEX_CLOUD_SESSION_TOKEN", "vxs_session_for_mode_tests_0001");
  vi.stubEnv("AGENT_MODEL", "anthropic/claude-haiku-5.5");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-unused");
  resetEnv();
  unsubscribe = inferenceNoticeBus.subscribe((event) => notices.push(event));
  vi.stubGlobal("fetch", async (input: unknown) => {
    const request = input as Request;
    const text = request.method === "POST" ? await request.text() : "";
    sent.push({ url: request.url, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : null });
    const headers: Record<string, string> = {};
    if (clampHeader !== null) headers["x-vex-max-tokens"] = clampHeader;
    if (new URL(request.url).pathname === "/v1/models") {
      return new Response(MODELS, { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = sent.at(-1)?.body;
    if (body?.stream === true) {
      return new Response(sseBody(), { status: 200, headers: { ...headers, "content-type": "text/event-stream" } });
    }
    return new Response(COMPLETION, { status: 200, headers: { ...headers, "content-type": "application/json" } });
  });
});

afterEach(() => {
  unsubscribe();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnv();
});

async function cloudConfig(model = "anthropic/claude-haiku-5.5"): Promise<InferenceConfig> {
  vi.stubEnv("AGENT_MODEL", model);
  const config = await new OpenRouterProvider().loadConfig();
  if (config === null) throw new Error("expected a config from /v1/models");
  return config;
}

describe("the catalogue and reasoning capability come from the gateway's /v1/models", () => {
  it("reads /v1/models on the Vex Cloud host and keeps no Off level", async () => {
    const config = await cloudConfig();

    expect(new URL(sent[0]?.url ?? "").origin).toBe("https://inference.projectvex.ai");
    expect(new URL(sent[0]?.url ?? "").pathname).toBe("/v1/models");
    expect(config.provider).toBe("vexcloud");
    expect(config.supportsReasoningEffort).toBe(true);
    expect(config.reasoningSupport?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(config.reasoningSupport?.efforts).not.toContain("none");
    expect(config.reasoningEffortDefault).toBe("medium");
    expect(config.modelMaxCompletionTokens).toBe(65_536);
  });

  it("carries a model's own minimum and default (Gemini Argon: medium and up)", async () => {
    const config = await cloudConfig("google/gemini-4-argon");
    expect(config.reasoningSupport?.efforts).toEqual(["medium", "high"]);
    expect(config.reasoningEffortDefault).toBe("medium");
  });
});

describe("the effort is always sent in Vex Cloud mode", () => {
  it("sends the catalogue default when no effort was chosen, with headroom sized for it", async () => {
    // An effort-native family (the Anthropic families skip the floor on
    // purpose) and a small configured cap make the headroom raise observable.
    const config = { ...(await cloudConfig("openai/gpt-6-luna")), maxOutputTokens: 1_024 };
    await new OpenRouterProvider().chatCompletion([{ role: "user", content: "hi" }], [], config, CONTEXT);
    const withDefault = sent.at(-1)?.body;
    await new OpenRouterProvider().chatCompletion(
      [{ role: "user", content: "hi" }],
      [],
      { ...config, reasoningEffortDefault: undefined },
      CONTEXT,
    );
    const withoutDefault = sent.at(-1)?.body;

    expect(withDefault?.reasoning).toEqual({ effort: "high" });
    // The default effort sizes the answer headroom like an explicit one would.
    expect(Number(withDefault?.max_tokens)).toBeGreaterThan(1_024);
    expect(withoutDefault?.reasoning).toBeUndefined();
    expect(withoutDefault?.max_tokens).toBe(1_024);
  });

  it("an explicit choice wins over the default", async () => {
    const config = await cloudConfig();
    await new OpenRouterProvider().chatCompletion(
      [{ role: "user", content: "hi" }],
      [],
      { ...config, reasoningEffort: "high" },
      CONTEXT,
    );
    expect(sent.at(-1)?.body?.reasoning).toEqual({ effort: "high" });
  });

  it("bring-your-own-key mode over the same row still sends no default", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openrouter");
    const config = await new OpenRouterProvider().loadConfig();
    expect(config?.reasoningEffortDefault).toBeUndefined();
  });
});

describe("D16: the max_tokens disclosure reaches the notice bus", () => {
  it("on a JSON response", async () => {
    const config = await cloudConfig();
    clampHeader = "requested=16384; effective=4096; reason=balance";

    await new OpenRouterProvider().chatCompletion([{ role: "user", content: "hi" }], [], config, CONTEXT);

    expect(notices).toEqual([
      expect.objectContaining({
        type: "engine.inference.notice",
        kind: "max_tokens_clamped",
        sessionId: SESSION,
        missionRunId: null,
        provider: "vexcloud",
        model: "anthropic/claude-haiku-5.5",
        requested: 16_384,
        effective: 4_096,
        reason: "balance",
      }),
    ]);
  });

  it("on an SSE response, with the turn's signal in scope", async () => {
    const config = await cloudConfig();
    clampHeader = "requested=200000; effective=65536; reason=model_limit";
    const controller = new AbortController();

    const chunks: StreamChunk[] = [];
    for await (const chunk of new OpenRouterProvider().chatCompletionStream(
      [{ role: "user", content: "hi" }],
      [],
      config,
      controller.signal,
      CONTEXT,
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ sessionId: SESSION, requested: 200_000, effective: 65_536, reason: "model_limit" });
  });

  it("a background call has no turn to show it on: logged, not emitted", async () => {
    const config = await cloudConfig();
    clampHeader = "requested=8192; effective=4096; reason=balance";

    await new OpenRouterProvider().chatCompletionSimple([{ role: "user", content: "hi" }], config);

    expect(notices).toHaveLength(0);
    expect(logs.info.some(([message]) => message === "inference.max_tokens_clamped")).toBe(true);
  });

  it("an unreadable disclosure is logged and never turned into numbers", async () => {
    const config = await cloudConfig();
    clampHeader = "requested=lots; effective=4096; reason=balance";

    await new OpenRouterProvider().chatCompletion([{ role: "user", content: "hi" }], [], config, CONTEXT);

    expect(notices).toHaveLength(0);
    expect(logs.warn.some(([message]) => message === "inference.max_tokens_clamp_unreadable")).toBe(true);
  });

  it("no header, no notice", async () => {
    const config = await cloudConfig();
    await new OpenRouterProvider().chatCompletion([{ role: "user", content: "hi" }], [], config, CONTEXT);
    expect(notices).toHaveLength(0);
  });
});

describe("F06: a session's own model on Vex Cloud", () => {
  it("one provider resolves each model with that model's own default effort", async () => {
    // AGENT_MODEL stays Haiku (medium); the session picks Sonnet (high).
    const provider = new OpenRouterProvider();
    const fallback = await provider.loadConfig();
    const picked = await provider.loadConfig({ model: "anthropic/claude-sonnet-5.5" });
    const argon = await provider.loadConfig({ model: "google/gemini-4-argon" });

    expect(fallback?.model).toBe("anthropic/claude-haiku-5.5");
    expect(fallback?.reasoningEffortDefault).toBe("medium");
    expect(picked?.model).toBe("anthropic/claude-sonnet-5.5");
    expect(picked?.reasoningEffortDefault).toBe("high");
    expect(argon?.reasoningSupport?.efforts).toEqual(["medium", "high"]);
    // No OpenRouter endpoint pin ever rides a Vex Cloud config.
    expect(picked?.endpointTag).toBeUndefined();
  });

  it("the max_tokens notice names the model the request ran on", async () => {
    const provider = new OpenRouterProvider();
    const picked = await provider.loadConfig({ model: "anthropic/claude-sonnet-5.5" });
    if (picked === null) throw new Error("expected a config for the picked model");
    clampHeader = "requested=16384; effective=4096; reason=balance";

    await provider.chatCompletion([{ role: "user", content: "hi" }], [], picked, CONTEXT);

    expect(notices).toEqual([
      expect.objectContaining({ kind: "max_tokens_clamped", model: "anthropic/claude-sonnet-5.5" }),
    ]);
  });
});
