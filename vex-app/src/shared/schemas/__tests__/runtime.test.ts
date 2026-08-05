import { describe, expect, it } from "vitest";
import {
  runtimeRequestInputSchema,
  runtimeStateDtoSchema,
  runtimeRequestPauseResultSchema,
  runtimeRequestStopResultSchema,
  runtimeRequestResumeResultSchema,
  runtimeCancelWakeResultSchema,
  controlStateEventSchema,
  CONTROL_STATE_EVENT_TYPE,
  PAUSED_WAKE_REASON_MAX_CHARS,
  PAUSED_WAKE_WATCH_SUMMARY_MAX_CHARS,
} from "../runtime.js";

const SESSION = "00000000-0000-4000-8000-000000000002";
const ISO = "2026-05-21T10:00:00.000Z";

describe("runtime schemas", () => {
  it("runtimeStateDtoSchema accepts an inactive shape (with lease + pending fields)", () => {
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: false,
      missionRunId: null,
      status: null,
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: null,
      iterationCount: null,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("runtimeStateDtoSchema accepts an active shape with status enum", () => {
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "running",
      stopReason: null,
      lastCheckpointAt: ISO,
      startedAt: ISO,
      iterationCount: 3,
      leaseActive: true,
      leaseExpiresAt: ISO,
      pendingControlKind: null,
      stoppable: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts paused_user status", () => {
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "paused_user",
      stopReason: "user_paused",
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 0,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("omits pausedWake entirely for a non-paused_wake state (characterization)", () => {
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "running",
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 1,
      leaseActive: true,
      leaseExpiresAt: ISO,
      pendingControlKind: null,
      stoppable: false,
    });
    expect(parsed.success).toBe(true);
    // OPTIONAL, not nullable: a state that is not sleeping carries no key at
    // all, so `"pausedWake" in dto` is the renderer's whole gate.
    expect(parsed.success && "pausedWake" in parsed.data).toBe(false);
  });

  it("accepts a paused_wake state carrying pausedWake", () => {
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "paused_wake",
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 4,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: false,
      pausedWake: {
        dueAt: ISO,
        reason: "waiting for the ETH funding window",
        watchSummary: "price, balance",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects pausedWake on a status other than paused_wake", () => {
    // The field is the renderer's whole "is it sleeping" gate, so a running
    // run carrying sleep details is a contract violation, not a display quirk.
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "running",
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 4,
      leaseActive: true,
      leaseExpiresAt: ISO,
      pendingControlKind: null,
      stoppable: false,
      pausedWake: { dueAt: ISO, reason: null, watchSummary: null },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps a paused_wake state WITHOUT pausedWake valid (claimed/cancelled race)", () => {
    const parsed = runtimeStateDtoSchema.safeParse({
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "paused_wake",
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 4,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("pausedWake allows null reason/watchSummary and rejects extra keys", () => {
    const base = {
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "paused_wake" as const,
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 0,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: false,
    };
    expect(
      runtimeStateDtoSchema.safeParse({
        ...base,
        pausedWake: { dueAt: ISO, reason: null, watchSummary: null },
      }).success,
    ).toBe(true);
    // Strict: the raw watch payload must never ride along.
    expect(
      runtimeStateDtoSchema.safeParse({
        ...base,
        pausedWake: {
          dueAt: ISO,
          reason: null,
          watchSummary: null,
          payload: { secret: 1 },
        },
      }).success,
    ).toBe(false);
  });

  it("pausedWake bounds display text and requires an ISO dueAt", () => {
    const base = {
      sessionId: SESSION,
      hasActiveRun: true,
      missionRunId: "run-1",
      status: "paused_wake" as const,
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: ISO,
      iterationCount: 0,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: false,
    };
    expect(
      runtimeStateDtoSchema.safeParse({
        ...base,
        pausedWake: {
          dueAt: ISO,
          reason: "x".repeat(PAUSED_WAKE_REASON_MAX_CHARS + 1),
          watchSummary: null,
        },
      }).success,
    ).toBe(false);
    expect(
      runtimeStateDtoSchema.safeParse({
        ...base,
        pausedWake: {
          dueAt: ISO,
          reason: null,
          watchSummary: "x".repeat(PAUSED_WAKE_WATCH_SUMMARY_MAX_CHARS + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      runtimeStateDtoSchema.safeParse({
        ...base,
        pausedWake: { dueAt: "soon", reason: null, watchSummary: null },
      }).success,
    ).toBe(false);
  });

  it("runtimeRequestInputSchema requires uuid sessionId", () => {
    expect(
      runtimeRequestInputSchema.safeParse({ sessionId: SESSION }).success,
    ).toBe(true);
    expect(runtimeRequestInputSchema.safeParse({ sessionId: "x" }).success).toBe(
      false,
    );
  });

});

describe("runtime per-action discriminated unions", () => {
  it("requestPause accepts all 6 outcomes", () => {
    expect(
      runtimeRequestPauseResultSchema.safeParse({
        outcome: "queued",
        requestId: "00000000-0000-4000-8000-000000000003",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestPauseResultSchema.safeParse({
        outcome: "already_pending",
        requestId: "00000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestPauseResultSchema.safeParse({ outcome: "no_active_run" })
        .success,
    ).toBe(true);
    expect(
      runtimeRequestPauseResultSchema.safeParse({
        outcome: "already_paused",
        status: "paused_user",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestPauseResultSchema.safeParse({
        outcome: "terminal",
        status: "stopped",
      }).success,
    ).toBe(true);
    // WP-C: a `running` run with a dead lease is refused up front instead
    // of being enqueued and stranded forever (issue #12's bug class).
    expect(
      runtimeRequestPauseResultSchema.safeParse({ outcome: "already_parked" })
        .success,
    ).toBe(true);
  });

  it("requestResume lease_busy carries retryAfterMs without owner exposure", () => {
    const parsed = runtimeRequestResumeResultSchema.safeParse({
      outcome: "lease_busy",
      retryAfterMs: 12_000,
    });
    expect(parsed.success).toBe(true);
    // Strict — owner field is not part of the schema and would be rejected.
    const withOwner = runtimeRequestResumeResultSchema.safeParse({
      outcome: "lease_busy",
      retryAfterMs: 12_000,
      currentOwner: "secret-owner-id",
    });
    expect(withOwner.success).toBe(false);
  });

  it("requestResume covers all 6 outcomes", () => {
    expect(
      runtimeRequestResumeResultSchema.safeParse({
        outcome: "resumed",
        runId: "run-1",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestResumeResultSchema.safeParse({
        outcome: "already_running",
        runId: "run-1",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestResumeResultSchema.safeParse({ outcome: "no_active_run" })
        .success,
    ).toBe(true);
    expect(
      runtimeRequestResumeResultSchema.safeParse({
        outcome: "blocked_approval",
        pendingApprovalId: "approval-1",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestResumeResultSchema.safeParse({
        outcome: "blocked_error",
        reason: "system",
      }).success,
    ).toBe(true);
  });

  it("requestStop covers its outcomes", () => {
    expect(
      runtimeRequestStopResultSchema.safeParse({
        outcome: "queued",
        requestId: "00000000-0000-4000-8000-000000000005",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestStopResultSchema.safeParse({ outcome: "stopped" }).success,
    ).toBe(true);
    expect(
      runtimeRequestStopResultSchema.safeParse({
        outcome: "already_terminal",
        status: "stopped",
      }).success,
    ).toBe(true);
    expect(
      runtimeRequestStopResultSchema.safeParse({ outcome: "no_active_run" })
        .success,
    ).toBe(true);
  });

  it("cancelWake covers its outcomes", () => {
    expect(
      runtimeCancelWakeResultSchema.safeParse({
        outcome: "cancelled_wake",
        cancelledCount: 2,
      }).success,
    ).toBe(true);
    expect(
      runtimeCancelWakeResultSchema.safeParse({ outcome: "no_pending_wake" })
        .success,
    ).toBe(true);
  });
});

describe("controlStateEventSchema", () => {
  const VALID = {
    type: CONTROL_STATE_EVENT_TYPE,
    sessionId: SESSION,
    missionRunId: "run-1",
    runStatus: "paused_user" as const,
    stopReason: "user_paused",
    pendingControlKind: null,
    leaseActive: false,
    leaseExpiresAt: null,
    correlationId: null,
  };

  it("accepts a canonical payload", () => {
    expect(controlStateEventSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects wrong literal type", () => {
    expect(
      controlStateEventSchema.safeParse({
        ...VALID,
        type: "engine.control.something_else",
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (.strict)", () => {
    expect(
      controlStateEventSchema.safeParse({ ...VALID, smuggled: "x" }).success,
    ).toBe(false);
  });

  it("does not expose owner-id (rejected extra)", () => {
    expect(
      controlStateEventSchema.safeParse({
        ...VALID,
        leaseOwnerId: "internal-owner",
      }).success,
    ).toBe(false);
  });
});
