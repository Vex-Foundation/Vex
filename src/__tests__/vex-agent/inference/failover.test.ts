/**
 * FailoverProvider — bounded retry → provider failover → recoverable park.
 *
 * Behavioural contract under test:
 *  - transient error retries the SAME provider, then succeeds;
 *  - fatal (auth/4xx) fails fast — no retry, no failover;
 *  - primary exhausting its transient budget fails over to the fallback;
 *  - every provider failing throws a BOUNDED, RECOVERABLE error (no crash);
 *  - a single-provider stack behaves exactly as the bare provider did;
 *  - a delegated call targets the ACTIVE provider's OWN model (P1 regression).
 */

import { describe, it, expect, vi } from "vitest";

import {
  FailoverProvider,
  AllProvidersFailedError,
} from "@vex-agent/inference/failover.js";
import { classifyMissionRunError } from "@vex-agent/engine/core/runner/mission-error-classifier.js";
import type {
  InferenceProvider,
  InferenceConfig,
  InferenceResponse,
  InferenceUsage,
  ProviderBalance,
  RequestCost,
  StreamChunk,
} from "@vex-agent/inference/types.js";

// ── Fixtures ─────────────────────────────────────────────────────

const USAGE: InferenceUsage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

function configFor(model: string): InferenceConfig {
  return {
    provider: "openrouter",
    model,
    contextLimit: 1000,
    maxOutputTokens: 100,
    inputPricePerM: 1,
    outputPricePerM: 1,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
  };
}

/** Error carrying a lean `status` own-property, like the OpenRouter normalizer attaches. */
function httpError(status: number, message = `request returned ${status}`): Error {
  const err = new Error(message);
  Object.defineProperty(err, "status", { value: status, enumerable: false });
  return err;
}

interface StubOptions {
  readonly id: string;
  readonly model: string;
  /** Queue of behaviours, consumed per call; the LAST entry repeats. */
  readonly script: ReadonlyArray<Error | "ok">;
}

/**
 * Minimal InferenceProvider stub. Records the `config.model` it was invoked
 * with so the model-retargeting regression can assert on it.
 */
class StubProvider implements InferenceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;
  readonly seenModels: string[] = [];
  calls = 0;

  private readonly script: ReadonlyArray<Error | "ok">;

  constructor(opts: StubOptions) {
    this.id = opts.id;
    this.displayName = opts.id;
    this.model = opts.model;
    this.script = opts.script;
  }

  private next(): Error | "ok" {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    return step ?? "ok";
  }

  async loadConfig(): Promise<InferenceConfig | null> {
    return configFor(this.model);
  }

  async chatCompletion(
    _messages: never[],
    _tools: never[],
    config: InferenceConfig,
  ): Promise<InferenceResponse> {
    this.seenModels.push(config.model);
    const step = this.next();
    if (step !== "ok") throw step;
    return { content: this.id, toolCalls: null, usage: USAGE };
  }

  async chatCompletionSimple(
    _messages: never[],
    config: InferenceConfig,
  ): Promise<{ content: string; usage: InferenceUsage }> {
    this.seenModels.push(config.model);
    const step = this.next();
    if (step !== "ok") throw step;
    return { content: this.id, usage: USAGE };
  }

  async *chatCompletionStream(): AsyncGenerator<StreamChunk> {
    yield { type: "done" };
  }

  async getBalance(): Promise<ProviderBalance | null> {
    return null;
  }

  calculateCost(): RequestCost {
    return {
      totalCost: 0,
      currency: "USD",
      breakdown: {
        promptCost: 0,
        completionCost: 0,
        cachedSavings: 0,
        reasoningCost: 0,
      },
    };
  }
}

/** Instant-backoff stack so tests never wait on real timers. */
function stack(providers: InferenceProvider[]): FailoverProvider {
  return new FailoverProvider(providers, {
    maxRetriesPerProvider: 2,
    sleep: async () => undefined,
    jitter: false,
  });
}

const NO_MESSAGES = [] as never[];
const NO_TOOLS = [] as never[];

// ── Tests ────────────────────────────────────────────────────────

