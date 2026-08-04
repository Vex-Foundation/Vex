/**
 * C3b — the `paused_user_form` continuation.
 *
 * The three properties that keep an unattended, real-funds path honest:
 *   1. it parks WITHOUT enqueuing an approval (no approval card, ever);
 *   2. the resume is claimed EXACTLY ONCE — a second submit cannot append a
 *      second tool result for the same call;
 *   3. cancel and expiry RESUME the turn with an honest result instead of
 *      leaving it hanging on an unanswered tool call.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const updateStatus = vi.fn();
const updateStatusIfNotTerminal = vi.fn();
const claimRunLeaseAndFlipToRunning = vi.fn();
const acquireSessionControlLock = vi.fn();
const appendMessage = vi.fn();
const emitToolResultAppended = vi.fn();
const withTransaction = vi.fn();
const createLeaseHandle = vi.fn();
const releaseLeaseAndEmitControlState = vi.fn();
const gateOnOperatorStopWithClient = vi.fn();

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus, updateStatusIfNotTerminal }));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning,
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
}));
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({ createLeaseHandle }));
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState,
}));
vi.mock("@vex-agent/engine/events/index.js", () => ({ appendMessage }));
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({ emitToolResultAppended }),
);
vi.mock("@vex-agent/db/client.js", () => ({ withTransaction }));

const {
  USER_FORM_RESUME_CLAIMABLE_RUN_STATUSES,
  claimUserFormResume,
  closeUserFormContinuation,
  commitUserFormToolResult,
  parkRunForUserForm,
  userFormDismissalOutput,
} = await import("@vex-agent/engine/core/user-form-runtime.js");

const REF = { sessionId: "s1", missionRunId: "r1", toolCallId: "call_1" } as const;
const CLIENT = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(CLIENT));
  appendMessage.mockResolvedValue({ id: 42 });
  createLeaseHandle.mockImplementation((opts: { ownerId: string }) => ({
    ownerId: opts.ownerId,
    release: vi.fn(),
  }));
  gateOnOperatorStopWithClient.mockResolvedValue({ kind: "clear" });
});

describe("parking", () => {
  it("parks the run on paused_user_form — never on paused_approval", async () => {
    await parkRunForUserForm(REF);
    expect(updateStatusIfNotTerminal).toHaveBeenCalledWith("r1", "paused_user_form", "user_form_required");
    expect(updateStatusIfNotTerminal).not.toHaveBeenCalledWith("r1", "paused_approval", expect.anything());
    // Guarded write only: a terminal user Stop must never be resurrected by a
    // park (see mission-runs-unconditional-status-write.test.ts).
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("parks nothing for a chat session — there is no run to park", async () => {
    await parkRunForUserForm({ ...REF, missionRunId: null });
    expect(updateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("exactly-once claim", () => {
  it("claims only from paused_user_form", () => {
    expect([...USER_FORM_RESUME_CLAIMABLE_RUN_STATUSES]).toEqual(["paused_user_form"]);
  });

  /**
   * DEFECT 2. The claim acquires a REAL run lease, and `resumeMissionRun`'s
   * contract states the CALLER owns its lifecycle. Dropping `claim.lease` left
   * the row held with no handle to release it and no heartbeat to renew it, so
   * the session stayed blocked until the TTL lapsed.
   */
  it("CARRIES the claimed run lease back as a live handle", async () => {
    claimRunLeaseAndFlipToRunning.mockResolvedValue({
      outcome: "claimed",
      lease: { sessionId: "s1", missionRunId: "r1" },
    });

    const outcome = await claimUserFormResume(REF, "owner_1");

    expect(outcome.outcome).toBe("claimed");
    expect(
      outcome.outcome === "claimed" ? outcome.leaseHandle : null,
    ).toMatchObject({ ownerId: "owner_1" });
    expect(createLeaseHandle).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner_1" }),
    );
  });

  it("carries NO run lease for a chat session — there is no run to flip", async () => {
    const outcome = await claimUserFormResume(
      { ...REF, missionRunId: null },
      "owner_1",
    );

    expect(outcome).toEqual({ outcome: "claimed", leaseHandle: null });
    expect(claimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
  });

  it("claims the run and flips it back to running", async () => {
    claimRunLeaseAndFlipToRunning.mockResolvedValue({
      outcome: "claimed",
      lease: { sessionId: "s1" },
    });
    const claimed = await claimUserFormResume(REF, "owner_1");
    expect(claimed.outcome).toBe("claimed");
    expect(claimRunLeaseAndFlipToRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        missionRunId: "r1",
        fromStatuses: ["paused_user_form"],
        ownerId: "owner_1",
      }),
    );
  });

  it("refuses a SECOND submit — the run already left paused_user_form", async () => {
    claimRunLeaseAndFlipToRunning.mockResolvedValue({
      outcome: "status_mismatch",
      currentStatus: "running",
    });
    await expect(claimUserFormResume(REF, "owner_1")).resolves.toEqual({
      outcome: "already_resolved",
      currentStatus: "running",
    });
  });

  it("keeps `busy` (retryable) distinct from `already_resolved` (never retryable)", async () => {
    // Collapsing these would either duplicate a tool result or abandon a
    // transient lease conflict.
    claimRunLeaseAndFlipToRunning.mockResolvedValue({ outcome: "lease_busy", currentLease: {} });
    await expect(claimUserFormResume(REF, "owner_1")).resolves.toEqual({ outcome: "busy" });
  });
});

