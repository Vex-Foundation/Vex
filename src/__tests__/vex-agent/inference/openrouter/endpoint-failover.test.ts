/**
 * The failover policy itself: retry, the two-failure switch, stickiness, and
 * the cost/context re-resolve.
 *
 * These assertions ARE the owner's decisions, so they are written against the
 * real `sendWithEndpointFailover` with only the world injected (clock, catalogue,
 * persistence). Re-implementing the policy in the test would be the failure
 * mode `rules/90` names explicitly — a suite that stays green while the product
 * cannot route at all.
 *
 * Errors are produced by the REAL `normalizeOpenRouterError` from the REAL
 * recorded 429 shape, so classification is exercised end to end rather than by
 * hand-attached properties.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { normalizeOpenRouterError } from "@vex-agent/inference/openrouter/errors.js";
import {
  applyEndpointToConfig,
  resetAllSessionEndpointState,
  resolveSessionInferenceConfig,
  selectSwitchTarget,
  sendWithEndpointFailover,
  type EndpointFailoverDeps,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type { EndpointCandidate, InferenceConfig } from "@vex-agent/inference/types.js";
import type { EndpointSwitchRow } from "@vex-agent/db/repos/session-endpoint-switches.js";
import {
  clearSessionEndpointState,
  MAX_TRACKED_SESSIONS,
  trackedSessionCount,
} from "@vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js";

// ── fixtures ─────────────────────────────────────────────────────

/** The live-recorded 429: shared-pool limit, no Retry-After header. */
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

/** Same 429, but the limit was applied to OUR account. */
function accountLimit429(): Error {
  const raw = new Error("Provider returned error");
  raw.name = "TooManyRequestsResponseError";
  Object.assign(raw, {
    statusCode: 429,
    error: {
      code: 429,
      message: "Provider returned error",
      metadata: { limit_source: "account_daily_quota" },
    },
  });
  return normalizeOpenRouterError(raw, "chat completion");
}

function badRequest400(): Error {
  const raw = new Error("bad request");
  raw.name = "BadRequestResponseError";
  Object.assign(raw, { statusCode: 400, error: { code: 400, message: "bad request" } });
  return normalizeOpenRouterError(raw, "chat completion");
}

const PINNED_TAG = "deepinfra/fp4";

const HEALTHIEST: EndpointCandidate = {
  tag: "baidu/fp8",
  providerName: "Baidu",
  uptimePercent: 99.9,
  contextLength: 128_000,
  inputPricePerM: 2,
  outputPricePerM: 8,
  cachePricePerM: 0.2,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
};

const LESS_HEALTHY: EndpointCandidate = {
  ...HEALTHIEST,
  tag: "novita/fp8",
  providerName: "Novita",
  uptimePercent: 91.2,
  contextLength: 64_000,
  inputPricePerM: 1,
};

const PINNED_CANDIDATE: EndpointCandidate = {
  ...HEALTHIEST,
  tag: PINNED_TAG,
  providerName: "DeepInfra",
  uptimePercent: 80,
  contextLength: 256_000,
  inputPricePerM: 0.5,
};

function baseConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    contextLimit: 256_000,
    endpointTag: PINNED_TAG,
    maxOutputTokens: 8_192,
    inputPricePerM: 0.5,
    outputPricePerM: 1.5,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
    ...overrides,
  };
}

interface Harness {
  readonly deps: EndpointFailoverDeps;
  readonly sleeps: number[];
  /** Durable rows the runtime WROTE, in order. */
  readonly switches: Array<Record<string, unknown>>;
  /** Ordered trace of side effects, so persist-BEFORE-adopt is assertable. */
  readonly trace: string[];
  /** Simulated durable table, keyed by session exactly as the real query is. */
  readonly durable: Map<string, EndpointSwitchRow>;
  /** Flip to make the durable write fail. */
  readonly failPersist: { value: boolean };
}

/**
 * The durable table is INJECTED in every unit test. Without it the failover
 * would read through to real Postgres from a unit suite — and, worse, a passing
 * test would prove nothing about stickiness because the row would never exist.
 */
