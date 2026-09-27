/**
 * Kairos Phase 2B stream bounds, attacked through the REAL OpenRouter SDK.
 *
 * `stream-bounds.test.ts` pins the round guard with fake timers and typed
 * fakes. This suite instead points the production `OpenRouterProvider` (and so
 * the real `@openrouter/sdk` client: fetch, SSE parser, zod schemas, retry
 * loop) at a local HTTP server that stalls in scripted ways, and checks what
 * `runStreamingInference` / `executeTurn` return, how long they took, whether
 * the server saw its connection torn down, and that no timer or socket
 * outlives the round.
 *
 * The only substitution: the SDK client class is wrapped so its `serverURL`
 * is the local server. Everything else in the SDK is the installed code, and no
 * production module is patched.
 *
 * Real timers with small bounds (150-1500 ms). Upper bounds on elapsed time are
 * generous (bound + 700 ms); lower bounds are asserted only where they prove
 * the bound, not something earlier, ended the round.
 */

import { createHook } from "node:async_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type {
  InferenceConfig,
  ProviderMessage,
} from "../../../vex-agent/inference/types.js";
import type { InferenceAttemptRecord } from "../../../vex-agent/db/repos/runtime-timings.js";
import type { EndpointSwitchRecord } from "../../../vex-agent/db/repos/session-endpoint-switches.js";
import type { EngineContext } from "../../../vex-agent/engine/types/engine-context.js";
import {
  completionBody,
  contentChunk,
  errorBody,
  finishChunk,
  reasoningChunk,
  startSseChatServer,
  toolCallChunk,
  usageChunk,
  type ChatHandler,
  type SseChatServer,
} from "../../helpers/sse-chat-server.js";
import { requireValue } from "../../helpers/require-value.js";

// ── The one substitution: the SDK talks to the local server ──────────────

const sdkTarget = vi.hoisted(() => ({ url: "" }));

vi.mock("@openrouter/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openrouter/sdk")>();
  type Options = ConstructorParameters<typeof actual.OpenRouter>[0];
  class LocalOpenRouter extends actual.OpenRouter {
    constructor(options?: Options) {
      super({ ...options, serverURL: `${sdkTarget.url}/api/v1` });
    }
  }
  return { ...actual, OpenRouter: LocalOpenRouter };
});

// ── Quiet logger, captured so a test can see a fallback was never taken ──

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: loggerMock,
  logger: loggerMock,
  createChildLogger: () => loggerMock,
}));

// ── Persistence the round touches, captured (as in turn.test.ts) ─────────

const mockInsertInferenceAttempt = vi
  .fn<(record: InferenceAttemptRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertInferenceAttempt: (record: InferenceAttemptRecord) => mockInsertInferenceAttempt(record),
  insertTurnRunTiming: vi.fn(),
  insertToolDispatchTiming: vi.fn(),
  recordInBackground: (_label: string, write: () => Promise<void>) => {
    void write();
  },
}));

const mockRecordEndpointSwitch = vi
  .fn<(record: EndpointSwitchRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/session-endpoint-switches.js", () => ({
  recordEndpointSwitch: (record: EndpointSwitchRecord) => mockRecordEndpointSwitch(record),
  getLatestEndpointSwitch: async () => null,
  listEndpointSwitches: async () => [],
}));

const mockLogUsage = vi.fn();
vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: (...a: unknown[]) => mockLogUsage(...a),
}));
vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: vi.fn(),
  addEngineMessage: vi.fn(),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));
vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));
vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { runStreamingInference } = await import("../../../vex-agent/inference/stream-consumer.js");
const { createInferenceAttemptTimer } = await import(
  "../../../vex-agent/inference/attempt-timing.js"
);
const { executeTurn } = await import("../../../vex-agent/engine/core/turn.js");
const { resetAllSessionEndpointState } = await import(
  "../../../vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js"
);

// ── Fixtures ─────────────────────────────────────────────────────────────

const MESSAGES: ProviderMessage[] = [{ role: "user", content: "hi" }];

/** Slack on every elapsed-time upper bound: SDK setup, loopback, CI jitter. */
const SLACK_MS = 700;

type Bounds = Pick<
  InferenceConfig,
  | "firstChunkTimeoutMs"
  | "streamIdleTimeoutMs"
  | "reasoningOnlyTimeoutMs"
  | "inferenceRoundDeadlineMs"
>;

const NO_BOUNDS: Bounds = {
  firstChunkTimeoutMs: 0,
  streamIdleTimeoutMs: 0,
  reasoningOnlyTimeoutMs: 0,
  inferenceRoundDeadlineMs: 0,
};

