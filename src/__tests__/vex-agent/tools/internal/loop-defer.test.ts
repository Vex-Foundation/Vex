/**
 * Unit tests for the `loop_defer` handler — Zod validation, defense-in-depth
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

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  cancelForSession: (...args: unknown[]) => mockCancelForSession(...args),
  claimDue: (...args: unknown[]) => mockClaimDue(...args),
  getPendingForSession: (...args: unknown[]) => mockGetPendingForSession(...args),
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

beforeEach(() => {
  mockEnqueue.mockReset();
  mockEnqueue.mockResolvedValue(enqueueReturn());
  vi.useRealTimers();
});

// ── Zod validation ─────────────────────────────────────────────

describe("loop_defer — argument validation", () => {
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

describe("loop_defer — defense-in-depth", () => {
  it("rejects subagent role even if sessionKind matches", async () => {
    const ctx = makeTestContext({
      sessionKind: "mission",
      missionRunId: "run-abc",
      role: "subagent",
    });
    const result = await handleLoopDefer(
      { after_ms: 10_000, reason: "try" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/active mission run/i);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects agent sessionKind", async () => {
    const ctx = makeTestContext({
      sessionKind: "agent",
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

describe("loop_defer — happy path", () => {
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

// ── Registry visibility ────────────────────────────────────────

describe("loop_defer — visibility", () => {
  it("is visible in a mission active run (restricted)", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: true,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("loop_defer");
  });

  it("is visible in a mission active run (full)", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "full",
      sessionKind: "mission",
      missionRunActive: true,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("loop_defer");
  });

  it("is hidden in an agent session", () => {
    const tools = getOpenAITools(defaultVisibilityContext({ sessionKind: "agent" }));
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("loop_defer");
  });

  it("is hidden in mission setup (missionRunActive=false)", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: false,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("loop_defer");
  });

  it("is hidden from the subagent role even in a mission active run", () => {
    const tools = getOpenAITools(defaultVisibilityContext({
      permission: "restricted",
      role: "subagent",
      sessionKind: "mission",
      missionRunActive: true,
    }));
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("loop_defer");
  });
});