function harness(
  candidates: readonly EndpointCandidate[] = [HEALTHIEST, LESS_HEALTHY, PINNED_CANDIDATE],
): Harness {
  const sleeps: number[] = [];
  const switches: Array<Record<string, unknown>> = [];
  const trace: string[] = [];
  const durable = new Map<string, EndpointSwitchRow>();
  const failPersist = { value: false };
  return {
    sleeps,
    switches,
    trace,
    durable,
    failPersist,
    deps: {
      // Ranked highest-uptime-first, exactly as `loadEndpointCandidates` returns it.
      loadCandidates: async () => candidates,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      persistSwitch: async (record) => {
        if (failPersist.value) {
          trace.push(`persist_failed:${record.newEndpoint}`);
          throw new Error("db down");
        }
        trace.push(`persisted:${record.newEndpoint}`);
        switches.push({ ...record });
        durable.set(record.sessionId, {
          ...record,
          createdAt: "2026-07-30T00:00:00.000Z",
        });
      },
      loadPersistedSwitch: async (sessionId) => {
        trace.push(`read_through:${sessionId}`);
        return durable.get(sessionId) ?? null;
      },
    },
  };
}

/** An attempt that fails `failures` times, then succeeds. Records each config. */
function failingAttempt(failures: number, error: () => Error = sharedPool429) {
  const seen: InferenceConfig[] = [];
  let calls = 0;
  const attempt = async (config: InferenceConfig): Promise<string> => {
    seen.push(config);
    calls += 1;
    if (calls <= failures) throw error();
    return "ok";
  };
  return { attempt, seen, callCount: () => calls };
}

const CONTEXT = { sessionId: "session-a", missionRunId: null };

beforeEach(() => {
  resetAllSessionEndpointState();
});

// ── retry ────────────────────────────────────────────────────────

describe("sendWithEndpointFailover — retry", () => {
  it("retries a capacity failure and succeeds on the second attempt", async () => {
    const { attempt, callCount } = failingAttempt(1);
    const h = harness();

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps),
    ).resolves.toBe("ok");
    expect(callCount()).toBe(2);
  });

  it("does NOT retry a non-capacity failure — it fails on attempt one, as before", async () => {
    const { attempt, callCount } = failingAttempt(1, badRequest400);
    const h = harness();

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps),
    ).rejects.toThrow(/status=400/);
    expect(callCount()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("backs off on its OWN schedule when the provider sends no Retry-After — the live case", async () => {
    const { attempt } = failingAttempt(1);
    const h = harness();

    await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);
    // No header on the recorded 429, so the wait comes from the local policy.
    expect(h.sleeps).toEqual([1_000]);
  });

  // T8 — the operator's Stop reaches the capacity backoff.
  //
  // A Stop pressed while we sit out an honoured `Retry-After` used to cost the
  // full advertised delay (up to 10 s, twice). The wait is now signal-aware, so
  // the `for(;;)` unwinds immediately — and it surfaces the PROVIDER'S error,
  // not the abort: the operator stopped a request that was already failing, and
  // the provider's reason is the one worth reporting.
  describe("operator Stop during the capacity backoff", () => {
    it("exits with the provider's error and never re-attempts", async () => {
      const withHint = (): Error => {
        const err = sharedPool429();
        Object.defineProperty(err, "retryAfterSeconds", { value: 10, enumerable: false });
        return err;
      };
      const { attempt, callCount } = failingAttempt(5, withHint);
      const controller = new AbortController();
      const h = harness();
      // The real `defaultSleep` is signal-aware; this double reproduces its
      // contract so the policy — not the timer — is what is under test.
      const deps: EndpointFailoverDeps = {
        ...h.deps,
        sleep: async (ms, signal) => {
          h.sleeps.push(ms);
          controller.abort();
          signal?.throwIfAborted();
        },
      };

      const startedAt = Date.now();
      await expect(
        sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, deps, controller.signal),
      ).rejects.toThrow(/429|Provider returned error/);

      // One attempt, one abandoned wait, and NO second attempt — the loop is
      // gone, not merely slowed.
      expect(callCount()).toBe(1);
      expect(h.sleeps).toEqual([10_000]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it("with no signal, the backoff is unchanged", async () => {
      const { attempt, callCount } = failingAttempt(1);
      const h = harness();
      await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);
      expect(callCount()).toBe(2);
      expect(h.sleeps).toEqual([1_000]);
    });
  });

  it("HONOURS Retry-After when the provider does send one", async () => {
    const withHint = (): Error => {
      const err = sharedPool429();
      Object.defineProperty(err, "retryAfterSeconds", { value: 4, enumerable: false });
      return err;
    };
    const { attempt } = failingAttempt(1, withHint);
    const h = harness();

    await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);
    expect(h.sleeps).toEqual([4_000]);
  });

  it("refuses to sit out an absurdly long advertised wait, and surfaces the error", async () => {
    const withLongHint = (): Error => {
      const err = sharedPool429();
      Object.defineProperty(err, "retryAfterSeconds", { value: 3_600, enumerable: false });
      return err;
    };
    const { attempt, callCount } = failingAttempt(99, withLongHint);
    const h = harness();

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps),
    ).rejects.toThrow(/status=429/);
    // One attempt, no sleep, no switch (the first failure never switches).
    expect(callCount()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.switches).toEqual([]);
  });
});

