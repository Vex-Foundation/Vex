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
let mockExpire: Mock;
let mockResume: Mock;

function reset(): void {
  overdue = [];
  mockExpire = vi.fn(async () => ({ intentId: "i1" }));
  mockResume = vi.fn(async () => ({ resumed: true }));
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  listOverdueAwaitingForms: async (limit: number) => {
    expect(limit).toBeGreaterThan(0);
    return overdue;
  },
  expireIfAwaitingWith: (...a: unknown[]) => mockExpire(...a),
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
