/**
 * F06 — endpoint failover state is per SESSION AND MODEL.
 *
 * An endpoint tag belongs to one model's endpoint list. Once a session can
 * change its model, a switch made on model A must never route model B, and a
 * background call on `AGENT_MODEL` (the compaction branch, the memory judge)
 * must never inherit a switch the session made on its own pick. Pinned
 * against the REAL `sendWithEndpointFailover` and
 * `resolveSessionInferenceConfig`, with only the world injected:
 *  - the switch, the failure run and the read-through are keyed by model;
 *  - the candidates are loaded for the request's model;
 *  - a durable row for model A is invisible to model B after a restart;
 *  - clearing one model's state leaves the session's other model alone.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { normalizeOpenRouterError } from "@vex-agent/inference/openrouter/errors.js";
import {
  getSwitchedEndpointTag,
  resetAllSessionEndpointState,
  resolveSessionInferenceConfig,
  sendWithEndpointFailover,
  type EndpointFailoverDeps,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import { clearSessionEndpointState } from "@vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js";
import type { EndpointCandidate, InferenceConfig } from "@vex-agent/inference/types.js";
import type { EndpointSwitchRow } from "@vex-agent/db/repos/session-endpoint-switches.js";

const SESSION = "session-model-scope";
const MODEL_A = "vendor/model-a";
const MODEL_B = "vendor/model-b";
const CONTEXT = { sessionId: SESSION, missionRunId: null };

function sharedPool429(): Error {
  const raw = new Error("Provider returned error");
  raw.name = "TooManyRequestsResponseError";
  Object.assign(raw, {
    statusCode: 429,
    error: {
      code: 429,
      message: "Provider returned error",
      metadata: {
        provider_name: "DeepInfra",
        is_byok: false,
        provider_error_code: "engine_overloaded",
        limit_source: "upstream_provider_shared_pool",
      },
    },
  });
  return normalizeOpenRouterError(raw, "chat completion");
}

function candidate(model: string, tag: string): EndpointCandidate {
  return {
    tag,
    providerName: `${model} host`,
    uptimePercent: 99,
    contextLength: 64_000,
    inputPricePerM: 1,
    outputPricePerM: 2,
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
  };
}

function config(model: string): InferenceConfig {
  return {
    provider: "openrouter",
    model,
    contextLimit: 128_000,
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

/** A durable table keyed by (session, model), the way the real read is scoped. */
function harness() {
  const durable = new Map<string, EndpointSwitchRow>();
  const candidateReads: string[] = [];
  const deps: EndpointFailoverDeps = {
    loadCandidates: async (model) => {
      candidateReads.push(model);
      return [candidate(model, `${model}/healthy`)];
    },
    sleep: async () => undefined,
    persistSwitch: async (record) => {
      durable.set(`${record.sessionId}|${record.model}`, {
        ...record,
        createdAt: "2026-10-23T00:00:00.000Z",
      });
    },
    loadPersistedSwitch: async (sessionId, model) => durable.get(`${sessionId}|${model}`) ?? null,
  };
  return { deps, durable, candidateReads };
}

/** Fails `failures` times with a switchable 429, then succeeds. */
function failingAttempt(failures: number) {
  const seen: InferenceConfig[] = [];
  let calls = 0;
  return {
    seen,
    attempt: async (attemptConfig: InferenceConfig): Promise<string> => {
      seen.push(attemptConfig);
      calls += 1;
      if (calls <= failures) throw sharedPool429();
      return "ok";
    },
  };
}

beforeEach(() => {
  resetAllSessionEndpointState();
});

describe("endpoint failover is scoped by model (F06)", () => {
  it("a switch made on model A does not route model B", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, config(MODEL_A), CONTEXT, h.deps);
    expect(getSwitchedEndpointTag({ sessionId: SESSION, model: MODEL_A })).toBe(`${MODEL_A}/healthy`);

    const onB = failingAttempt(0);
    await sendWithEndpointFailover(onB.attempt, config(MODEL_B), CONTEXT, h.deps);

    expect(onB.seen[0]?.endpointTag).toBeUndefined();
    expect(getSwitchedEndpointTag({ sessionId: SESSION, model: MODEL_B })).toBeNull();
  });

  it("loads candidates for the request's model", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, config(MODEL_B), CONTEXT, h.deps);
    expect(h.candidateReads).toEqual([MODEL_B]);
  });

  it("model B's failure run starts from zero after model A's failures", async () => {
    const h = harness();
    // One failure on A, then the session moves to B: one failure on B is the
    // FIRST in B's run, so it retries in place rather than switching.
    await sendWithEndpointFailover(failingAttempt(1).attempt, config(MODEL_A), CONTEXT, h.deps);
    const onB = failingAttempt(1);
    await sendWithEndpointFailover(onB.attempt, config(MODEL_B), CONTEXT, h.deps);

    expect(onB.seen.map((c) => c.endpointTag)).toEqual([undefined, undefined]);
    expect(h.durable.size).toBe(0);
  });

  it("after a restart a durable row for model A is invisible to model B", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, config(MODEL_A), CONTEXT, h.deps);
    resetAllSessionEndpointState();

    const onB = await resolveSessionInferenceConfig(config(MODEL_B), SESSION, h.deps);
    const onA = await resolveSessionInferenceConfig(config(MODEL_A), SESSION, h.deps);

    expect(onB.endpointTag).toBeUndefined();
    expect(onA.endpointTag).toBe(`${MODEL_A}/healthy`);
  });

  it("a background call on the default model gets no endpoint from the session's pick", async () => {
    // The session switched on its own pick (B); the compaction branch and the
    // memory judge run on AGENT_MODEL (A) through this same seam.
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, config(MODEL_B), CONTEXT, h.deps);

    const background = await resolveSessionInferenceConfig(config(MODEL_A), SESSION, h.deps);
    expect(background.endpointTag).toBeUndefined();
  });

  it("clearing one model's state leaves the session's other model alone", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, config(MODEL_A), CONTEXT, h.deps);
    await sendWithEndpointFailover(failingAttempt(2).attempt, config(MODEL_B), CONTEXT, h.deps);

    clearSessionEndpointState(SESSION, MODEL_A);

    expect(getSwitchedEndpointTag({ sessionId: SESSION, model: MODEL_A })).toBeNull();
    expect(getSwitchedEndpointTag({ sessionId: SESSION, model: MODEL_B })).toBe(`${MODEL_B}/healthy`);
  });
});