// ── the two-failure switch ───────────────────────────────────────

describe("sendWithEndpointFailover — switch after TWO consecutive failures", () => {
  it("ONE failure does not switch — it retries the SAME endpoint", async () => {
    const { attempt, seen } = failingAttempt(1);
    const h = harness();

    await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);
    expect(seen.map((c) => c.endpointTag)).toEqual([PINNED_TAG, PINNED_TAG]);
    expect(h.switches).toEqual([]);
  });

  it("TWO consecutive failures switch to the HIGHEST-UPTIME endpoint", async () => {
    const { attempt, seen } = failingAttempt(2);
    const h = harness();

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps),
    ).resolves.toBe("ok");
    // pinned, pinned, then the healthiest sibling — NOT the cheapest
    // (`novita/fp8` is cheaper and was rejected).
    expect(seen.map((c) => c.endpointTag)).toEqual([PINNED_TAG, PINNED_TAG, HEALTHIEST.tag]);
  });

  it("a switch IS the retry — it does not also sit out the failed endpoint's backoff", async () => {
    const { attempt } = failingAttempt(2);
    const h = harness();

    await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);
    // One sleep (after failure 1), none after the switch.
    expect(h.sleeps).toEqual([1_000]);
  });

  it("an ACCOUNT-level 429 retries but NEVER switches", async () => {
    const { attempt, seen } = failingAttempt(99, accountLimit429);
    const h = harness();

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps),
    ).rejects.toThrow(/status=429/);
    // Every attempt stayed on the pin; no endpoint can escape our own quota.
    expect(new Set(seen.map((c) => c.endpointTag))).toEqual(new Set([PINNED_TAG]));
    expect(h.switches).toEqual([]);
  });

  it("surfaces the provider error when there is nothing to switch TO", async () => {
    const { attempt } = failingAttempt(99);
    // Catalogue lists only the endpoint we are already on.
    const h = harness([PINNED_CANDIDATE]);

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps),
    ).rejects.toThrow(/status=429/);
    expect(h.switches).toEqual([]);
  });

  it("prefers the INJECTED candidate list over the runtime's own read", async () => {
    const { attempt, seen } = failingAttempt(2);
    const loadCandidates = vi.fn(async () => [HEALTHIEST]);
    const injected: EndpointCandidate = { ...LESS_HEALTHY, tag: "injected/only" };

    await sendWithEndpointFailover(
      attempt,
      baseConfig({ endpointCandidates: [injected] }),
      CONTEXT,
      { loadCandidates, sleep: async () => undefined, persistSwitch: async () => undefined },
    );

    expect(seen[2]?.endpointTag).toBe("injected/only");
    expect(loadCandidates).not.toHaveBeenCalled();
  });
});

// ── stickiness ───────────────────────────────────────────────────

