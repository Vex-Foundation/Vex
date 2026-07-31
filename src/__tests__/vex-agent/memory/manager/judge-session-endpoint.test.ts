/**
 * The memory judge talks to the provider exactly like compaction does.
 *
 * Two regressions are pinned here, both live-verified on 2026-07-31:
 *
 * 1. NO `response_format`. The judge was the only `chatCompletionSimple` caller
 *    in the tree sending a strict `json_schema` format, which
 *    `OpenRouterProvider` pairs with `provider.requireParameters:true`. The
 *    first-party DeepSeek endpoint for the user's model does not advertise
 *    `structured_outputs`, so OpenRouter rejected EVERY consolidate item in
 *    ~50 ms, before inference. The output contract is now carried by the prompt
 *    + brace extraction + the authoritative Zod parse, exactly like
 *    `compaction/branch-provider-call.ts`.
 * 2. The SESSION's current endpoint. A candidate carries the session it was
 *    suggested in; a judge call that ignored a session's endpoint switch would
 *    route back to the endpoint that already ran out of capacity.
 *
 * Nothing here touches a live OpenRouter: the stub exposes the same
 * `failoverDeps()` producer the real provider does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { callJudge, type JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import type { JudgeContext } from "@vex-agent/memory/manager/context-builder.js";
import type { EndpointCandidate, InferenceConfig } from "@vex-agent/inference/types.js";
import { resetAllSessionEndpointState } from "@vex-agent/inference/openrouter/endpoint-failover.js";
import { commitEndpointSwitch } from "@vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js";

const SESSION_ID = "session-judge-endpoint";

const SWITCHED: EndpointCandidate = {
  tag: "baidu/fp8",
  providerName: "Baidu",
  uptimePercent: 99.9,
  contextLength: 128_000,
  inputPricePerM: 2,
  outputPricePerM: 8,
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
};

function loadedConfig(): InferenceConfig {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    contextLimit: 256_000,
    endpointTag: "deepseek/fp8",
    maxOutputTokens: 4_096,
    inputPricePerM: 0.5,
    outputPricePerM: 1.5,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };
}

const PROMOTE_JSON = JSON.stringify({
  verdict: "promote",
  rubric: { grounding: 3, durability: 3, novelty: 3, generalizability: 4, processNotOutcome: 4 },
  sourceTier: "observed",
  regimeTags: ["bull"],
});

function ctx(sessionId: string): JudgeContext {
  return {
    sessionId,
    candidate: {
      kind: "strategy_lesson",
      title: "t",
      summary: "s",
      contentMd: "",
      importance: 7,
      confidence: 0.7,
      eventTime: null,
      observedAt: null,
      recordedAt: "2026-06-10T12:00:00.000Z",
      availableAtDecisionTime: null,
    },
    transcript: "[user] I prefer to scale in slowly.",
    signals: {
      nearDupTopK: [],
      conflictFlag: false,
      conflictKnowledgeId: null,
      evidenceStrengthCeiling: "moderate",
      recurrenceCount: 2,
      anchorExists: true,
      isUserAffirmed: false,
      isGeneralization: true,
    },
    userAffirmationDetected: false,
    knownKinds: [],
    similarCandidates: [],
  };
}

interface Seen {
  readonly configs: InferenceConfig[];
  readonly responseFormats: unknown[];
}

/** Stub shaped like `OpenRouterProvider`: it exposes its own deps producer. */
function providerWithCatalogue(seen: Seen): JudgeProvider {
  return {
    loadConfig: async () => loadedConfig(),
    chatCompletionSimple: async (
      _messages: unknown,
      config: unknown,
      responseFormat?: unknown,
    ) => {
      seen.configs.push(config as InferenceConfig);
      seen.responseFormats.push(responseFormat);
      return { content: PROMOTE_JSON };
    },
    failoverDeps: () => ({ loadCandidates: async () => [SWITCHED] }),
  } as unknown as JudgeProvider;
}

describe("judge provider call — compaction-aligned", () => {
  let seen: Seen;

  beforeEach(() => {
    seen = { configs: [], responseFormats: [] };
    resetAllSessionEndpointState();
  });

  afterEach(() => {
    resetAllSessionEndpointState();
  });

  it("sends NO responseFormat (the ~50 ms pre-inference rejection)", async () => {
    await callJudge(ctx(SESSION_ID), async () => providerWithCatalogue(seen));

    expect(seen.responseFormats).toHaveLength(1);
    expect(seen.responseFormats[0]).toBeUndefined();
  });

  it("runs against the session's SWITCHED endpoint, price and window included", async () => {
    commitEndpointSwitch(SESSION_ID, SWITCHED.tag);

    await callJudge(ctx(SESSION_ID), async () => providerWithCatalogue(seen));

    const used = seen.configs[0];
    expect(used?.endpointTag).toBe(SWITCHED.tag);
    expect(used?.inputPricePerM).toBe(2);
    expect(used?.outputPricePerM).toBe(8);
    expect(used?.contextLimit).toBe(128_000);
  });

  it("is a no-op for a session that never switched", async () => {
    await callJudge(ctx("session-never-switched"), async () => providerWithCatalogue(seen));

    expect(seen.configs[0]?.endpointTag).toBe("deepseek/fp8");
    expect(seen.configs[0]?.inputPricePerM).toBe(0.5);
  });

  it("passes a non-inference stub config straight through (no resolution)", async () => {
    const stubConfig = { model: "stub" };
    await callJudge(ctx(SESSION_ID), async () => ({
      loadConfig: async () => stubConfig,
      chatCompletionSimple: async (_m: unknown, config: unknown) => {
        seen.configs.push(config as InferenceConfig);
        return { content: PROMOTE_JSON };
      },
    }) as unknown as JudgeProvider);

    expect(seen.configs[0]).toBe(stubConfig as unknown as InferenceConfig);
  });
});