describe("result append — row + stamp in ONE transaction", () => {
  it("takes the session control lock FIRST, then appends, then stamps", async () => {
    const order: string[] = [];
    acquireSessionControlLock.mockImplementation(async () => void order.push("lock"));
    appendMessage.mockImplementation(async () => {
      order.push("append");
      return { id: 42 };
    });
    const stamp = vi.fn(async () => void order.push("stamp"));

    await commitUserFormToolResult({ ref: REF, success: true, output: "ok", stamp });

    expect(order).toEqual(["lock", "append", "stamp"]);
    expect(stamp).toHaveBeenCalledWith(CLIENT, 42);
  });

  it("answers the ORIGINAL tool call id, or the turn can never close", async () => {
    await commitUserFormToolResult({
      ref: REF,
      success: true,
      output: "ok",
      stamp: async () => {},
    });
    expect(appendMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ role: "tool", toolCallId: "call_1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("emits the transcript event only AFTER the transaction commits", async () => {
    const order: string[] = [];
    withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const out = await fn(CLIENT);
      order.push("commit");
      return out;
    });
    emitToolResultAppended.mockImplementation(() => void order.push("emit"));

    await commitUserFormToolResult({
      ref: REF,
      success: true,
      output: "ok",
      stamp: async () => {},
    });
    expect(order).toEqual(["commit", "emit"]);
  });

  it("a throwing stamp rolls the transcript row back and emits nothing", async () => {
    withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(CLIENT));
    const stamp = vi.fn(async () => {
      throw new Error("already settled");
    });

    await expect(
      commitUserFormToolResult({ ref: REF, success: true, output: "ok", stamp }),
    ).rejects.toThrow("already settled");
    expect(emitToolResultAppended).not.toHaveBeenCalled();
  });
});

describe("cancel / expiry never hang the turn", () => {
  it("tells the model the user DECLINED, and that nothing happened", () => {
    const output = userFormDismissalOutput("dismissed");
    expect(output).toContain("dismissed the form");
    expect(output).toContain("no funds moved");
    expect(output).toContain("declined");
  });

  it("distinguishes an expiry from a dismissal — they are different facts", () => {
    const expired = userFormDismissalOutput("expired");
    expect(expired).toContain("expired");
    expect(expired).not.toContain("dismissed the form");
    expect(expired).not.toBe(userFormDismissalOutput("dismissed"));
  });

  it("never claims the user approved anything", () => {
    for (const reason of ["dismissed", "expired"] as const) {
      expect(userFormDismissalOutput(reason).toLowerCase()).not.toContain("approved");
    }
  });
});