describe("sendWithEndpointFailover — the switch is sticky for the session", () => {
  it("a LATER failure in the same session does NOT switch again", async () => {
    const h = harness();
    // First send: two failures, switch to HEALTHIEST, then succeed.
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);
    expect(h.switches).toHaveLength(1);

    // Second send in the SAME session: two more failures.
    const second = failingAttempt(2);
    await sendWithEndpointFailover(second.attempt, baseConfig(), CONTEXT, h.deps);

    // Every attempt used the already-switched endpoint, and no second switch
    // was recorded — rotating per failure would trash the prompt-cache prefix
    // and multiply with mission auto-retry.
    expect(second.seen.map((c) => c.endpointTag)).toEqual([
      HEALTHIEST.tag,
      HEALTHIEST.tag,
      HEALTHIEST.tag,
    ]);
    expect(h.switches).toHaveLength(1);
  });

  it("a NEW session starts from the operator's pin", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    const fresh = failingAttempt(0);
    await sendWithEndpointFailover(fresh.attempt, baseConfig(), {
      sessionId: "session-b",
      missionRunId: null,
    }, h.deps);

    expect(fresh.seen[0]?.endpointTag).toBe(PINNED_TAG);
  });

  it("a success resets the failure run, so two failures an hour apart never add up", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(1).attempt, baseConfig(), CONTEXT, h.deps);
    // Failure #1 happened, then a success. A single later failure must still
    // retry in place rather than switching.
    const later = failingAttempt(1);
    await sendWithEndpointFailover(later.attempt, baseConfig(), CONTEXT, h.deps);

    expect(later.seen.map((c) => c.endpointTag)).toEqual([PINNED_TAG, PINNED_TAG]);
    expect(h.switches).toEqual([]);
  });

  it("a background call (no session) retries but never switches or persists", async () => {
    const { attempt, seen } = failingAttempt(99);
    const h = harness();

    await expect(
      sendWithEndpointFailover(attempt, baseConfig(), undefined, h.deps),
    ).rejects.toThrow(/status=429/);
    expect(new Set(seen.map((c) => c.endpointTag))).toEqual(new Set([PINNED_TAG]));
    expect(h.switches).toEqual([]);
  });
});

// ── durable stickiness (survives restart + eviction) ─────────────

describe("sendWithEndpointFailover — stickiness is anchored in the DURABLE row", () => {
  it("after a process restart the session keeps the switched endpoint and does NOT switch again", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);
    expect(h.switches).toHaveLength(1);

    // A restart is exactly this: the durable row survives, the in-memory map
    // does not. Previously the session came back on the pin that had already
    // run out of capacity and switched a SECOND time.
    resetAllSessionEndpointState();

    const afterRestart = failingAttempt(2);
    await sendWithEndpointFailover(afterRestart.attempt, baseConfig(), CONTEXT, h.deps);

    // Every attempt on the recovered endpoint, and NO second durable row.
    expect(afterRestart.seen.map((c) => c.endpointTag)).toEqual([
      HEALTHIEST.tag,
      HEALTHIEST.tag,
      HEALTHIEST.tag,
    ]);
    expect(h.switches).toHaveLength(1);
  });

  it("LRU eviction cannot break stickiness — the next request read-throughs", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    // Evict just this session, leaving the durable row intact.
    clearSessionEndpointState("session-a");
    expect(trackedSessionCount()).toBe(0);

    const afterEviction = failingAttempt(0);
    await sendWithEndpointFailover(afterEviction.attempt, baseConfig(), CONTEXT, h.deps);

    expect(afterEviction.seen[0]?.endpointTag).toBe(HEALTHIEST.tag);
    expect(h.switches).toHaveLength(1);
  });

  it("re-resolves the recovered endpoint's PRICE and WINDOW, not just its tag", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);
    resetAllSessionEndpointState();

    const afterRestart = failingAttempt(0);
    await sendWithEndpointFailover(afterRestart.attempt, baseConfig(), CONTEXT, h.deps);

    expect(afterRestart.seen[0]?.inputPricePerM).toBe(2);
    expect(afterRestart.seen[0]?.contextLimit).toBe(128_000);
  });

  it("reads the durable table at most ONCE per session per process", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);

    expect(h.trace.filter((t) => t.startsWith("read_through"))).toEqual([
      "read_through:session-a",
    ]);
  });

  it("a session that never switched stays on the pin after a read-through", async () => {
    const h = harness();
    const fresh = failingAttempt(0);
    await sendWithEndpointFailover(fresh.attempt, baseConfig(), CONTEXT, h.deps);
    expect(fresh.seen[0]?.endpointTag).toBe(PINNED_TAG);
  });

  it("proceeds as un-switched when the durable table cannot be read", async () => {
    // Degraded, not fatal: refusing the turn because a provenance table is
    // unavailable would be worse than routing to the operator's pin.
    const fresh = failingAttempt(0);
    await sendWithEndpointFailover(fresh.attempt, baseConfig(), CONTEXT, {
      loadCandidates: async () => [HEALTHIEST],
      sleep: async () => undefined,
      persistSwitch: async () => undefined,
      loadPersistedSwitch: async () => {
        throw new Error("db unreachable");
      },
    });
    expect(fresh.seen[0]?.endpointTag).toBe(PINNED_TAG);
  });
});

