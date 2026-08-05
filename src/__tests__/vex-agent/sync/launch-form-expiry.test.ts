/**
 * Form expiry — the half of "it expires and the turn resumes" that did not
 * exist.
 *
 * `expireIfAwaitingWith` was written, correct, and had NO production caller, so
 * an `agent_requested_form` launch the user never answered parked the agent's
 * turn FOREVER: nothing stamped the row `expired`, and nothing appended the
 * tool result the parked call was waiting for. The manifest promised a turn
 * that resumes; the runtime delivered one that hangs.
 *
 * The two writes are deliberately ordered and deliberately independent — see
 * the module doc for why a resume failure must not un-expire the row.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

let overdue: unknown[];
/** The durable floor's candidate set — continuations owed but never delivered. */
let outstanding: unknown[];
let mockExpire: Mock;
let mockResume: Mock;
/** A2: the sweep asks whether the session is still there before resuming. */
let mockSessionResumable: Mock;
/** A2: the write that retires a continuation no turn can ever run for. */
let mockCloseContinuation: Mock;

function reset(): void {
  overdue = [];
  outstanding = [];
  mockExpire = vi.fn(async () => ({ intentId: "i1" }));
  mockResume = vi.fn(async () => ({ resumed: true }));
  mockSessionResumable = vi.fn(async () => true);
  mockCloseContinuation = vi.fn(async () => true);
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  listOverdueAwaitingForms: async (limit: number) => {
    expect(limit).toBeGreaterThan(0);
    return overdue;
  },
  listOutstandingUserFormResumes: async (limit: number) => {
    expect(limit).toBeGreaterThan(0);
    return outstanding;
  },
  expireIfAwaitingWith: (...a: unknown[]) => mockExpire(...a),
  casCloseUserFormContinuationWith: (...a: unknown[]) => mockCloseContinuation(...a),
}));
vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  isSessionResumable: (...a: unknown[]) => mockSessionResumable(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_s: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/engine/core/launch-form-resume.js", () => ({
  resumeAgentAfterUserForm: (...a: unknown[]) => mockResume(...a),
}));

const { expireOverdueLaunchForms } = await import("@vex-agent/sync/launch-form-expiry.js");

const PARKED = {
  intentId: "i1",
  sessionId: "sess-1",
  origin: "agent_requested_form",
  toolCallId: "call-9",
};

beforeEach(() => { reset(); });