/**
 * DEFECT 1. The closing decision, and the interleaving it exists for.
 *
 * Releasing the lease and THEN marking consumption leaves an interval in which
 * the form is still outstanding by the durable predicate — so a Stop landing
 * there is RETAINED, correctly — but the lease is already gone. The moment
 * consumption lands, that retained request has no observer left: it sits open
 * until the next unrelated turn, defer or approved dispatch is refused by a
 * stop that was never meant for it.
 */
describe("closing the continuation leaves no orphaned Stop", () => {
  const CONSUME = vi.fn();

  /**
   * A complete `LeaseHandle`, not a partial cast: the closing decision hands
   * this straight to the release chokepoint, and a stub missing the fields that
   * contract requires would pass a test the production type would reject.
   */
  function leaseHandle(): Parameters<
    typeof closeUserFormContinuation
  >[0]["leaseHandle"] {
    return {
      lease: {
        sessionId: "s1",
        missionRunId: null,
        ownerId: "owner_1",
        processKind: "electron_main",
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      ownerId: "owner_1",
      release: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    CONSUME.mockReset();
    CONSUME.mockResolvedValue(undefined);
  });

  it("retires the Stop and marks completion in ONE transaction, lease still held", async () => {
    const handle = leaseHandle();

    await closeUserFormContinuation({
      sessionId: "s1",
      leaseHandle: handle,
      consume: CONSUME,
    });

    // Both writes rode the SAME client, so they commit together — the two
    // facts can never disagree about whether this continuation is finished.
    const gateClient = gateOnOperatorStopWithClient.mock.calls[0]?.[0];
    expect(gateClient).toBe(CLIENT);
    expect(CONSUME).toHaveBeenCalledWith(CLIENT);
    // …and the lock came first, per the global order.
    expect(acquireSessionControlLock).toHaveBeenCalledWith(CLIENT, "s1");
    // The release happened AFTER that decision, not before it.
    expect(releaseLeaseAndEmitControlState).toHaveBeenCalledWith(handle, "s1");
    const [consumeAt] = CONSUME.mock.invocationCallOrder;
    const [releaseAt] = releaseLeaseAndEmitControlState.mock.invocationCallOrder;
    expect(consumeAt).toBeLessThan(releaseAt ?? 0);
  });

  it("consults the gate again AFTER the release, closing that window too", async () => {
    await closeUserFormContinuation({
      sessionId: "s1",
      leaseHandle: leaseHandle(),
      consume: CONSUME,
    });

    // The release is not transactional, so a Stop can land between the commit
    // and it — retained while the lease is live, orphaned the instant it is
    // not. The second consultation retires exactly that row.
    expect(gateOnOperatorStopWithClient).toHaveBeenCalledTimes(2);
    // Invocation order, not first-call order: the FIRST consultation precedes
    // the release (it rides the closing commit) and the SECOND must follow it.
    const [firstGate, secondGate] =
      gateOnOperatorStopWithClient.mock.invocationCallOrder;
    const [release] = releaseLeaseAndEmitControlState.mock.invocationCallOrder;
    expect(firstGate).toBeLessThan(release ?? 0);
    expect(secondGate).toBeGreaterThan(release ?? 0);
    for (const call of gateOnOperatorStopWithClient.mock.calls) {
      expect(call[1]).toEqual({ sessionId: "s1", missionRunId: null });
    }
  });

  it("still closes when there is no lease to release", async () => {
    await closeUserFormContinuation({
      sessionId: "s1",
      leaseHandle: null,
      consume: CONSUME,
    });

    expect(CONSUME).toHaveBeenCalledTimes(1);
    expect(releaseLeaseAndEmitControlState).not.toHaveBeenCalled();
    // The Stop is still retired — a continuation that ran without a lease of
    // its own can still be the last observer of one.
    expect(gateOnOperatorStopWithClient).toHaveBeenCalledTimes(2);
  });
});