// ── persistence ──────────────────────────────────────────────────

describe("sendWithEndpointFailover — the switch is recorded", () => {
  it("records session, previous endpoint, new endpoint and reason class", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    expect(h.switches).toEqual([
      {
        sessionId: "session-a",
        model: "deepseek/deepseek-v4-flash",
        previousEndpoint: PINNED_TAG,
        newEndpoint: HEALTHIEST.tag,
        reasonClass: "rate_limited_shared_pool",
      },
    ]);
  });

  it("records a NULL previous endpoint for an unpinned (Auto) session", async () => {
    const h = harness();
    await sendWithEndpointFailover(
      failingAttempt(2).attempt,
      baseConfig({ endpointTag: undefined }),
      CONTEXT,
      h.deps,
    );
    expect(h.switches[0]?.previousEndpoint).toBeNull();
  });

  it("writes the durable row BEFORE adopting the switch in memory", async () => {
    // Order is the contract: the durable row is what makes stickiness survive a
    // crash, so adopting first would leave a window where a crash loses the
    // switch and the session returns to the endpoint that failed.
    const h = harness();
    const { attempt, seen } = failingAttempt(2);
    await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);

    const persistIndex = h.trace.indexOf(`persisted:${HEALTHIEST.tag}`);
    expect(persistIndex).toBeGreaterThanOrEqual(0);
    // The switched attempt is the third one; the write happened before it ran.
    expect(seen[2]?.endpointTag).toBe(HEALTHIEST.tag);
  });

  it("a persistence failure does not fail the turn, and is RETRIED until it lands", async () => {
    const h = harness();
    h.failPersist.value = true;

    // Turn one: the write fails, the switch is adopted anyway so the turn is
    // rescued, and nothing durable exists yet.
    const first = failingAttempt(2);
    await expect(
      sendWithEndpointFailover(first.attempt, baseConfig(), CONTEXT, h.deps),
    ).resolves.toBe("ok");
    expect(first.seen[2]?.endpointTag).toBe(HEALTHIEST.tag);
    expect(h.switches).toHaveLength(0);
    expect(h.trace).toContain(`persist_failed:${HEALTHIEST.tag}`);

    // Database recovers. The very next request settles the owed write — the
    // durable truth materialises instead of being lost.
    h.failPersist.value = false;
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);

    expect(h.switches).toEqual([
      {
        sessionId: "session-a",
        model: "deepseek/deepseek-v4-flash",
        previousEndpoint: PINNED_TAG,
        newEndpoint: HEALTHIEST.tag,
        reasonClass: "rate_limited_shared_pool",
      },
    ]);
  });

  it("keeps retrying the owed write across MULTIPLE failed attempts, never giving up", async () => {
    const h = harness();
    h.failPersist.value = true;
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);
    expect(h.switches).toHaveLength(0);
    expect(h.trace.filter((t) => t.startsWith("persist_failed")).length).toBe(3);

    h.failPersist.value = false;
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);
    expect(h.switches).toHaveLength(1);
  });

  it("an owed write survives an eviction sweep — the record is never dropped", async () => {
    // A dirty entry is exempt from eviction: dropping it would discard the very
    // fact we are trying to persist, and no read-through could recover it
    // because it was never written.
    const h = harness();
    h.failPersist.value = true;
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    for (let i = 0; i < MAX_TRACKED_SESSIONS + 50; i++) {
      await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), {
        sessionId: `filler-${i}`,
        missionRunId: null,
      }, h.deps);
    }

    h.failPersist.value = false;
    await sendWithEndpointFailover(failingAttempt(0).attempt, baseConfig(), CONTEXT, h.deps);
    expect(h.switches).toHaveLength(1);
    expect(h.switches[0]?.newEndpoint).toBe(HEALTHIEST.tag);
  });
});

