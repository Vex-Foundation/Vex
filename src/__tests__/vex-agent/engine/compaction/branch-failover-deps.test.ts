/**
 * A compaction branch derives REAL failover deps from its own provider.
 *
 * The regression this pins: the branch worker holds a provider through the
 * loose structural `JudgeProvider` interface, so when the only producer of a
 * candidate list was private the default was an EMPTY list. Routing still
 * followed the session's switched endpoint tag, but the price and context
 * window silently fell back to model-level values — a switched session's
 * compaction call reading the wrong endpoint's numbers.
 *
 * Nothing here touches a live OpenRouter: the stub exposes the same
 * `failoverDeps()` producer the real `OpenRouterProvider` does, which is
 * exactly the contract `endpointFailoverDepsFrom` detects.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import type { EndpointCandidate, InferenceConfig } from "@vex-agent/inference/types.js";
import { callBranchProvider } from "@vex-agent/engine/compaction/branch-provider-call.js";
import {
  endpointFailoverDepsFrom,
  resetAllSessionEndpointState,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
// Reached through the internal module, not the gate: committing a switch is a
// POLICY decision the failover owns, so the public gate deliberately does not
// expose a lever that would let anything else re-route a live session.
import { commitEndpointSwitch } from "@vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js";
import { z } from "zod";

const SESSION_ID = "session-failover-deps";

/** The endpoint the session switched to — narrower window, different price. */
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
    model: "deepseek/deepseek-v4-flash",
    contextLimit: 256_000,
    endpointTag: "deepinfra/fp4",
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

/** Stub shaped like `OpenRouterProvider`: it exposes its own deps producer. */
function providerWithCatalogue(seenConfigs: InferenceConfig[]): JudgeProvider {
  return {
    loadConfig: async () => loadedConfig(),
    chatCompletionSimple: async (_messages, config) => {
      seenConfigs.push(config as InferenceConfig);
      return { content: JSON.stringify({ ok: true }), usage: { cost: 0.001 } };
    },
    failoverDeps: () => ({ loadCandidates: async () => [SWITCHED] }),
  } as unknown as JudgeProvider;
}

async function runBranch(provider: JudgeProvider) {
  return callBranchProvider({
    label: "compaction_test",
    sessionId: SESSION_ID,
    systemPrompt: "s",
    // Branches fork from the tape: a frozen role-bearing prefix, then the
    // instruction as the final user turn.
    prefix: [{ role: "user" as const, content: "earlier turn" }],
    instruction: "u",
    timeoutMs: 5_000,
    schema: z.object({ ok: z.boolean() }),
    makeProvider: async () => provider,
    preparationId: 1,
  });
}

describe("branch provider call — failover deps come from the provider", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "test/model";
    resetAllSessionEndpointState();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
    resetAllSessionEndpointState();
  });

  it("re-resolves the switched endpoint's PRICE and WINDOW with no injected deps", async () => {
    commitEndpointSwitch(SESSION_ID, SWITCHED.tag);
    const seen: InferenceConfig[] = [];

    await runBranch(providerWithCatalogue(seen));

    const used = seen[0];
    // Routing follows the switch…
    expect(used?.endpointTag).toBe(SWITCHED.tag);
    // …and so do the numbers, which is what the empty default lost.
    expect(used?.inputPricePerM).toBe(2);
    expect(used?.outputPricePerM).toBe(8);
    expect(used?.contextLimit).toBe(128_000);
  });

  it("is a no-op for a session that never switched", async () => {
    const seen: InferenceConfig[] = [];
    await runBranch(providerWithCatalogue(seen));

    expect(seen[0]?.endpointTag).toBe("deepinfra/fp4");
    expect(seen[0]?.inputPricePerM).toBe(0.5);
  });

  it("still honours the switched TAG when the provider offers no catalogue", async () => {
    // Degraded, not broken: a stub or a non-OpenRouter provider yields no
    // candidates, and owner decision 4 (route to the switched endpoint) still
    // holds — only the numbers fall back.
    commitEndpointSwitch(SESSION_ID, SWITCHED.tag);
    const seen: InferenceConfig[] = [];

    await runBranch({
      loadConfig: async () => loadedConfig(),
      chatCompletionSimple: async (_messages, config) => {
        seen.push(config as InferenceConfig);
        return { content: JSON.stringify({ ok: true }) };
      },
    } as unknown as JudgeProvider);

    expect(seen[0]?.endpointTag).toBe(SWITCHED.tag);
    expect(seen[0]?.inputPricePerM).toBe(0.5);
  });
});

describe("endpointFailoverDepsFrom", () => {
  it("uses the provider's own producer when it has one", async () => {
    const deps = endpointFailoverDepsFrom({
      failoverDeps: () => ({ loadCandidates: async () => [SWITCHED] }),
    });
    await expect(deps.loadCandidates()).resolves.toEqual([SWITCHED]);
  });

  it.each([
    ["a plain stub", { loadConfig: async () => ({}) }],
    ["a producer returning junk", { failoverDeps: () => 42 }],
    ["a non-callable property", { failoverDeps: "nope" }],
    ["null", null],
    ["undefined", undefined],
  ])("falls back to empty candidates for %s — total, never throws", async (_label, source) => {
    const deps = endpointFailoverDepsFrom(source);
    await expect(deps.loadCandidates()).resolves.toEqual([]);
  });
});