function config(bounds: Bounds, extra: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "test/model",
    contextLimit: 128_000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
    ...bounds,
    ...extra,
  };
}

function engineContext(sessionId: string): EngineContext {
  return {
    sessionId,
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map<string, string>(),
  };
}

const TELEMETRY = { turnRunId: "run-live", iteration: 1, preInferenceMs: 0, promptStackMs: 0 };

// ── Timer leak detection ─────────────────────────────────────────────────
//
// Every `Timeout` created from the moment a test starts its server is
// recorded (async_hooks `init`) and forgotten once it is cleared or has fired
// (`destroy`). Whatever is still pending and ref'd after the round and the
// server teardown outlived the round. Scoped this way, and not by counting
// `process.getActiveResourcesInfo()`, the runner's own timers (the test
// timeout, which starts before the body) can neither hide a leak nor fake one.

const trackedTimers = new Map<number, unknown>();
let trackingTimers = false;
createHook({
  init(asyncId, type, _triggerAsyncId, resource) {
    if (trackingTimers && type === "Timeout") trackedTimers.set(asyncId, resource);
  },
  destroy(asyncId) {
    trackedTimers.delete(asyncId);
  },
}).enable();

function isPendingRefTimer(resource: unknown): boolean {
  if (typeof resource !== "object" || resource === null) return false;
  // Fired or cleared, with its async `destroy` hook not yet delivered.
  if (Reflect.get(resource, "_destroyed") === true) return false;
  const hasRef: unknown = Reflect.get(resource, "hasRef");
  return typeof hasRef === "function" && Reflect.apply(hasRef, resource, []) === true;
}

/** Ref'd timers created since the test's server started that are still pending. */
async function pendingTimers(): Promise<number> {
  // `destroy` hooks are emitted asynchronously; let them land.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return [...trackedTimers.values()].filter(isPendingRefTimer).length;
}

// ── Scripted server behaviours ───────────────────────────────────────────

const normalStream: ChatHandler = async (r) => {
  r.event(contentChunk("Hello"));
  r.event(contentChunk(", world"));
  r.event(finishChunk("stop"));
  r.event(usageChunk(10, 3));
  r.done();
};

let server: SseChatServer | null = null;

async function serve(handlers: readonly ChatHandler[]): Promise<SseChatServer> {
  trackedTimers.clear();
  trackingTimers = true;
  server = await startSseChatServer(handlers);
  sdkTarget.url = server.url;
  return server;
}

function newProvider(): InstanceType<typeof OpenRouterProvider> {
  return new OpenRouterProvider();
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; elapsed: number }> {
  const started = performance.now();
  const value = await work();
  return { value, elapsed: performance.now() - started };
}

/**
 * How the round left the wire: every exchange that finished normally ended
 * finished, every exchange the client had to abort ended aborted BY THE
 * CLIENT, no request socket is left open, and no ref'd timer outlives the
 * round. `abortedByClient[i]` is the expected ending of request `i`.
 *
 * Strict: the teardown no longer depends on undici's weakly held signal link
 * (a GC between the response head and the abort used to leave the exchange
 * open), because `openrouter/round-fetch.ts` cancels the body explicitly. The
 * "abort propagation after a GC" block below forces that GC deterministically.
 */
async function expectTeardown(
  s: SseChatServer,
  abortedByClient: readonly boolean[],
): Promise<void> {
  await s.waitForOutcomes(abortedByClient.length, 2_000);
  for (const outcome of s.outcomes) {
    expect(outcome.clientAborted).toBe(requireValue(abortedByClient[outcome.index]));
  }
  abortedByClient.forEach((aborted, index) => {
    if (!aborted) expect(s.outcomes.some((o) => o.index === index)).toBe(true);
  });
  expect(s.outcomes).toHaveLength(abortedByClient.length);
  await s.waitForSocketsClosed();
  expect(s.openSockets()).toBe(0);
  // At most one empty spare connection per aborted request (see the helper).
  expect(s.idleSpareSockets()).toBeLessThanOrEqual(abortedByClient.filter(Boolean).length);
  expect(await pendingTimers()).toBe(0);
}