describe("FailoverProvider", () => {
  it("retries the same provider on a transient error, then succeeds", async () => {
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(429), "ok"],
    });
    const failover = stack([primary]);

    const res = await failover.chatCompletion(
      NO_MESSAGES,
      NO_TOOLS,
      configFor("vendor/primary"),
    );

    expect(res.content).toBe("primary");
    expect(primary.calls).toBe(2);
  });

  it("fails fast on a fatal auth error — no retry, no failover", async () => {
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(401)],
    });
    const fallback = new StubProvider({
      id: "fallback",
      model: "vendor/fallback",
      script: ["ok"],
    });
    const failover = stack([primary, fallback]);

    await expect(
      failover.chatCompletion(NO_MESSAGES, NO_TOOLS, configFor("vendor/primary")),
    ).rejects.toThrow(/401/);

    // One attempt only, and the fallback was never consulted: a bad key fails
    // identically everywhere and must reach the operator.
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("fails over to the fallback once the primary exhausts its retries", async () => {
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(429)],
    });
    const fallback = new StubProvider({
      id: "fallback",
      model: "vendor/fallback",
      script: ["ok"],
    });
    const failover = stack([primary, fallback]);

    const res = await failover.chatCompletion(
      NO_MESSAGES,
      NO_TOOLS,
      configFor("vendor/primary"),
    );

    expect(res.content).toBe("fallback");
    expect(primary.calls).toBe(3); // initial + 2 retries
    expect(fallback.calls).toBe(1);
  });

  it("delegates to the fallback using the FALLBACK's own model, not the primary's", async () => {
    // P1 regression: the engine builds `config` from the PRIMARY, so a naive
    // delegation invokes the fallback provider with the primary's model id.
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(503)],
    });
    const fallback = new StubProvider({
      id: "fallback",
      model: "vendor/fallback",
      script: ["ok"],
    });
    const failover = stack([primary, fallback]);

    await failover.chatCompletion(
      NO_MESSAGES,
      NO_TOOLS,
      configFor("vendor/primary"),
    );

    expect(primary.seenModels).toEqual([
      "vendor/primary",
      "vendor/primary",
      "vendor/primary",
    ]);
    expect(fallback.seenModels).toEqual(["vendor/fallback"]);
  });

  it("preserves caller-owned per-turn config fields when retargeting the model", async () => {
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(500)],
    });
    const fallback = new StubProvider({
      id: "fallback",
      model: "vendor/fallback",
      script: ["ok"],
    });
    const failover = stack([primary, fallback]);

    const seen: InferenceConfig[] = [];
    vi.spyOn(fallback, "chatCompletionSimple").mockImplementation(
      async (_m, config) => {
        seen.push(config);
        return { content: "fallback", usage: USAGE };
      },
    );

    const turnConfig: InferenceConfig = {
      ...configFor("vendor/primary"),
      reasoningEffort: "high",
      temperature: 0.42,
    };
    await failover.chatCompletionSimple(NO_MESSAGES, turnConfig);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe("vendor/fallback");
    expect(seen[0]?.reasoningEffort).toBe("high");
    expect(seen[0]?.temperature).toBe(0.42);
    // Caller's config object must not be mutated.
    expect(turnConfig.model).toBe("vendor/primary");
  });

  it("throws a bounded, RECOVERABLE error when every provider fails", async () => {
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(429)],
    });
    const fallback = new StubProvider({
      id: "fallback",
      model: "vendor/fallback",
      script: [httpError(503)],
    });
    const failover = stack([primary, fallback]);

    const caught = await failover
      .chatCompletion(NO_MESSAGES, NO_TOOLS, configFor("vendor/primary"))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(caught).toBeInstanceOf(AllProvidersFailedError);

    // Bounded by construction: providers × (1 + maxRetries) = 2 × 3.
    expect(primary.calls).toBe(3);
    expect(fallback.calls).toBe(3);

    // The mission layer must still treat this as recoverable, so the run parks
    // with an auto-retry budget instead of dying.
    expect(classifyMissionRunError(caught)).toBe("transient");
  });

  it("prefers the primary again on the next call (stateless between calls)", async () => {
    const primary = new StubProvider({
      id: "primary",
      model: "vendor/primary",
      script: [httpError(429), httpError(429), httpError(429), "ok"],
    });
    const fallback = new StubProvider({
      id: "fallback",
      model: "vendor/fallback",
      script: ["ok"],
    });
    const failover = stack([primary, fallback]);

    const first = await failover.chatCompletion(
      NO_MESSAGES,
      NO_TOOLS,
      configFor("vendor/primary"),
    );
    expect(first.content).toBe("fallback");

    // Primary has recovered — the next call must go back to it, not stick.
    const second = await failover.chatCompletion(
      NO_MESSAGES,
      NO_TOOLS,
      configFor("vendor/primary"),
    );
    expect(second.content).toBe("primary");
    expect(fallback.calls).toBe(1);
  });

  describe("single-provider stack (backward compatibility)", () => {
    it("surfaces the provider's own error unchanged — never AllProvidersFailedError", async () => {
      const only = new StubProvider({
        id: "primary",
        model: "vendor/primary",
        script: [httpError(429, "rate limited")],
      });
      const failover = stack([only]);

      const caught = await failover
        .chatCompletion(NO_MESSAGES, NO_TOOLS, configFor("vendor/primary"))
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(caught).not.toBeInstanceOf(AllProvidersFailedError);
      expect((caught as Error).message).toBe("rate limited");
      // Still classified transient, exactly as before this change.
      expect(classifyMissionRunError(caught)).toBe("transient");
    });

    it("never rewrites the model and reports the primary's identity", async () => {
      const only = new StubProvider({
        id: "primary",
        model: "vendor/primary",
        script: ["ok"],
      });
      const failover = stack([only]);

      await failover.chatCompletion(
        NO_MESSAGES,
        NO_TOOLS,
        configFor("vendor/primary"),
      );

      expect(only.seenModels).toEqual(["vendor/primary"]);
      expect(failover.id).toBe("primary");
      expect(failover.displayName).toBe("primary");
      expect(failover.size).toBe(1);
    });
  });

  it("rejects an empty provider list", () => {
    expect(() => new FailoverProvider([])).toThrow(/at least one provider/i);
  });
});
