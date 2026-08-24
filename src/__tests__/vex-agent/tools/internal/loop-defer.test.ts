/**
 * Unit tests for the `LoopDefer` handler — Zod validation, defense-in-depth
 * against visibility bypasses, and registry visibility gating. DB is mocked
 * (no testcontainers); claim of the enqueue contract is exercised in
 * `loop-wake.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestContext } from "../_test-context.js";
import { registerWakeWatchEvaluator } from "@vex-agent/engine/wake/watch-registry.js";

// ── Mocks ─────────────────────────────────────────────────────

const mockEnqueue = vi.fn();
const mockCancelForSession = vi.fn();
const mockClaimDue = vi.fn();
const mockGetPendingForSession = vi.fn();
const mockEnqueueSessionScopedWake = vi.fn();
const mockFindActivityByProviderOrderId = vi.fn();

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  cancelForSession: (...args: unknown[]) => mockCancelForSession(...args),
  claimDue: (...args: unknown[]) => mockClaimDue(...args),
  getPendingForSession: (...args: unknown[]) => mockGetPendingForSession(...args),
}));

// The agent-session park goes through the shared session-scoped primitive
// (gate + INSERT in ONE transaction under the session control lock). Mocked
// here because that transaction needs a real pool; its own contract is covered
// by the runtime-continuation suite.
vi.mock("@vex-agent/engine/core/runner/runtime-continuation.js", () => ({
  enqueueSessionScopedWake: (...args: unknown[]) => mockEnqueueSessionScopedWake(...args),
}));

vi.mock("@vex-agent/db/repos/agent-activity/watch-reads.js", () => ({
  findActivityByProviderOrderId: (...args: unknown[]) =>
    mockFindActivityByProviderOrderId(...args),
}));

// Stub DB client — handler doesn't touch it, but import chain via types.ts
// would try to resolve a real pool without this.
vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  queryOneWith: vi.fn().mockResolvedValue(null),
  getPool: () => ({ connect: vi.fn() }),
}));

const { handleLoopDefer } = await import(
  "../../../../vex-agent/tools/internal/loop-defer.js"
);

const { getOpenAITools, defaultVisibilityContext } = await import(
  "../../../../vex-agent/tools/registry.js"
);

registerWakeWatchEvaluator({
  type: "test_wake",
  validate: async (condition) => condition,
  isTriggered: () => false,
});

// ── Fixtures ───────────────────────────────────────────────────

function ctxMissionActive() {
  return makeTestContext({
    sessionId: "session-mission-1",
    sessionPermission: "restricted",
    sessionKind: "mission",
    missionRunId: "run-abc",
  });
}

function enqueueReturn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wake-uuid-xyz",
    sessionId: "session-mission-1",
    missionRunId: "run-abc",
    dueAt: "2026-04-20T11:00:00.000Z",
    status: "pending",
    reason: "waiting for finality",
    payload: null,
    createdAt: "2026-04-20T10:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    ...overrides,
  };
}

function ctxAgentFull() {
  return makeTestContext({
    sessionId: "session-agent-1",
    sessionPermission: "full",
    sessionKind: "agent",
    missionRunId: null,
  });
}

beforeEach(() => {
  mockEnqueue.mockReset();
  mockEnqueue.mockResolvedValue(enqueueReturn());
  mockEnqueueSessionScopedWake.mockReset();
  mockEnqueueSessionScopedWake.mockResolvedValue({
    kind: "decided",
    row: enqueueReturn({ sessionId: "session-agent-1", missionRunId: null }),
  });
  mockFindActivityByProviderOrderId.mockReset();
  mockFindActivityByProviderOrderId.mockResolvedValue({ id: 4242, status: "pending" });
  vi.useRealTimers();
});

// ── Zod validation ─────────────────────────────────────────────

describe("LoopDefer — argument validation", () => {
  it("rejects missing reason", async () => {
    const result = await handleLoopDefer({ after_ms: 10_000 }, ctxMissionActive());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/reason/i);
  });

  it("rejects empty reason", async () => {
    const result = await handleLoopDefer(
      { after_ms: 10_000, reason: "" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/reason/i);
  });

  it("rejects reason over 500 chars", async () => {
    const result = await handleLoopDefer(
      { after_ms: 10_000, reason: "x".repeat(501) },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/500/);
  });

  it("rejects when neither after_ms nor wake_at is provided", async () => {
    const result = await handleLoopDefer({ reason: "waiting" }, ctxMissionActive());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/exactly one/i);
  });

  it("rejects when both after_ms and wake_at are provided", async () => {
    const result = await handleLoopDefer(
      { after_ms: 10_000, wake_at: "2026-04-20T11:00:00Z", reason: "waiting" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/exactly one/i);
  });

  it("rejects after_ms below 1s", async () => {
    const result = await handleLoopDefer(
      { after_ms: 500, reason: "too short" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/1000/);
  });

  it("rejects after_ms over 24h", async () => {
    const result = await handleLoopDefer(
      { after_ms: 86_400_001, reason: "too long" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-integer after_ms", async () => {
    const result = await handleLoopDefer(
      { after_ms: 5000.5, reason: "fractional" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
  });

  it("rejects invalid ISO8601 wake_at", async () => {
    const result = await handleLoopDefer(
      { wake_at: "not-a-date", reason: "bad date" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
  });

  it("rejects wake_at in the past", async () => {
    const result = await handleLoopDefer(
      { wake_at: "2020-01-01T00:00:00Z", reason: "time travel" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/future/i);
  });
});

// ── Defense-in-depth (runtime context) ─────────────────────────

describe("LoopDefer — defense-in-depth", () => {
  it("rejects a RESTRICTED agent session (a human is in the loop there)", async () => {
    const ctx = makeTestContext({
      sessionKind: "agent",
      sessionPermission: "restricted",
      missionRunId: null,
    });
    const result = await handleLoopDefer(
      { after_ms: 10_000, reason: "try" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects mission sessionKind without active missionRunId (setup)", async () => {
    const ctx = makeTestContext({
      sessionKind: "mission",
      missionRunId: null,
    });
    const result = await handleLoopDefer(
      { after_ms: 10_000, reason: "try" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects active mission defer reasons that wait for mission activation", async () => {
    const result = await handleLoopDefer(
      { after_ms: 10_000, reason: "Waiting for user to type /mission start in shell" },
      ctxMissionActive(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("mission run is already active");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

// ── Happy path ─────────────────────────────────────────────────

describe("LoopDefer — happy path", () => {
  it("enqueues for mission active run and returns engineSignal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const result = await handleLoopDefer(
      { after_ms: 60_000, reason: "waiting for finality" },
      ctxMissionActive(),
    );

    expect(result.success).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [input] = mockEnqueue.mock.calls[0];
    expect(input).toMatchObject({
      sessionId: "session-mission-1",
      missionRunId: "run-abc",
      reason: "waiting for finality",
      payload: null,
    });
    // after_ms=60s → dueAt = now + 60s.
    expect((input.dueAt as Date).toISOString()).toBe("2026-04-20T10:01:00.000Z");

    expect(result.engineSignal?.type).toBe("defer_until");
    expect(result.engineSignal?.dueAt).toBe("2026-04-20T11:00:00.000Z");
    expect(result.data?.defer_id).toBe("wake-uuid-xyz");
  });

  it("soft-fails when a pending wake already exists (enqueue returns null)", async () => {
    mockEnqueue.mockResolvedValueOnce(null);
    const result = await handleLoopDefer(
      { after_ms: 60_000, reason: "already queued" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending wake already exists/i);
  });

  it("persists registered generic watch conditions in the same enqueue", async () => {
    const result = await handleLoopDefer(
      {
        after_ms: 60_000,
        reason: "wait for test condition",
        watch: [{ type: "test_wake", key: "value" }],
      },
      ctxMissionActive(),
    );

    expect(result.success).toBe(true);
    const [input] = mockEnqueue.mock.calls[0];
    expect(input.payload).toMatchObject({
      watchVersion: 1,
      conditions: [{ type: "test_wake", key: "value" }],
    });
    expect(typeof input.payload.watchId).toBe("string");
  });

  it("rejects more than four generic watch conditions before enqueue", async () => {
    const result = await handleLoopDefer(
      {
        after_ms: 60_000,
        reason: "too many conditions",
        watch: Array.from({ length: 5 }, () => ({ type: "test_wake" })),
      },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/at most 4/i);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

// ── Full-Autonomous agent sessions (owner decree 2026-08-03) ───

describe("LoopDefer — Full-Autonomous agent session", () => {
  it("parks a full-permission agent session with missionRunId null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));

    const result = await handleLoopDefer(
      { after_ms: 300_000, reason: "bridge base→arbitrum ~5 min; on wake call BridgeStatus" },
      ctxAgentFull(),
    );

    expect(result.success).toBe(true);
    // The mission-shaped enqueue must NOT be used: it bypasses the session
    // control lock the agent shape depends on.
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockEnqueueSessionScopedWake).toHaveBeenCalledTimes(1);
    const [input] = mockEnqueueSessionScopedWake.mock.calls[0];
    expect(input.sessionId).toBe("session-agent-1");
    expect(input.dueAt.toISOString()).toBe("2026-04-20T10:05:00.000Z");
    expect(result.engineSignal?.type).toBe("defer_until");
  });

  it("refuses without scheduling when the operator already stopped the session", async () => {
    mockEnqueueSessionScopedWake.mockResolvedValueOnce({ kind: "stopped" });
    const result = await handleLoopDefer(
      { after_ms: 60_000, reason: "waiting" },
      ctxAgentFull(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/stopped by the operator/i);
    expect(result.engineSignal).toBeUndefined();
  });
});

// ── Wait bounds and units ──────────────────────────────────────

describe("LoopDefer — wake time bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:00.000Z"));
  });

  it("accepts a wake_at exactly at the 24h ceiling", async () => {
    const result = await handleLoopDefer(
      { wake_at: "2026-04-21T10:00:00.000Z", reason: "24h out" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(true);
  });

  // The defect this closes: `after_ms` capped at 24 h while `wake_at` had NO
  // upper bound, so the same wait was refused one way and accepted the other,
  // and a model could schedule itself years into the future.
  it("rejects a wake_at beyond the same 24h ceiling as after_ms", async () => {
    const result = await handleLoopDefer(
      { wake_at: "2031-04-20T10:00:00Z", reason: "five years out" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/24h/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a wake_at less than 1s away, matching the after_ms floor", async () => {
    const result = await handleLoopDefer(
      { wake_at: "2026-04-20T10:00:00.500Z", reason: "half a second" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/1000 ms/);
  });

  it("rejects a wake_at with no timezone designator (never interpreted as local time)", async () => {
    const result = await handleLoopDefer(
      { wake_at: "2026-04-20T12:00:00", reason: "local time" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/ISO-8601 UTC/);
  });

  it("treats wake_at as UTC — an offset form resolves to the same instant", async () => {
    const result = await handleLoopDefer(
      { wake_at: "2026-04-20T12:00:00.000Z", reason: "utc" },
      ctxMissionActive(),
    );
    expect(result.success).toBe(true);
    const [input] = mockEnqueue.mock.calls[0];
    expect((input.dueAt as Date).toISOString()).toBe("2026-04-20T12:00:00.000Z");
  });
});

// ── Watch (bridge_order_status) ────────────────────────────────

describe("LoopDefer — watch never kills the defer", () => {
  // THE regression this suite exists for: an unsupported watch type used to
  // fail the whole call, so the run did NOT park and the agent stayed in its
  // loop — the exact "unlimited thoughts" pathology LoopDefer exists to stop.
  // Pin updated 2026-08-10: `token_price` is now a REGISTERED type, so it no
  // longer demonstrates the unknown-type path. The pathology this test guards
  // is unchanged, only the type used to provoke it. The token_price condition's
  // own rejections live in `engine/wake/token-price-watch.test.ts`.
  it("still parks on the timer when the watch type is unknown, naming what IS supported", async () => {
    const result = await handleLoopDefer(
      {
        after_ms: 60_000,
        reason: "waiting",
        watch: [{ type: "token_liquidity", token: "ETH" }],
      },
      ctxMissionActive(),
    );

    expect(result.success).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(result.engineSignal?.type).toBe("defer_until");
    expect(result.output).toContain("token_liquidity");
    expect(result.output).toContain("bridge_order_status");
    expect(result.output).toContain("token_price");
    expect(mockEnqueue.mock.calls[0][0].payload).toBeNull();
    expect(result.data?.watch_rejected).toHaveLength(1);
  });

  it("arms a bridge_order_status watch, resolving orderId to the activity row id", async () => {
    const result = await handleLoopDefer(
      {
        after_ms: 300_000,
        reason: "bridge fill",
        watch: [{ type: "bridge_order_status", orderId: "order-abc" }],
      },
      ctxMissionActive(),
    );

    expect(result.success).toBe(true);
    expect(mockFindActivityByProviderOrderId).toHaveBeenCalledWith("order-abc");
    const [input] = mockEnqueue.mock.calls[0];
    expect(input.payload.conditions).toEqual([
      { type: "bridge_order_status", orderId: "order-abc", activityId: 4242 },
    ]);
    expect(result.data?.watch_rejected).toEqual([]);
  });

  it("rejects an unknown orderId by name without failing the defer", async () => {
    mockFindActivityByProviderOrderId.mockResolvedValueOnce(null);
    const result = await handleLoopDefer(
      {
        after_ms: 60_000,
        reason: "bridge fill",
        watch: [{ type: "bridge_order_status", orderId: "nope" }],
      },
      ctxMissionActive(),
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/no recorded bridge has orderId "nope"/);
    expect(mockEnqueue.mock.calls[0][0].payload).toBeNull();
  });

  it("rejects an already-settled order by name without failing the defer", async () => {
    mockFindActivityByProviderOrderId.mockResolvedValueOnce({ id: 7, status: "confirmed" });
    const result = await handleLoopDefer(
      {
        after_ms: 60_000,
        reason: "bridge fill",
        watch: [{ type: "bridge_order_status", orderId: "order-done" }],
      },
      ctxMissionActive(),
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/already reached status "confirmed"/);
  });

  // A condition with no `type` at all used to be a Zod ARGUMENT error, which
  // failed the call. It is now a named watch rejection, so the park survives a
  // malformed condition exactly as it survives an unsupported one.
  it("still parks when a watch condition has no type", async () => {
    const result = await handleLoopDefer(
      { after_ms: 60_000, reason: "waiting", watch: [{ orderId: "order-abc" }] },
      ctxMissionActive(),
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/needs a "type" string/);
    expect(result.output).toContain("bridge_order_status");
  });

  it("keeps the valid conditions when only some are unarmable", async () => {
    const result = await handleLoopDefer(
      {
        after_ms: 60_000,
        reason: "mixed",
        watch: [
          { type: "bridge_order_status", orderId: "order-abc" },
          { type: "nonsense" },
        ],
      },
      ctxMissionActive(),
    );
    expect(result.success).toBe(true);
    const [input] = mockEnqueue.mock.calls[0];
    expect(input.payload.conditions).toHaveLength(1);
    expect(result.data?.watch_rejected).toHaveLength(1);
  });
});

// ── Registry visibility ────────────────────────────────────────

describe("LoopDefer — visibility", () => {
  it("is visible in a mission active run (restricted)", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: true,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("LoopDefer");
  });

  it("is visible in a mission active run (full)", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "full",
      sessionKind: "mission",
      missionRunActive: true,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("LoopDefer");
  });

  it("is VISIBLE in a Full-Autonomous agent session", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      sessionKind: "agent",
      permission: "full",
      missionRunActive: false,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("LoopDefer");
  });

  it("is hidden in a restricted agent session", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      sessionKind: "agent",
      permission: "restricted",
      missionRunActive: false,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("LoopDefer");
  });

  it("survives the pressure barrier — the loop-stopping tool is safe_at_barrier", () => {
    for (const band of ["barrier", "critical"] as const) {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: band,
      }));
      expect(tools.map((t) => t.function.name)).toContain("LoopDefer");
    }
  });

  it("is hidden in mission setup (missionRunActive=false)", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: false,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("LoopDefer");
  });
});