describe("stream bounds against a stalling OpenRouter-compatible server (real SDK)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSessionEndpointState();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_") || key.startsWith("OPENROUTER_")) {
        delete process.env[key];
      }
    }
    process.env.OPENROUTER_API_KEY = "sk-or-local-test";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(async () => {
    trackingTimers = false;
    process.env = { ...originalEnv };
    if (server !== null) await server.close();
    server = null;
  });

  // (1) ──────────────────────────────────────────────────────────────────
  it("slow first byte (no response head) past the first-chunk bound → first_chunk", async () => {
    const s = await serve([
      async (r) => {
        if (!(await r.sleep(3_000))) return;
        await normalStream(r);
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 300, inferenceRoundDeadlineMs: 5_000,
      })),
    );

    expect(result.timedOut).toBe("first_chunk");
    expect(result.aborted).toBe(false);
    expect(result.response.content).toBe("");
    expect(result.response.toolCalls).toBeNull();
    expect(result.response.finishReason).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(300 + SLACK_MS);
    expect(s.requests.map((q) => q.stream)).toEqual([true]);
    await expectTeardown(s, [true]);
  });

  it("head sent at once but the first event is late → first_chunk", async () => {
    const s = await serve([
      async (r) => {
        r.sseHeaders();
        if (!(await r.sleep(3_000))) return;
        await normalStream(r);
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 300,
      })),
    );

    expect(result.timedOut).toBe("first_chunk");
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(300 + SLACK_MS);
    await expectTeardown(s, [true]);
  });

  // (2) ──────────────────────────────────────────────────────────────────
  it("heartbeat comments only never count as a first chunk → first_chunk", async () => {
    let heartbeats = 0;
    const s = await serve([
      async (r) => {
        while (!r.closed) {
          r.comment("OPENROUTER PROCESSING");
          heartbeats += 1;
          if (!(await r.sleep(40))) return;
        }
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 400, streamIdleTimeoutMs: 150,
      })),
    );

    // The heartbeats kept arriving well inside the idle bound, yet the round
    // is a first-chunk stall: they are SSE comments, never chunks.
    expect(heartbeats).toBeGreaterThanOrEqual(5);
    expect(result.timedOut).toBe("first_chunk");
    expect(result.response.content).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(390);
    expect(elapsed).toBeLessThan(400 + SLACK_MS);
    await expectTeardown(s, [true]);
  });

  it("whitespace and usage-only prefix chunks do not count as a first chunk either", async () => {
    const s = await serve([
      async (r) => {
        r.event(contentChunk("   "));
        r.event(usageChunk(5, 0));
        await r.hang();
      },
    ]);
    const { value: result } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 300, streamIdleTimeoutMs: 100,
      })),
    );

    // Not `idle`: the non-empty-stream gate held those chunks back, so the
    // guard never saw a first chunk and the idle bound was never armed.
    expect(result.timedOut).toBe("first_chunk");
    await expectTeardown(s, [true]);
  });

  // (3) ──────────────────────────────────────────────────────────────────
  it("content then silence → idle, the partial text returned, no tool calls", async () => {
    const s = await serve([
      async (r) => {
        r.event(contentChunk("The price of ETH"));
        if (!(await r.sleep(50))) return;
        r.event(contentChunk(" is"));
        await r.hang();
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 2_000, streamIdleTimeoutMs: 300,
        inferenceRoundDeadlineMs: 5_000,
      })),
    );

    expect(result.timedOut).toBe("idle");
    expect(result.aborted).toBe(false);
    expect(result.response.content).toBe("The price of ETH is");
    expect(result.response.toolCalls).toBeNull();
    expect(result.response.finishReason).toBeNull();
    expect(result.usageObserved).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(340);
    expect(elapsed).toBeLessThan(350 + SLACK_MS);
    await expectTeardown(s, [true]);
  });

  // (4) ──────────────────────────────────────────────────────────────────
  it("reasoning deltas forever → reasoning_only, even though chunks keep the idle bound fed", async () => {
    const s = await serve([
      async (r) => {
        let n = 0;
        while (!r.closed) {
          r.event(reasoningChunk(`step ${n} `));
          n += 1;
          if (!(await r.sleep(40))) return;
        }
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 2_000, streamIdleTimeoutMs: 200,
        reasoningOnlyTimeoutMs: 500, inferenceRoundDeadlineMs: 5_000,
      })),
    );

    expect(result.timedOut).toBe("reasoning_only");
    expect(result.response.content).toBe("");
    expect(result.response.toolCalls).toBeNull();
    expect(requireValue(result.response.reasoning)).toContain("step 0 ");
    expect(elapsed).toBeGreaterThanOrEqual(490);
    expect(elapsed).toBeLessThan(500 + SLACK_MS);
    await expectTeardown(s, [true]);
  });

  // (5) ──────────────────────────────────────────────────────────────────
  it("a tool call in flight then silence → idle, the call dropped (toolCalls null)", async () => {
    const s = await serve([
      async (r) => {
        r.event(contentChunk("Swapping now."));
        // Complete, parseable arguments: dropped anyway, because the provider
        // never finished the batch.
        r.event(toolCallChunk({ index: 0, id: "call-1", name: "swap", args: '{"amount":' }));
        r.event(toolCallChunk({ index: 0, args: '"1"}' }));
        await r.hang();
      },
    ]);
    const timing = createInferenceAttemptTimer();
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, streamIdleTimeoutMs: 300, inferenceRoundDeadlineMs: 5_000,
      }), { timing }),
    );

    expect(result.timedOut).toBe("idle");
    expect(result.response.toolCalls).toBeNull();
    expect(result.response.content).toBe("Swapping now.");
    expect(result.response.malformedToolCallCount).toBe(0);
    const snapshot = timing.snapshot();
    expect(snapshot.toolCallCount).toBe(1);
    expect(snapshot.validToolCallCount).toBe(0);
    expect(elapsed).toBeLessThan(300 + SLACK_MS);
    await expectTeardown(s, [true]);
  });

  // (6) ──────────────────────────────────────────────────────────────────
  it("503 forever: the 5xx retries all end at the round deadline, none after it", async () => {
    const s = await serve([
      async (r) => {
        r.json(503, errorBody(503, "overloaded"), { "retry-after-ms": "60" });
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 0, inferenceRoundDeadlineMs: 700,
      })),
    );

    expect(result.timedOut).toBe("round_deadline");
    expect(elapsed).toBeGreaterThanOrEqual(690);
    expect(elapsed).toBeLessThan(700 + SLACK_MS);
    const seenAtReturn = s.requests.length;
    // Retried in place (5xx is retried in the HTTP layer, below the
    // endpoint failover), every attempt a streaming one.
    expect(seenAtReturn).toBeGreaterThanOrEqual(3);
    expect(s.requests.every((q) => q.stream)).toBe(true);
    // Nothing is sent once the round is over.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.requests.length).toBe(seenAtReturn);
    await expectTeardown(s, s.requests.map(() => false));
  });

  it("503 twice then a stream: the 5xx retry runs inside the deadline and the round completes", async () => {
    const overloaded: ChatHandler = async (r) => {
      r.json(503, errorBody(503, "overloaded"), { "retry-after-ms": "50" });
    };
    const s = await serve([overloaded, overloaded, normalStream]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 1_000, inferenceRoundDeadlineMs: 1_500,
      })),
    );

    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("Hello, world");
    expect(s.requests).toHaveLength(3);
    expect(elapsed).toBeLessThan(1_500);
    await expectTeardown(s, [false, false, false]);
  });

  it("429 twice with a session: the failover backs off, switches endpoint (recorded) and completes inside the deadline", async () => {
    const limited: ChatHandler = async (r) => {
      r.json(429, errorBody(429, "rate limited"));
    };
    const s = await serve([limited, limited, normalStream]);
    const candidates = [
      { tag: "pinned/fp8", providerName: "Pinned", uptimePercent: 90, contextLength: null,
        inputPricePerM: null, outputPricePerM: null, cachePricePerM: null,
        cacheWritePricePerM: null, reasoningPricePerM: null },
      { tag: "sibling/fp8", providerName: "Sibling", uptimePercent: 99, contextLength: null,
        inputPricePerM: null, outputPricePerM: null, cachePricePerM: null,
        cacheWritePricePerM: null, reasoningPricePerM: null },
    ];
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, inferenceRoundDeadlineMs: 2_500,
      }, { endpointTag: "pinned/fp8", endpointCandidates: candidates }), {
        context: { sessionId: "session-429", missionRunId: null },
      }),
    );

    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("Hello, world");
    // One un-hinted 1 s backoff, then the switch IS the retry.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(2_500);
    expect(s.requests.map((q) => q.stream)).toEqual([true, true, true]);
    expect(mockRecordEndpointSwitch).toHaveBeenCalledTimes(1);
    expect(mockRecordEndpointSwitch.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-429",
      previousEndpoint: "pinned/fp8",
      newEndpoint: "sibling/fp8",
      reasonClass: "rate_limited_shared_pool",
    });
    const routedTo = (i: number): unknown =>
      requireValue(s.requests[i]).body.provider;
    expect(routedTo(0)).toMatchObject({ order: ["pinned/fp8"] });
    expect(routedTo(2)).toMatchObject({ order: ["sibling/fp8"] });
    await expectTeardown(s, [false, false, false]);
  });

  it("429 with no session: the failover retries in place and records no endpoint switch", async () => {
    const s = await serve([
      async (r) => r.json(429, errorBody(429, "rate limited")),
      normalStream,
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, inferenceRoundDeadlineMs: 2_000,
      }, { endpointTag: "pinned/fp8" })),
    );

    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("Hello, world");
    // One un-hinted 1 s backoff, well inside the 2 s round.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(2_000);
    expect(mockRecordEndpointSwitch).not.toHaveBeenCalled();
    expect(s.requests.map((q) => q.body.provider)).toEqual([
      expect.objectContaining({ order: ["pinned/fp8"] }),
      expect.objectContaining({ order: ["pinned/fp8"] }),
    ]);
    await expectTeardown(s, [false, false]);
  });

  it("429 forever: the round deadline cuts the failover's backoff sleep short", async () => {
    const s = await serve([
      async (r) => {
        r.json(429, errorBody(429, "rate limited"));
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, inferenceRoundDeadlineMs: 600,
      })),
    );

    expect(result.timedOut).toBe("round_deadline");
    expect(elapsed).toBeGreaterThanOrEqual(590);
    // The un-hinted backoff is 1 s; the round must not sit it out.
    expect(elapsed).toBeLessThan(600 + SLACK_MS);
    expect(s.requests).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(s.requests).toHaveLength(1);
    await expectTeardown(s, [false]);
  });

  // (7) ──────────────────────────────────────────────────────────────────
  it("hang before the first chunk: no buffered fallback is attempted", async () => {
    const s = await serve([
      async (r) => {
        r.sseHeaders();
        await r.hang();
      },
    ]);
    const timing = createInferenceAttemptTimer();
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 300, inferenceRoundDeadlineMs: 3_000,
      }), { timing }),
    );

    expect(result.timedOut).toBe("first_chunk");
    expect(elapsed).toBeLessThan(300 + SLACK_MS);
    // Give a (wrong) late fallback the chance to reach the server.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(s.requests.map((q) => q.stream)).toEqual([true]);
    expect(timing.snapshot().bufferedFallback).toBe(false);
    expect(
      loggerMock.warn.mock.calls.some(([event]) => event === "inference.stream.fallback"),
    ).toBe(false);
    await expectTeardown(s, [true]);
  });

  it("hang before the response head, round deadline first: still no buffered fallback", async () => {
    const s = await serve([async (r) => r.hang()]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, inferenceRoundDeadlineMs: 300,
      })),
    );

    expect(result.timedOut).toBe("round_deadline");
    expect(elapsed).toBeLessThan(300 + SLACK_MS);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(s.requests.map((q) => q.stream)).toEqual([true]);
    await expectTeardown(s, [true]);
  });

  // (8) ──────────────────────────────────────────────────────────────────
  it("a server that cannot stream: the buffered fallback answers within the same round", async () => {
    const s = await serve([
      // A `stream: true` request answered with a buffered JSON body.
      async (r) => {
        if (!(await r.sleep(100))) return;
        r.json(200, completionBody("unused"));
      },
      async (r) => r.json(200, completionBody("buffered answer")),
    ]);
    const timing = createInferenceAttemptTimer();
    const { value: result } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, firstChunkTimeoutMs: 2_000, inferenceRoundDeadlineMs: 3_000,
      }), { timing }),
    );

    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("buffered answer");
    expect(s.requests.map((q) => q.stream)).toEqual([true, false]);
    const snapshot = timing.snapshot();
    expect(snapshot.bufferedFallback).toBe(true);
    expect(snapshot.fallbackReason).toBe("threw_before_first_chunk");
    await expectTeardown(s, [false, false]);
  });

  // (8b) A provider verdict with an HTTP status is not a stream
  // incompatibility: exactly one request reaches the server, and the error
  // leaves with its status for the mission auto-retry classifier.
  it.each([
    ["400 bad request", 400, {}],
    ["401 unauthorized", 401, {}],
    // A hint past the longest wait the failover honours and no session to
    // switch: the failover gives up on the first answer (429 exhausted).
    ["429 exhausted", 429, { "retry-after": "3600" }],
  ] as const)("%s before the first chunk: no buffered fallback, one request", async (_label, status, headers) => {
    const s = await serve([async (r) => r.json(status, errorBody(status, "refused"), headers)]);
    const timing = createInferenceAttemptTimer();
    const thrown = await runStreamingInference(newProvider(), MESSAGES, [], config({
      ...NO_BOUNDS, firstChunkTimeoutMs: 2_000, inferenceRoundDeadlineMs: 3_000,
    }), { timing }).then(() => null, (err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    expect(Reflect.get(requireValue(thrown), "status")).toBe(status);
    // Give a (wrong) late fallback the chance to reach the server.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(s.requests.map((q) => q.stream)).toEqual([true]);
    expect(timing.snapshot().bufferedFallback).toBe(false);
    expect(
      loggerMock.warn.mock.calls.some(([event]) => event === "inference.stream.fallback"),
    ).toBe(false);
    await expectTeardown(s, [false]);
  });

  it("the buffered fallback gets only the REMAINING round budget, never a fresh one", async () => {
    const s = await serve([
      async (r) => {
        if (!(await r.sleep(500))) return;
        r.json(200, completionBody("unused"));
      },
      async (r) => r.hang(),
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        ...NO_BOUNDS, inferenceRoundDeadlineMs: 900,
      })),
    );

    expect(result.timedOut).toBe("round_deadline");
    expect(s.requests.map((q) => q.stream)).toEqual([true, false]);
    // 900 ms from the START of the round, not 500 + 900 from the fallback.
    expect(elapsed).toBeGreaterThanOrEqual(890);
    expect(elapsed).toBeLessThan(900 + SLACK_MS);
    await s.waitForOutcomes(2);
    const fallbackStartedAt = requireValue(s.requests[1]).receivedAt;
    const fallbackClosedAt = requireValue(s.outcomes.find((o) => o.index === 1)).closedAt;
    expect(fallbackClosedAt - fallbackStartedAt).toBeLessThan(900);
    await expectTeardown(s, [false, true]);
  });

  // (9) ──────────────────────────────────────────────────────────────────
  it("caller Stop mid-stream → aborted true, timedOut null", async () => {
    const s = await serve([
      async (r) => {
        while (!r.closed) {
          r.event(contentChunk("tick "));
          if (!(await r.sleep(40))) return;
        }
      },
    ]);
    const stop = new AbortController();
    const stopTimer = setTimeout(() => stop.abort(), 250);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        firstChunkTimeoutMs: 1_000, streamIdleTimeoutMs: 1_000,
        reasoningOnlyTimeoutMs: 1_000, inferenceRoundDeadlineMs: 5_000,
      }), { signal: stop.signal }),
    );
    clearTimeout(stopTimer);

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeNull();
    expect(result.response.content).toContain("tick ");
    expect(result.response.toolCalls).toBeNull();
    expect(elapsed).toBeLessThan(250 + SLACK_MS);
    await expectTeardown(s, [true]);
  });

  // (10) ─────────────────────────────────────────────────────────────────
  it("all bounds 0: a slow-but-healthy stream completes exactly as before", async () => {
    const s = await serve([
      async (r) => {
        if (!(await r.sleep(300))) return;
        r.event(reasoningChunk("thinking"));
        if (!(await r.sleep(300))) return;
        await normalStream(r);
      },
    ]);
    const { value: result } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config(NO_BOUNDS)),
    );

    expect(result).toMatchObject({ aborted: false, usageObserved: true, timedOut: null });
    expect(result.response).toMatchObject({
      content: "Hello, world",
      toolCalls: null,
      reasoning: "thinking",
      finishReason: "stop",
      generationId: "gen-local-1",
    });
    expect(result.response.usage).toMatchObject({ promptTokens: 10, completionTokens: 3 });
    await expectTeardown(s, [false]);
  });

  // (11) ─────────────────────────────────────────────────────────────────
  it("a normal fast stream under tight bounds completes with timedOut null and its tool call", async () => {
    const s = await serve([
      async (r) => {
        r.event(reasoningChunk("plan"));
        r.event(contentChunk("Checking."));
        r.event(toolCallChunk({ index: 0, id: "call-7", name: "balance_check", args: '{"chain":' }));
        r.event(toolCallChunk({ index: 0, args: '"base"}' }));
        r.event(finishChunk("tool_calls"));
        r.event(usageChunk(12, 4));
        r.done();
      },
    ]);
    const { value: result, elapsed } = await timed(() =>
      runStreamingInference(newProvider(), MESSAGES, [], config({
        firstChunkTimeoutMs: 1_000, streamIdleTimeoutMs: 400,
        reasoningOnlyTimeoutMs: 400, inferenceRoundDeadlineMs: 2_000,
      })),
    );

    expect(result.timedOut).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.response.content).toBe("Checking.");
    expect(result.response.toolCalls).toEqual([
      { id: "call-7", name: "balance_check", arguments: { chain: "base" } },
    ]);
    expect(result.response.finishReason).toBe("tool_calls");
    expect(elapsed).toBeLessThan(1_000);
    await expectTeardown(s, [false]);
  });
});

