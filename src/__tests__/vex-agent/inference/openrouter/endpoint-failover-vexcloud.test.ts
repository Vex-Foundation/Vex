/**
 * The failover policy with NO endpoint candidates, and with endpoint routing
 * disabled (Vex Cloud): the plan's "verify empty-list tolerance".
 *
 * Written against the real `sendWithEndpointFailover` with only the world
 * injected, and with the real recorded 429 run through the real normaliser,
 * exactly like `endpoint-failover.test.ts`.
 *
 * Pinned:
 *  - an empty candidate list never throws on its own and never switches: the
 *    capacity failure gets the bounded retry, then surfaces the provider's own
 *    error; nothing is persisted;
 *  - with routing disabled the candidate list is not even read, a durable
 *    switch recorded for the session under bring-your-own-key is NOT
 *    re-applied (no read-through, the config is returned untouched, so no
 *    OpenRouter `provider.order` can leave for Vex Cloud), and no switch is
 *    ever made.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { normalizeOpenRouterError } from "@vex-agent/inference/openrouter/errors.js";
import {
  resetAllSessionEndpointState,
  resolveSessionInferenceConfig,
  sendWithEndpointFailover,
  type EndpointFailoverDeps,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import { MAX_CAPACITY_ATTEMPTS } from "@vex-agent/inference/openrouter/endpoint-failover/retry-policy.js";
import type { InferenceConfig } from "@vex-agent/inference/types.js";

function sharedPool429(): Error {
  const raw = new Error("Provider returned error");
  raw.name = "TooManyRequestsResponseError";
  Object.assign(raw, {
    statusCode: 429,
    error: {
      code: 429,
      message: "Provider returned error",
      metadata: { limit_source: "upstream_provider_shared_pool" },
    },
  });
  return normalizeOpenRouterError(raw, "chat completion");
}

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "vexcloud",
    model: "anthropic/claude-haiku-5.5",
    contextLimit: 200_000,
    maxOutputTokens: 8_192,
    inputPricePerM: 1,
    outputPricePerM: 5,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: true,
    ...overrides,
  };
}

interface World {
  readonly deps: EndpointFailoverDeps;
  readonly calls: { candidates: number; persisted: number; readThrough: number; sleeps: number };
}

function world(routing: "enabled" | "disabled" | undefined): World {
  const calls = { candidates: 0, persisted: 0, readThrough: 0, sleeps: 0 };
  return {
    calls,
    deps: {
      loadCandidates: async () => {
        calls.candidates += 1;
        return [];
      },
      sleep: async () => {
        calls.sleeps += 1;
      },
      persistSwitch: async () => {
        calls.persisted += 1;
      },
      loadPersistedSwitch: async (sessionId) => {
        calls.readThrough += 1;
        return {
          sessionId,
          model: "anthropic/claude-haiku-5.5",
          previousEndpoint: null,
          newEndpoint: "anthropic/2",
          reasonClass: "rate_limit",
          createdAt: "2026-10-01T00:00:00.000Z",
        };
      },
      ...(routing !== undefined && { endpointRouting: routing }),
    },
  };
}

const SESSION = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const CONTEXT = { sessionId: SESSION, missionRunId: null };

beforeEach(() => {
  resetAllSessionEndpointState();
});

describe("an empty candidate list (routing enabled)", () => {
  it("retries the capacity failure, never switches, and surfaces the provider's error", async () => {
    const { deps, calls } = world(undefined);
    // Routing enabled but a session switch already on record would be honoured:
    // keep this case about the empty list by recording none.
    const noSwitch: EndpointFailoverDeps = { ...deps, loadPersistedSwitch: async () => null };
    let attempts = 0;
    const failure = sendWithEndpointFailover(
      async () => {
        attempts += 1;
        throw sharedPool429();
      },
      config(),
      CONTEXT,
      noSwitch,
    );

    await expect(failure).rejects.toMatchObject({ statusCode: 429 });
    expect(attempts).toBe(MAX_CAPACITY_ATTEMPTS);
    // The switch gate was reached and found nothing to switch to.
    expect(calls.candidates).toBeGreaterThan(0);
    expect(calls.persisted).toBe(0);
  });

  it("still succeeds on a retry", async () => {
    const { deps } = world(undefined);
    let attempts = 0;
    const result = await sendWithEndpointFailover(
      async () => {
        attempts += 1;
        if (attempts === 1) throw sharedPool429();
        return "ok";
      },
      config(),
      CONTEXT,
      { ...deps, loadPersistedSwitch: async () => null },
    );
    expect(result).toBe("ok");
  });
});

describe("endpoint routing disabled (Vex Cloud)", () => {
  it("does not re-apply a switch recorded under bring-your-own-key, and does not read it", async () => {
    const { deps, calls } = world("disabled");
    const base = config();

    const resolved = await resolveSessionInferenceConfig(base, SESSION, deps);

    expect(resolved).toBe(base);
    expect(resolved.endpointTag).toBeUndefined();
    expect(calls.readThrough).toBe(0);
    expect(calls.candidates).toBe(0);
  });

  it("sends every attempt with the untouched config and never reads candidates", async () => {
    const { deps, calls } = world("disabled");
    const seen: InferenceConfig[] = [];
    const failure = sendWithEndpointFailover(
      async (attemptConfig) => {
        seen.push(attemptConfig);
        throw sharedPool429();
      },
      config(),
      CONTEXT,
      deps,
    );

    await expect(failure).rejects.toMatchObject({ statusCode: 429 });
    expect(seen).toHaveLength(MAX_CAPACITY_ATTEMPTS);
    expect(seen.every((attemptConfig) => attemptConfig.endpointTag === undefined)).toBe(true);
    expect(calls.candidates).toBe(0);
    expect(calls.persisted).toBe(0);
    expect(calls.readThrough).toBe(0);
  });
});