// ── cost + context re-resolve (owner decision 7) ─────────────────

describe("applyEndpointToConfig — price and window follow the endpoint", () => {
  it("re-resolves price from the new endpoint", () => {
    const applied = applyEndpointToConfig(baseConfig(), HEALTHIEST);
    expect(applied.inputPricePerM).toBe(2);
    expect(applied.outputPricePerM).toBe(8);
    expect(applied.cachePricePerM).toBe(0.2);
  });

  it("clamps the context limit DOWN to a narrower endpoint window", () => {
    const applied = applyEndpointToConfig(baseConfig({ contextLimit: 256_000 }), HEALTHIEST);
    expect(applied.contextLimit).toBe(128_000);
  });

  it("never RAISES the limit above the operator's configured value", () => {
    const applied = applyEndpointToConfig(
      baseConfig({ contextLimit: 64_000 }),
      { ...HEALTHIEST, contextLength: 1_000_000 },
    );
    expect(applied.contextLimit).toBe(64_000);
  });

  it("keeps the model-level price when the catalogue reports none — null is not free", () => {
    const applied = applyEndpointToConfig(baseConfig(), {
      ...HEALTHIEST,
      inputPricePerM: null,
      outputPricePerM: null,
    });
    expect(applied.inputPricePerM).toBe(0.5);
    expect(applied.outputPricePerM).toBe(1.5);
  });

  it("a switched request bills at the NEW endpoint's price, not the pin's", async () => {
    const { attempt, seen } = failingAttempt(2);
    const h = harness();
    await sendWithEndpointFailover(attempt, baseConfig(), CONTEXT, h.deps);

    expect(seen[0]?.inputPricePerM).toBe(0.5);
    expect(seen[2]?.inputPricePerM).toBe(2);
    expect(seen[2]?.contextLimit).toBe(128_000);
  });
});

// ── the seam other subsystems call (owner decision 4) ────────────

describe("resolveSessionInferenceConfig — the compaction seam", () => {
  it("is a no-op before the session has switched", async () => {
    const h = harness();
    const config = baseConfig();
    await expect(
      resolveSessionInferenceConfig(config, "session-a", h.deps),
    ).resolves.toBe(config);
  });

  it("returns the session's CURRENT endpoint, with its price and window", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    const resolved = await resolveSessionInferenceConfig(baseConfig(), "session-a", h.deps);
    expect(resolved.endpointTag).toBe(HEALTHIEST.tag);
    expect(resolved.contextLimit).toBe(128_000);
    expect(resolved.inputPricePerM).toBe(2);
  });

  it("keeps honouring a switch whose endpoint has vanished from the catalogue", async () => {
    const h = harness();
    await sendWithEndpointFailover(failingAttempt(2).attempt, baseConfig(), CONTEXT, h.deps);

    // Catalogue no longer lists it — routing must NOT fall back to the pin that
    // just failed, but price/window stay at model level (logged, not silent).
    const resolved = await resolveSessionInferenceConfig(baseConfig(), "session-a", {
      ...h.deps,
      loadCandidates: async () => [],
    });
    expect(resolved.endpointTag).toBe(HEALTHIEST.tag);
    expect(resolved.contextLimit).toBe(256_000);
  });

  it("does nothing for a caller with no session", async () => {
    const h = harness();
    const config = baseConfig();
    await expect(resolveSessionInferenceConfig(config, null, h.deps)).resolves.toBe(config);
  });
});

describe("selectSwitchTarget", () => {
  it("never returns the endpoint we are already on", () => {
    expect(selectSwitchTarget([PINNED_CANDIDATE, HEALTHIEST], PINNED_TAG)?.tag).toBe(
      HEALTHIEST.tag,
    );
  });

  it("returns null when the only candidate is the current endpoint", () => {
    expect(selectSwitchTarget([PINNED_CANDIDATE], PINNED_TAG)).toBeNull();
  });
});