// ── Through executeTurn: the recorded attempt row ───────────────────────

describe("stream bounds through executeTurn (real SDK): attempt recorded as timeout", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSessionEndpointState();
    process.env.OPENROUTER_API_KEY = "sk-or-local-test";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(async () => {
    trackingTimers = false;
    process.env = { ...originalEnv };
    if (server !== null) await server.close();
    server = null;
  });

  const cases: ReadonlyArray<{
    readonly kind: "first_chunk" | "idle" | "reasoning_only" | "round_deadline";
    readonly handler: ChatHandler;
    readonly bounds: Bounds;
    readonly boundMs: number;
    readonly content: string;
  }> = [
    {
      kind: "first_chunk",
      handler: async (r) => {
        r.sseHeaders();
        while (!r.closed) {
          r.comment();
          if (!(await r.sleep(50))) return;
        }
      },
      bounds: { ...NO_BOUNDS, firstChunkTimeoutMs: 250 },
      boundMs: 250,
      content: "",
    },
    {
      kind: "idle",
      handler: async (r) => {
        r.event(contentChunk("partial"));
        await r.hang();
      },
      bounds: { ...NO_BOUNDS, streamIdleTimeoutMs: 250 },
      boundMs: 250,
      content: "partial",
    },
    {
      kind: "reasoning_only",
      handler: async (r) => {
        while (!r.closed) {
          r.event(reasoningChunk("hmm "));
          if (!(await r.sleep(40))) return;
        }
      },
      bounds: { ...NO_BOUNDS, streamIdleTimeoutMs: 200, reasoningOnlyTimeoutMs: 300 },
      boundMs: 300,
      content: "",
    },
    {
      kind: "round_deadline",
      handler: async (r) => {
        r.json(429, errorBody(429, "rate limited"));
      },
      bounds: { ...NO_BOUNDS, inferenceRoundDeadlineMs: 400 },
      boundMs: 400,
      content: "",
    },
  ];

  for (const c of cases) {
    it(`${c.kind}: returns timedOut, records outcome timeout / KairosStall:${c.kind}, logs no usage`, async () => {
      const s = await serve([c.handler]);
      const { value: result, elapsed } = await timed(() =>
        executeTurn(
          engineContext(`session-${c.kind}`), [], null, newProvider(), config(c.bounds), [],
          {}, undefined, undefined, TELEMETRY,
        ),
      );

      expect(result.timedOut).toBe(c.kind);
      expect(result.inferenceAborted).toBe(false);
      expect(result.toolCalls).toBeNull();
      expect(result.content).toBe(c.content);
      expect(elapsed).toBeLessThan(c.boundMs + SLACK_MS);
      expect(mockLogUsage).not.toHaveBeenCalled();
      expect(mockInsertInferenceAttempt).toHaveBeenCalledTimes(1);
      const row = requireValue(mockInsertInferenceAttempt.mock.calls[0]?.[0]);
      expect(row).toMatchObject({
        sessionId: `session-${c.kind}`,
        outcome: "timeout",
        errorClass: `KairosStall:${c.kind}`,
        finishReason: null,
        bufferedFallback: false,
      });
      await expectTeardown(s, s.requests.map(() => c.kind !== "round_deadline"));
    });
  }
});