describe("expireOverdueLaunchForms", () => {
  it("expires an overdue form AND resumes the parked turn with kind 'expired'", async () => {
    overdue = [PARKED];

    const result = await expireOverdueLaunchForms();

    expect(result).toMatchObject({ checked: 1, expired: 1, resumed: 1 });
    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire.mock.calls[0]![1]).toBe("i1");
    expect(mockExpire.mock.calls[0]![2]).toBe("sess-1");
    expect(mockResume).toHaveBeenCalledWith({
      intentId: "i1",
      sessionId: "sess-1",
      outcome: { kind: "expired" },
    });
  });

  it("expires BEFORE resuming — the turn is never told a live form died", async () => {
    overdue = [PARKED];
    const order: string[] = [];
    mockExpire.mockImplementation(async () => { order.push("expire"); return { intentId: "i1" }; });
    mockResume.mockImplementation(async () => { order.push("resume"); return { resumed: true }; });

    await expireOverdueLaunchForms();

    expect(order).toEqual(["expire", "resume"]);
  });

  it("leaves a FRESH form completely alone — it is not a candidate", async () => {
    // The candidate query filters on `expires_at <= NOW()`, so a live form
    // never reaches this sweep. Nothing is expired and no turn is disturbed.
    overdue = [];
    const result = await expireOverdueLaunchForms();
    expect(result).toMatchObject({ checked: 0, expired: 0, resumed: 0 });
    expect(mockExpire).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("does not resume when the expiry CAS missed — someone else resolved the form", async () => {
    overdue = [PARKED];
    mockExpire.mockResolvedValue(null);

    const result = await expireOverdueLaunchForms();

    // A miss means the user submitted or dismissed it in the same instant. That
    // path owns the resume; appending a second result would answer one parked
    // call twice.
    expect(result).toMatchObject({ expired: 0, resumed: 0 });
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("counts a user-started form as expired but not resumed — there is no parked turn", async () => {
    overdue = [{ ...PARKED, origin: "user", toolCallId: null }];
    mockResume.mockResolvedValue({ resumed: false, reason: "no_parked_call" });

    const result = await expireOverdueLaunchForms();

    expect(result).toMatchObject({ expired: 1, resumed: 0 });
  });

  it("keeps sweeping when one resume throws — one stuck session cannot block the rest", async () => {
    overdue = [PARKED, { ...PARKED, intentId: "i2", sessionId: "sess-2" }];
    mockResume.mockRejectedValueOnce(new Error("lease exploded"));

    const result = await expireOverdueLaunchForms();

    // Both rows still EXPIRED — the row's terminal state does not depend on
    // whether the agent could be woken.
    expect(result).toMatchObject({ checked: 2, expired: 2, resumed: 1, resumeFailures: 1 });
  });

  it("reports a busy session as a resume failure rather than pretending it resumed", async () => {
    overdue = [PARKED];
    mockResume.mockResolvedValue({ resumed: false, reason: "busy" });
    const result = await expireOverdueLaunchForms();
    expect(result).toMatchObject({ expired: 1, resumed: 0, resumeFailures: 1 });
  });
});


/**
 * THE DURABLE FLOOR, driven by this same scheduled tick.
 *
 * `listOutstandingUserFormResumes` existed and had NO production caller — the
 * identical defect this module was written to fix one layer down. Every doc
 * comment promising "a failed dispatch does not lose the wake, the outstanding
 * scan finds this row again" was describing a sweep nobody ran.
 *
 * It matters for the one interleaving no in-process ladder can cover: the
 * result is stamped, then the lease is claimed, then the turn runs. A crash or
 * a busy lease in that gap leaves an ANSWERED tool call with no turn to read
 * it, and a crash has no process left to retry in.
 */
describe("the durable floor delivers continuations the resume could not", () => {
  it("dispatches a stamped-but-unconsumed form the scan still owns", async () => {
    outstanding = [{ intentId: "recovered-1", sessionId: "s-1" }];

    const result = await expireOverdueLaunchForms();

    expect(mockResume).toHaveBeenCalledWith({
      intentId: "recovered-1",
      sessionId: "s-1",
      outcome: { kind: "expired" },
    });
    expect(result.recovered).toBe(1);
    expect(result.recoveryFailures).toBe(0);
  });

  it("counts a still-busy session as a recovery failure, not a delivery", async () => {
    outstanding = [{ intentId: "busy-1", sessionId: "s-1" }];
    mockResume = vi.fn(async () => ({ resumed: false, reason: "busy" }));

    const result = await expireOverdueLaunchForms();

    expect(result.recovered).toBe(0);
    // Visible rather than silently stuck — the next tick tries again.
    expect(result.recoveryFailures).toBe(1);
  });

  it("keeps draining when one recovery throws", async () => {
    outstanding = [
      { intentId: "throws", sessionId: "s-1" },
      { intentId: "ok", sessionId: "s-2" },
    ];
    mockResume = vi.fn(async (input: { intentId: string }) => {
      if (input.intentId === "throws") throw new Error("provider down");
      return { resumed: true };
    });

    const result = await expireOverdueLaunchForms();

    expect(result.recovered).toBe(1);
    expect(result.recoveryFailures).toBe(1);
  });

  it("does nothing when the floor is empty", async () => {
    const result = await expireOverdueLaunchForms();

    expect(result.recovered).toBe(0);
    expect(mockResume).not.toHaveBeenCalled();
  });
});

/**
 * A2 — the orphaned continuation loop, and the bounded retry that replaces it.
 *
 * Live evidence: `trench.launch_form_expiry.resume_failed status=400` for intent
 * aa5401f2 on every ~60s sweep, forever. Its session had been DELETED
 * (`sessions:delete` at 22:22:54), so every attempt rebuilt a prompt from a
 * history that no longer existed. The sweep was obeying its own rules: the row
 * was outstanding, so it retried.
 */
describe("a continuation no turn can ever run for is retired, not retried", () => {
  it("closes a DELETED session's continuation with a named reason instead of resuming", async () => {
    outstanding = [{ intentId: "orphan-1", sessionId: "gone", status: "expired", resultMessageId: 7 }];
    mockSessionResumable.mockResolvedValue(false);

    const result = await expireOverdueLaunchForms();

    // Never attempted: the refusal it would earn tells us nothing we did not
    // already know, and it costs a model call to learn it.
    expect(mockResume).not.toHaveBeenCalled();
    expect(mockCloseContinuation).toHaveBeenCalledTimes(1);
    const [, ...closeArgs] = mockCloseContinuation.mock.calls[0] ?? [];
    expect(closeArgs).toEqual(["orphan-1", "gone", "session_deleted"]);
    expect(result.closed).toBe(1);
    expect(result.recoveryFailures).toBe(0);
  });

  it("writes the closure ONCE — a row already consumed by a real turn is not relabelled", async () => {
    outstanding = [{ intentId: "orphan-2", sessionId: "gone", status: "expired", resultMessageId: 7 }];
    mockSessionResumable.mockResolvedValue(false);
    // The CAS lost: a completion landed first. The sweep must not claim a
    // second, contradictory closure.
    mockCloseContinuation.mockResolvedValue(false);

    const result = await expireOverdueLaunchForms();

    expect(mockCloseContinuation).toHaveBeenCalledTimes(1);
    expect(result.closed).toBe(1);
  });

  it("leaves the outstanding set permanently — a closed row is never attempted again", async () => {
    outstanding = [{ intentId: "orphan-3", sessionId: "gone", status: "expired", resultMessageId: 7 }];
    mockSessionResumable.mockResolvedValue(false);
    await expireOverdueLaunchForms();

    // The durable write is what removes it: the next sweep's candidate query no
    // longer returns the row, because `resume_consumed_at` is set.
    outstanding = [];
    const second = await expireOverdueLaunchForms();

    expect(second.closed).toBe(0);
    expect(mockResume).not.toHaveBeenCalled();
  });
});

describe("a transient resume failure backs off instead of warning every minute", () => {
  it("skips the row until its rung comes round, then tries again", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
      outstanding = [{ intentId: "backoff-1", sessionId: "s-1", status: "expired", resultMessageId: 7 }];
      mockResume.mockResolvedValue({ resumed: false, reason: "busy" });

      const first = await expireOverdueLaunchForms();
      expect(first.recoveryFailures).toBe(1);
      expect(mockResume).toHaveBeenCalledTimes(1);

      // The very next sweep, 2 seconds later: NOT due.
      vi.setSystemTime(new Date("2026-08-05T00:00:02Z"));
      const second = await expireOverdueLaunchForms();
      expect(mockResume).toHaveBeenCalledTimes(1);
      expect(second.recoveryFailures).toBe(0);

      // 60s later it is.
      vi.setSystemTime(new Date("2026-08-05T00:01:01Z"));
      await expireOverdueLaunchForms();
      expect(mockResume).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the same deterministic refusal twice parks the continuation", () => {
  it("closes it with `resume_failed_deterministic` rather than retrying a request that cannot change", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
      outstanding = [{ intentId: "det-1", sessionId: "s-1", status: "expired", resultMessageId: 7 }];
      const refusal = Object.assign(new Error("provider refused the request"), { status: 400 });
      mockResume.mockRejectedValue(refusal);

      const first = await expireOverdueLaunchForms();
      expect(first.recoveryFailures).toBe(1);
      expect(mockCloseContinuation).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-08-05T00:01:01Z"));
      const second = await expireOverdueLaunchForms();

      expect(mockCloseContinuation).toHaveBeenCalledTimes(1);
      const [, , , parkReason] = mockCloseContinuation.mock.calls[0] ?? [];
      expect(parkReason).toBe("resume_failed_deterministic");
      expect(second.closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a remediable 4xx is bounded but never parked", () => {
  it("keeps a rate-limited resume alive — the user must not lose a turn to a 429", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
      outstanding = [{ intentId: "rl-1", sessionId: "s-1", status: "expired", resultMessageId: 7 }];
      mockResume.mockRejectedValue(Object.assign(new Error("slow down"), { status: 429 }));

      await expireOverdueLaunchForms();
      vi.setSystemTime(new Date("2026-08-05T00:01:01Z"));
      await expireOverdueLaunchForms();

      expect(mockResume).toHaveBeenCalledTimes(2);
      expect(mockCloseContinuation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the expiry half checks the session too", () => {
  it("closes rather than resumes when the form's session was deleted", async () => {
    overdue = [{ ...PARKED, intentId: "expired-orphan", status: "awaiting_user_form", resultMessageId: null }];
    mockSessionResumable.mockResolvedValue(false);

    const result = await expireOverdueLaunchForms();

    // The row is STILL expired — the deadline passed, and that fact never
    // depended on whether a turn could be woken.
    expect(result.expired).toBe(1);
    expect(mockResume).not.toHaveBeenCalled();
    const [, , , closeReason] = mockCloseContinuation.mock.calls[0] ?? [];
    expect(closeReason).toBe("session_deleted");
    expect(result.closed).toBe(1);
  });
});
