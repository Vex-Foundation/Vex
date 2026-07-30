/**
 * Phase 4d scheduler — persistErrorPauseWithMaybeAutoRetry eligibility matrix
 * + enqueueAutoRetryWake. The DB client + repos are mocked; the classifier and
 * the snapshot opt-in parser run for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryOneWith = vi.fn();
const incrementErrorRetryCount = vi.fn();
const updateStatus = vi.fn().mockResolvedValue(undefined);
const enqueue = vi.fn();

// The paused_error park now runs the DURABLE OPERATOR-STOP CONSUMER inside its
// own transaction (see `mission-auto-retry.ts`): it takes the session control
// lock and gates on a queued `stop_terminal` request before writing. Both
// collaborators are stubbed to "no stop queued" here so these tests keep
// asserting the park itself.
vi.mock(
  "@vex-agent/engine/runtime/lease-and-status/operator-stop-boundary.js",
  () => ({ gateOnOperatorStopWithClient: async () => ({ kind: "clear" }) }),
);
vi.mock(
  "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js",
  () => ({ acquireSessionControlLock: async () => undefined }),
);

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(cb: (client: unknown) => Promise<T>): Promise<T> =>
    cb({}),
  queryOneWith: (...a: unknown[]) => queryOneWith(...a),
}));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  incrementErrorRetryCount: (...a: unknown[]) => incrementErrorRetryCount(...a),
  updateStatus: (...a: unknown[]) => updateStatus(...a),
}));
vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: (...a: unknown[]) => enqueue(...a),
}));

const { persistErrorPauseWithMaybeAutoRetry, enqueueAutoRetryWake } =
  await import("../../../../vex-agent/engine/core/runner/mission-auto-retry.js");

const OPT_IN = {
  version: 1,
  frozenMission: { constraintsJson: { autoRetryEnabled: true } },
};

function lockedRow(over: Record<string, unknown> = {}) {
  return {
    status: "paused_error",
    stop_reason: "provider_error",
    error_retry_count: 0,
    auto_retry_unsafe: false,
    contract_snapshot_json: OPT_IN,
    permission: "full",
    ...over,
  };
}

// WP1 (deliberate test update): the classifier no longer parses `err.message`
// — `mission-error-classifier.ts` now classifies exclusively from the
// `status`/`statusCode`/`causeCode` own-properties, so this fixture must
// carry a real `status` own-property instead of a "returned NNN" message.
const transientErr = (() => {
  const e = new Error("Provider returned 503");
  Object.assign(e, { status: 503 });
  return e;
})();

function call(err: unknown) {
  return persistErrorPauseWithMaybeAutoRetry(
    {
      runId: "run-1",
      sessionId: "sess-1",
      err,
      summary: "boom",
      evidenceBase: { errorMessage: "boom" },
    },
    0,
  );
}

beforeEach(() => {
  incrementErrorRetryCount.mockResolvedValue(1); // count 0 → new 1
});
afterEach(() => vi.clearAllMocks());

describe("persistErrorPauseWithMaybeAutoRetry", () => {
  it("ELIGIBLE: increments + schedules attempt 1 (backoff 2s) and persists paused_error with evidence", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow());
    const decision = await call(transientErr);
    expect(incrementErrorRetryCount).toHaveBeenCalledWith("run-1", expect.anything());
    expect(decision.scheduled).toEqual({ attempt: 1, dueAt: new Date(2000).toISOString() });
    // persists paused_error with the autoRetry evidence merged in.
    const [, status, reason, payload] = updateStatus.mock.calls[0];
    expect(status).toBe("paused_error");
    expect(reason).toBe("provider_error");
    expect((payload as { evidence: { autoRetry?: unknown } }).evidence.autoRetry).toEqual({
      attempt: 1,
      maxAttempts: 5,
      nextRetryAt: new Date(2000).toISOString(),
    });
  });

  it("PERMANENT error → no schedule, still persists paused_error", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow());
    const decision = await call(new Error("AGENT_VALIDATION_ERROR"));
    expect(decision.scheduled).toBeNull();
    expect(incrementErrorRetryCount).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledTimes(1);
  });

  it("UNSAFE stamp → no schedule", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow({ auto_retry_unsafe: true }));
    expect((await call(transientErr)).scheduled).toBeNull();
    expect(incrementErrorRetryCount).not.toHaveBeenCalled();
  });

  it("budget exhausted (count = 5) → no schedule", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow({ error_retry_count: 5 }));
    expect((await call(transientErr)).scheduled).toBeNull();
  });

  it("not full-mode permission → no schedule", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow({ permission: "restricted" }));
    expect((await call(transientErr)).scheduled).toBeNull();
  });

  it("opt-out snapshot → no schedule", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow({ contract_snapshot_json: {} }));
    expect((await call(transientErr)).scheduled).toBeNull();
  });

  it("run row missing → no schedule (still persists)", async () => {
    queryOneWith.mockResolvedValueOnce(null);
    expect((await call(transientErr)).scheduled).toBeNull();
    expect(updateStatus).toHaveBeenCalledTimes(1);
  });

  it.each(["stopped", "cancelled", "completed", "failed"])(
    "run already TERMINAL (%s) under the row lock → writes NOTHING",
    async (status) => {
      // Codex Wave-1 defect 8: a terminal run row is immutable audit history.
      // The commonest way to land here is an operator Stop that already
      // committed while the loop was unwinding — persisting `paused_error`
      // would overwrite the user's stop with a recoverable-looking pause and
      // re-open a run whose approvals were already rejected. Checked under the
      // SAME row lock the write uses, so it is a gate and not a TOCTOU read.
      queryOneWith.mockResolvedValueOnce(lockedRow({ status }));
      const decision = await call(transientErr);
      expect(decision).toEqual({ scheduled: null, persisted: false });
      expect(updateStatus).not.toHaveBeenCalled();
      expect(incrementErrorRetryCount).not.toHaveBeenCalled();
    },
  );

  it("3rd retry → backoff 8s (attempt 3)", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow({ error_retry_count: 2 }));
    incrementErrorRetryCount.mockResolvedValueOnce(3);
    const decision = await call(transientErr);
    expect(decision.scheduled).toEqual({ attempt: 3, dueAt: new Date(8000).toISOString() });
  });

  it("evidence carries classified/statusCode/causeCode from the reader, and NEVER errorName", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow());
    const transportErr = Object.assign(new Error("connection reset"), {
      causeCode: "ECONNRESET",
    });
    await call(transportErr);
    const [, , , payload] = updateStatus.mock.calls[0];
    const evidence = (payload as { evidence: Record<string, unknown> }).evidence;
    expect(evidence.classified).toBe("transient");
    expect(evidence.statusCode).toBeNull();
    expect(evidence.causeCode).toBe("ECONNRESET");
    // fix-wave BLOCKER 1: `errorName` (arbitrary `err.name` text) must never
    // reach persisted evidence — dropped in favor of the bounded
    // `errorClass` (`err.constructor.name`) evidenceBase already carries.
    expect(evidence).not.toHaveProperty("errorName");
    // stop_reason vocabulary is unchanged — claim-auto-retry.ts hard-gates on it.
    const [, status, reason] = updateStatus.mock.calls[0];
    expect(status).toBe("paused_error");
    expect(reason).toBe("provider_error");
  });

  it("evidence for a permanent 401 carries statusCode and a null causeCode", async () => {
    queryOneWith.mockResolvedValueOnce(lockedRow());
    const authErr = Object.assign(new Error("invalid key"), { status: 401 });
    await call(authErr);
    const [, , , payload] = updateStatus.mock.calls[0];
    const evidence = (payload as { evidence: Record<string, unknown> }).evidence;
    expect(evidence.classified).toBe("permanent");
    expect(evidence.statusCode).toBe(401);
    expect(evidence.causeCode).toBeNull();
  });
});

describe("enqueueAutoRetryWake", () => {
  it("enqueues a structured error_retry payload", async () => {
    enqueue.mockResolvedValueOnce({ id: "w1" });
    await enqueueAutoRetryWake({
      sessionId: "s1", runId: "run-1", attempt: 2, dueAt: new Date(4000).toISOString(),
    });
    const [input] = enqueue.mock.calls[0];
    expect(input).toMatchObject({
      sessionId: "s1",
      missionRunId: "run-1",
      payload: { trigger: "error_retry", attempt: 2 },
    });
    expect(input.dueAt).toBeInstanceOf(Date);
  });

  it("never throws when enqueue returns null or rejects", async () => {
    enqueue.mockResolvedValueOnce(null);
    await expect(
      enqueueAutoRetryWake({ sessionId: "s1", runId: "r", attempt: 1, dueAt: new Date(2000).toISOString() }),
    ).resolves.toBeUndefined();
    enqueue.mockRejectedValueOnce(new Error("db down"));
    await expect(
      enqueueAutoRetryWake({ sessionId: "s1", runId: "r", attempt: 1, dueAt: new Date(2000).toISOString() }),
    ).resolves.toBeUndefined();
  });
});