// ── Abort propagation after a GC ──────────────────────────────────────
//
// Node's fetch (undici 6.22, Node 22.21) follows the caller's signal through
// internal `Request` objects it holds only weakly. Once the response head has
// arrived nothing keeps them alive, so a GC before the abort silently unlinks
// the signal from the connection. Reproduced without the SDK: plain `fetch` +
// `AbortController`, `global.gc()` after the head, then `abort()` → the body
// read never rejects and the server never sees the client leave.
//
// For this engine that meant a round a Kairos bound ended (or the user
// stopped) could leave its OpenRouter stream open and generating. Fixed by
// `openrouter/round-fetch.ts`, which reads every signal-carrying body through
// a reader held by a listener on the caller's signal and cancels it on abort,
// and by the round guard settling its race on a caller Stop. Each case below
// forces a GC at the one moment that matters.

function forceGc(): void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("gc is not exposed");
  Reflect.apply(gc, undefined, []);
}

/** Wait until the server has sent the head of request `index`, then GC. */
async function gcAfterHead(s: SseChatServer, index = 0): Promise<void> {
  for (let i = 0; i < 100 && s.requests.length <= index; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Let the SDK finish `_do` and hand back the stream, then collect.
  await new Promise((resolve) => setTimeout(resolve, 100));
  forceGc();
  await new Promise((resolve) => setTimeout(resolve, 20));
  forceGc();
}

describe("abort propagation after a GC (real SDK)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSessionEndpointState();
    process.env.OPENROUTER_API_KEY = "sk-or-local-test";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(async () => {
    trackingTimers = false;
    process.env = { ...originalEnv };
    if (server !== null) await server.close();
    server = null;
  });

  it("control: without a GC, a first-chunk stall after the head does tear the connection down", async () => {
    const s = await serve([
      async (r) => {
        r.sseHeaders();
        await r.hang();
      },
    ]);
    const result = await runStreamingInference(newProvider(), MESSAGES, [], config({
      ...NO_BOUNDS, firstChunkTimeoutMs: 150,
    }));
    expect(result.timedOut).toBe("first_chunk");
    // Tight window: a GC is unlikely to land inside 150 ms of a fresh round.
    await s.waitForOutcomes(1, 1_500);
    expect(s.outcomes.map((o) => o.clientAborted)).toEqual([true]);
  });

  it("a first-chunk stall after the head tears the connection down even after a GC", async () => {
    const s = await serve([
      async (r) => {
        r.sseHeaders();
        await r.hang();
      },
    ]);
    const round = runStreamingInference(newProvider(), MESSAGES, [], config({
      ...NO_BOUNDS, firstChunkTimeoutMs: 500,
    }));
    await gcAfterHead(s);
    const result = await round;

    // The round itself is fine: the guard's race ended it on time.
    expect(result.timedOut).toBe("first_chunk");
    // The connection is not: the server never sees the client leave.
    await s.waitForOutcomes(1, 700);
    expect(s.outcomes.map((o) => o.clientAborted)).toEqual([true]);
  });

  it("an idle stall mid-answer tears the connection down even after a GC", async () => {
    const s = await serve([
      async (r) => {
        r.event(contentChunk("partial"));
        await r.hang();
      },
    ]);
    const round = runStreamingInference(newProvider(), MESSAGES, [], config({
      ...NO_BOUNDS, streamIdleTimeoutMs: 500,
    }));
    await gcAfterHead(s);
    const result = await round;

    expect(result.timedOut).toBe("idle");
    expect(result.response.content).toBe("partial");
    await s.waitForOutcomes(1, 700);
    expect(s.outcomes.map((o) => o.clientAborted)).toEqual([true]);
  });

  it("a Stop during a silent stretch ends the round even after a GC", async () => {
    const s = await serve([
      async (r) => {
        r.event(contentChunk("partial"));
        await r.hang();
      },
    ]);
    const stop = new AbortController();
    const round = runStreamingInference(newProvider(), MESSAGES, [], config({
      ...NO_BOUNDS, streamIdleTimeoutMs: 400, inferenceRoundDeadlineMs: 1_000,
    }), { signal: stop.signal });
    await gcAfterHead(s);
    stop.abort();

    // After a Stop no bound may fire ("a Stop that already landed wins"), so
    // the round must not depend on the SDK read rejecting (the link the GC
    // just broke): the guard's `race` settles on the caller's signal itself.
    const TIMED_OUT = Symbol("round still running");
    const outcome = await Promise.race([
      round,
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), 2_000)),
    ]);
    // The Stop also reaches the wire: the server sees the client leave.
    const leftOnStop = await s.waitForOutcomes(1, 700).then(
      () => s.outcomes.map((o) => o.clientAborted),
      () => null,
    );
    // Let a hung round go once the verdict is in.
    await s.close();
    server = null;
    expect(outcome).not.toBe(TIMED_OUT);
    if (outcome !== TIMED_OUT) {
      expect(outcome.aborted).toBe(true);
      expect(outcome.timedOut).toBeNull();
    }
    expect(leftOnStop).toEqual([true]);
  });
});

describe("SDK 5xx retry sleep vs the round (real SDK)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = "sk-or-local-test";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(async () => {
    trackingTimers = false;
    process.env = { ...originalEnv };
    if (server !== null) await server.close();
    server = null;
  });

  // The SDK's own 5xx retry sleeps with a plain `setTimeout` that ignores the
  // request signal (`@openrouter/sdk/esm/lib/retries.js`, `delay`), so its
  // sleep (up to `maxInterval`, 15 s) used to outlive the round. A
  // signal-carrying send now switches the SDK retry off and runs the same
  // policy in `openrouter/round-fetch.ts`, whose wait the signal cancels.
  it("503 with no retry hint: no SDK retry sleep outlives the round", async () => {
    const s = await serve([async (r) => r.json(503, errorBody(503, "overloaded"))]);
    const result = await runStreamingInference(newProvider(), MESSAGES, [], config({
      ...NO_BOUNDS, inferenceRoundDeadlineMs: 300,
    }));
    expect(result.timedOut).toBe("round_deadline");
    await s.waitForOutcomes(s.requests.length);
    expect(await pendingTimers()).toBe(0);
  });
});
