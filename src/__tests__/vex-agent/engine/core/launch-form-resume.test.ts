/**
 * `resumeAgentAfterUserForm` — waking the agent after the human answered the
 * form it opened (§C3b), and the ONE interface main-side code has to that wake.
 *
 * The mechanics in `user-form-runtime.ts` had zero production callers: the agent
 * asked, the user deployed, and the turn sat parked forever holding an
 * unanswered tool call. This module is the launch-shaped orchestration over
 * those mechanics — claim the parked run exactly once, append the tool result
 * that answers the ORIGINAL call, stamp the intent in the same transaction.
 *
 * What these pins protect:
 *
 *   - **Exactly once.** A second submit (double click, retried IPC, a submit
 *     racing the expiry sweep) must NOT append a second result. Two guards, and
 *     the test covers both: the run-lease claim for a mission, and the
 *     `result_message_id IS NULL` CAS for a chat session, where there is no run
 *     to claim and the stamp is the only gate.
 *   - **Never a hang.** Dismissal and expiry resume with an honest result rather
 *     than leaving the turn parked, and the wording is the shared
 *     `userFormDismissalOutput` — not a second copy that could drift.
 *   - **It answers THIS call.** The result carries the intent's persisted
 *     `toolCallId`; an intent with none can never be resumed against.
 *   - **Refusals are named, not thrown.** The caller is main-side IPC, which
 *     must distinguish "already answered" (do nothing) from "busy" (retryable).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "sess-1";
const INTENT_ID = "launch-intent-001";
const TOOL_CALL_ID = "call_abc123";

let intent: Record<string, unknown> | null;
let claimOutcome: Record<string, unknown>;
let committed: Record<string, unknown>[];
let stampReturns: unknown;
let stampCalls: unknown[][];
let missionResumes: unknown[][];
let chatResumes: unknown[][];
/** The durable operator-stop gate the chat dispatch must consult. */
let stopGate: Record<string, unknown>;
let gateCalls: unknown[][];
let sessionLeaseClaims: unknown[][];
let sessionLeaseBusy: boolean;
let leaseReleases: unknown[][];
let consumeCalls: unknown[][];
let consumeReturns: boolean;
/** `[sessionId, leaseHandle]` per closing decision. */
let closeCalls: unknown[][];
/** The mission RUN lease the claim hands back, so its release can be asserted. */
let missionLeaseHandle: { ownerId: string } | null;
/** Set to make the transcript commit fail, exercising the release-on-throw path. */
let commitThrows: Error | null;
/** Set to make the mission dispatch fail, exercising the same path. */
let dispatchThrows: Error | null;

vi.mock("@vex-agent/engine/core/runner/mission.js", () => ({
  resumeMissionRun: async (...args: unknown[]) => {
    if (dispatchThrows !== null) throw dispatchThrows;
    missionResumes.push(args);
  },
}));

vi.mock("@vex-agent/engine/core/runner/agent.js", () => ({
  runAgentTurnUnderLease: async (...args: unknown[]) => {
    chatResumes.push(args);
  },
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: async () => ({ loadConfig: async () => ({ model: "test" }) }),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: async (...args: unknown[]) => {
    sessionLeaseClaims.push(args);
    return sessionLeaseBusy
      ? { outcome: "lease_busy" }
      : { outcome: "claimed", lease: { sessionId: SESSION_ID } };
  },
  claimRunLeaseAndFlipToRunning: async () => ({ outcome: "claimed" }),
  gateOnOperatorStopWithClient: async (...args: unknown[]) => {
    gateCalls.push(args);
    return stopGate;
  },
  withSessionControlLock: async (
    _sessionId: string,
    fn: (client: unknown) => Promise<unknown>,
  ) => fn({ query: vi.fn() }),
  acquireSessionControlLock: async () => undefined,
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (opts: { ownerId: string; lease: unknown }) => ({
    lease: opts.lease,
    ownerId: opts.ownerId,
    release: async () => undefined,
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: async (...args: unknown[]) => {
    leaseReleases.push(args);
  },
}));

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  getById: async (intentId: string, sessionId: string) =>
    intent === null ? null : { ...intent, intentId, sessionId },
  stampResultMessageWith: async (...args: unknown[]) => {
    stampCalls.push(args);
    return stampReturns;
  },
  /**
   * The COMPLETION marker. `result_message_id` is not it: that says the
   * transcript has the answer, which is true long before the turn it answers
   * has been dispatched.
   */
  casMarkUserFormResumeConsumedWith: async (...args: unknown[]) => {
    consumeCalls.push(args);
    return consumeReturns;
  },
}));

vi.mock("@vex-agent/engine/core/user-form-runtime.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@vex-agent/engine/core/user-form-runtime.js",
  );
  return {
    ...actual,
    claimUserFormResume: async () => claimOutcome,
    /**
     * The CLOSING boundary: retire the Stop, mark completion, release the
     * lease — one ordering, lease still held. Faked to record WHAT it was
     * handed and to run the caller's `consume`, so the ordering the real
     * function owns stays asserted here rather than re-implemented.
     */
    closeUserFormContinuation: async (input: {
      sessionId: string;
      leaseHandle: unknown;
      consume: (client: unknown) => Promise<void>;
    }) => {
      closeCalls.push([input.sessionId, input.leaseHandle]);
      await input.consume({});
    },
    commitUserFormToolResult: async (input: Record<string, unknown>) => {
      if (commitThrows !== null) throw commitThrows;
      committed.push(input);
      const stamp = input.stamp as (c: unknown, id: number) => Promise<void>;
      await stamp({}, 4242);
    },
  };
});

const { resumeAgentAfterUserForm } = await import(
  "@vex-agent/engine/core/launch-form-resume.js"
);
const { userFormDismissalOutput } = await import(
  "@vex-agent/engine/core/user-form-runtime.js"
);

beforeEach(() => {
  intent = {
    sessionId: SESSION_ID,
    missionRunId: "run-1",
    toolCallId: TOOL_CALL_ID,
    resultMessageId: null,
    resumeConsumedAt: null,
    status: "confirmed",
    name: "Vex Coin",
    symbol: "VEX",
  };
  committed = [];
  stampReturns = { intentId: INTENT_ID };
  stampCalls = [];
  missionResumes = [];
  chatResumes = [];
  stopGate = { kind: "clear" };
  gateCalls = [];
  sessionLeaseClaims = [];
  sessionLeaseBusy = false;
  leaseReleases = [];
  consumeCalls = [];
  consumeReturns = true;
  closeCalls = [];
  commitThrows = null;
  dispatchThrows = null;
  missionLeaseHandle = { ownerId: "run-lease-owner" };
  claimOutcome = { outcome: "claimed", leaseHandle: missionLeaseHandle };
});

/**
 * The single recorded call of a one-shot seam, or a failure that says which pin
 * broke. Narrowing, never `!`: an out-of-range index would otherwise surface as
 * "cannot read property of undefined" three lines later instead of naming the
 * expectation that actually failed.
 */
function onlyCall(calls: unknown[][], what: string): unknown[] {
  const first = calls[0];
  if (calls.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${what}, got ${calls.length}`);
  }
  return first;
}

/** The single appended tool result, or a failure that says which pin broke. */
function onlyCommitted(): Record<string, unknown> {
  const first = committed[0];
  if (committed.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one committed tool result, got ${committed.length}`);
  }
  return first;
}

function launched() {
  return {
    intentId: INTENT_ID,
    sessionId: SESSION_ID,
    outcome: {
      kind: "launched" as const,
      txHash: "0xdead",
      tokenAddress: "0x58659Ef9B4E4Fd0b0C0dE0b0c0de0B0c0De0b91A",
    },
  };
}

describe("a successful launch wakes the agent with the outcome", () => {
  it("appends ONE result answering the intent's original tool call", async () => {
    const result = await resumeAgentAfterUserForm(launched());
    expect(result).toEqual({ resumed: true });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      success: true,
      ref: { sessionId: SESSION_ID, missionRunId: "run-1", toolCallId: TOOL_CALL_ID },
    });
  });

  it("names the token and the transaction, and says the user did it", async () => {
    await resumeAgentAfterUserForm(launched());
    const output = String(committed[0]!.output);
    expect(output).toContain("0x58659Ef9B4E4Fd0b0C0dE0b0c0de0B0c0De0b91A");
    expect(output).toContain("0xdead");
    expect(output).toContain("user");
  });

  it("stamps the intent inside the SAME transaction as the result row", async () => {
    await resumeAgentAfterUserForm(launched());
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0]![3]).toBe(4242);
  });
});

/**
 * Appending the result is only half a resume.
 *
 * The approval path learned this the hard way: a result written with nobody
 * dispatched leaves the turn holding its answer and the agent asleep. The wake
 * is therefore part of THIS function, and it mirrors the approval continuation —
 * `resumeMissionRun` for a run, `runAgentTurnUnderLease` for a chat session.
 */
describe("the agent is actually WOKEN, not just answered", () => {
  it("a mission run resumes through resumeMissionRun, after the result exists", async () => {
    await resumeAgentAfterUserForm(launched());
    expect(committed).toHaveLength(1);
    expect(missionResumes).toHaveLength(1);
    expect(missionResumes[0]![0]).toBe("run-1");
    expect(chatResumes).toHaveLength(0);
  });

  it("a chat session resumes through the agent turn runner instead", async () => {
    intent = { ...intent, missionRunId: null };
    await resumeAgentAfterUserForm(launched());
    expect(chatResumes).toHaveLength(1);
    expect(chatResumes[0]![0]).toBe(SESSION_ID);
    expect(missionResumes).toHaveLength(0);
  });

  it("dispatches nothing when the result was refused", async () => {
    claimOutcome = { outcome: "already_resolved", currentStatus: "running" };
    await resumeAgentAfterUserForm(launched());
    expect(missionResumes).toHaveLength(0);
    expect(chatResumes).toHaveLength(0);
  });
});

describe("dismissal and expiry resume honestly instead of hanging", () => {
  it("uses the shared dismissal wording, not a second copy", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "dismissed" },
    });
    expect(committed[0]!.output).toBe(userFormDismissalOutput("dismissed"));
    expect(committed[0]!.success).toBe(false);
  });

  it("expiry says the form expired", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "expired" },
    });
    expect(committed[0]!.output).toBe(userFormDismissalOutput("expired"));
  });

  /**
   * The owner's live case (tx 0x09b84e…e955): a broadcast that sat unmined.
   *
   * Before the third arm existed the wake was chosen from `txHash !== null`, so
   * this exact event resumed the agent with `success: true` and "deployed the
   * token. This is done" — while the executor's own result for it said
   * `success:false` and "could not be confirmed yet". The pins below are the
   * honesty contract, not cosmetics.
   */
  it("an UNCONFIRMED broadcast is not reported as a launch", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: {
        kind: "unconfirmed",
        txHash: "0x09b84e",
        reason: "the launch transaction could not be confirmed yet.",
      },
    });
    const result = onlyCommitted();
    const output = String(result.output);
    expect(result.success).toBe(false);
    expect(output).toContain("0x09b84e");
    expect(output).toContain("pending");
    expect(output).not.toMatch(/deployed|done|No token was created/i);
  });

  it("an unconfirmed broadcast tells the model NOT to retry", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "unconfirmed", txHash: "0x09b84e", reason: "not confirmed yet." },
    });
    expect(String(onlyCommitted().output)).toContain("DO NOT");
  });

  it("an unconfirmed broadcast with no hash says so instead of inventing one", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "unconfirmed", txHash: null, reason: "the broadcast could not be read." },
    });
    const output = String(onlyCommitted().output);
    expect(output).toContain("no transaction hash");
    expect(output).not.toContain("null");
  });

  /**
   * U5's crash window. The identity sweep mirrors the lane's
   * `superseded_unproven` verdict onto the intent and the process dies before
   * the parked turn is woken; the expiry sweep is then the only thing left to
   * answer it, and it used to answer "expired" — a false statement about a
   * launch that WAS signed and DID spend gas.
   */
  it("a SUPERSEDED launch is neither expired, nor failed, nor deployed", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "superseded_unproven", txHash: "0x09b84e" },
    });
    const result = onlyCommitted();
    const output = String(result.output);
    expect(result.success).toBe(false);
    expect(output).toContain("0x09b84e");
    expect(output).toContain("no longer tracked");
    expect(output).toContain("MAY exist");
    // Regression (Codex final review 2026-08-05): the lane reaches
    // `superseded_unproven` from EITHER a proven nonce supersession OR a
    // transaction unknown to the node, and the intent does not record which.
    // The copy must therefore never assert a cause - not a replacement, not a
    // network drop, nothing the intent did not persist.
    expect(output).not.toMatch(/replaced|dropped/i);
    // Not "expired" (nothing signed), not "deployed" (nothing proved), and not
    // "No token was created" (the one sentence the evidence rules out).
    expect(output).not.toBe(userFormDismissalOutput("expired"));
    expect(output).not.toMatch(/deployed|No token was created/i);
  });

  it("a superseded launch forbids a blind relaunch and promises no auto-resolution", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "superseded_unproven", txHash: "0x09b84e" },
    });
    const output = String(onlyCommitted().output);
    expect(output).toContain("DO NOT launch again");
    // The `unconfirmed` arm's promise would be a lie here: nothing is checking.
    expect(output).not.toContain("will resolve automatically");
  });

  it("a failed launch tells the model nothing was created", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "failed", reason: "Refusing to launch: insufficient balance." },
    });
    expect(committed[0]!.success).toBe(false);
    expect(String(committed[0]!.output)).toContain("insufficient balance");
  });
});

describe("exactly once — a second submit can never append a second result", () => {
  it("a lost run claim refuses as already_resolved and appends nothing", async () => {
    claimOutcome = { outcome: "already_resolved", currentStatus: "running" };
    const result = await resumeAgentAfterUserForm(launched());
    expect(result).toEqual({ resumed: false, reason: "already_resolved" });
    expect(committed).toHaveLength(0);
  });

  it("a busy lease is reported as RETRYABLE, distinct from already_resolved", async () => {
    // Fake timers because a `busy` also ARMS the retry ladder; letting it run on
    // real timers would leak a live ladder into the next test (it is idempotent
    // per intent, so a leaked one suppresses the next test's ladder entirely).
    vi.useFakeTimers();
    try {
      claimOutcome = { outcome: "busy" };
      const result = await resumeAgentAfterUserForm(launched());
      expect(result).toEqual({ resumed: false, reason: "busy" });
      expect(committed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A CONCURRENT stamp is a recovery, not a refusal — the correction that
   * closes the lost-continuation half of the corner.
   *
   * The `result_message_id IS NULL` CAS still stops a SECOND result being
   * appended (the transcript row rolls back with the null stamp). What must NOT
   * happen is giving up: the row reaching here with a stamp and no consumption
   * is exactly the crash / restart / busy-lease case, where the transcript
   * carries its answer and the turn that answer exists for never ran. Stopping
   * would strand that turn forever.
   */
  it("a concurrent stamp still dispatches — the turn is what is owed", async () => {
    intent = { ...intent, missionRunId: null };
    stampReturns = null;

    const result = await resumeAgentAfterUserForm(launched());

    expect(result).toEqual({ resumed: true });
    // Exactly one result exists in the transcript: ours rolled back.
    expect(chatResumes).toHaveLength(1);
    expect(consumeCalls).toHaveLength(1);
  });

  /**
   * An intent whose continuation ALREADY completed is the one true refusal.
   * `resume_consumed_at` is the authority — not the result stamp.
   */
  it("refuses only once a resumed turn has COMPLETED", async () => {
    intent = { ...intent, missionRunId: null, resumeConsumedAt: "2026-08-04T00:00:00.000Z" };

    const result = await resumeAgentAfterUserForm(launched());

    expect(result).toEqual({ resumed: false, reason: "already_resolved" });
    expect(committed).toHaveLength(0);
    expect(chatResumes).toHaveLength(0);
    expect(consumeCalls).toHaveLength(0);
  });

  /**
   * RECOVERY: a stamped-but-unconsumed row skips the append and goes straight
   * to the dispatch. Re-appending would answer one tool call twice.
   */
  it("a stamped-but-unconsumed intent dispatches WITHOUT re-appending", async () => {
    intent = { ...intent, missionRunId: null, resultMessageId: 4242 };

    const result = await resumeAgentAfterUserForm(launched());

    expect(result).toEqual({ resumed: true });
    expect(committed).toHaveLength(0);
    expect(stampCalls).toHaveLength(0);
    expect(chatResumes).toHaveLength(1);
    expect(consumeCalls).toHaveLength(1);
  });
});

/**
 * A busy lease must not lose the wake.
 *
 * `busy` is the ordinary case, not an edge: the user deploys while a turn is
 * still running. Returning `busy` and forgetting would leave the turn parked
 * with a launched token nobody told the agent about. The ladder mirrors
 * `approval-runtime/deferred-resume.ts` — short, finite, in-process — over the
 * durable floor of `listOutstandingUserFormResumes`.
 */
describe("a busy lease gets a durable retry, not a shrug", () => {
  it("retries after the lease frees, and resumes exactly once", async () => {
    vi.useFakeTimers();
    try {
      claimOutcome = { outcome: "busy" };
      const first = await resumeAgentAfterUserForm(launched());
      expect(first).toEqual({ resumed: false, reason: "busy" });
      expect(committed).toHaveLength(0);

      // The other runner lets go; the first rung of the ladder now wins.
      claimOutcome = { outcome: "claimed" };
      await vi.advanceTimersByTimeAsync(2_000);

      expect(committed).toHaveLength(1);
      expect(missionResumes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops laddering once the form is answered by someone else", async () => {
    vi.useFakeTimers();
    try {
      claimOutcome = { outcome: "busy" };
      await resumeAgentAfterUserForm(launched());

      claimOutcome = { outcome: "already_resolved", currentStatus: "running" };
      await vi.advanceTimersByTimeAsync(2_000);
      const attemptsAfterFirstRung = committed.length;
      // Later rungs must not keep firing at a settled form.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(committed).toHaveLength(attemptsAfterFirstRung);
      expect(committed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("it refuses by name rather than guessing", () => {
  it("an unknown intent is not_found", async () => {
    intent = null;
    expect(await resumeAgentAfterUserForm(launched())).toEqual({
      resumed: false,
      reason: "intent_not_found",
    });
    expect(committed).toHaveLength(0);
  });

  it("an intent with no parked call cannot be resumed against", async () => {
    intent = { ...intent, toolCallId: null };
    expect(await resumeAgentAfterUserForm(launched())).toEqual({
      resumed: false,
      reason: "no_parked_call",
    });
    expect(committed).toHaveLength(0);
  });
});


/**
 * BLOCKER 2 (Codex whole-wave final review). The chat-form dispatch used to
 * call `runAgentTurnUnderLease` — the LEASE-ALREADY-HELD runner — with no lease
 * held, no operator-stop gate and no abort signal.
 *
 * The consequence is the same class of hole as the reconciler's resume path,
 * on the LAUNCH path: a Stop committed in the gap between the tool result being
 * appended and this dispatch was retired as "nothing will observe it", and then
 * the model turn ran anyway on a session the operator had stopped — where the
 * next thing the agent does can spend real money.
 */
describe("the chat-form dispatch is leased and stop-gated", () => {
  beforeEach(() => {
    intent = { ...intent, missionRunId: null };
    // A chat session has no run to flip, so the claim hands back no run lease.
    claimOutcome = { outcome: "claimed", leaseHandle: null };
  });

  /**
   * DEFECT 1. The lease is released BY the closing decision, never before it.
   *
   * Releasing first and marking consumption afterwards leaves an interval in
   * which the form is still outstanding (so a Stop is RETAINED) but the lease
   * is already gone — and the moment consumption lands, that retained request
   * has no observer left and later refuses unrelated work. So the handle is
   * HANDED to the close, which retires the Stop, marks completion and releases
   * in one ordering.
   */
  it("hands its SESSION lease to the CLOSE rather than releasing it early", async () => {
    await resumeAgentAfterUserForm(launched());

    expect(onlyCall(sessionLeaseClaims, "session lease claim")[0]).toMatchObject(
      { sessionId: SESSION_ID },
    );
    expect(chatResumes).toHaveLength(1);
    // Nothing released the lease behind the closing decision's back…
    expect(leaseReleases).toHaveLength(0);
    // …it was handed over WITH the session, still held.
    const close = onlyCall(closeCalls, "closing decision");
    expect(close[0]).toBe(SESSION_ID);
    expect(close[1]).not.toBeNull();
    // And the completion was marked as part of that same decision.
    expect(consumeCalls).toHaveLength(1);
  });

  it("runs NO model turn when the operator stopped the session first", async () => {
    stopGate = { kind: "stopped", runStatus: "cancelled", scope: "session" };

    const result = await resumeAgentAfterUserForm(launched());

    // The RESULT still lands — the form's outcome is a fact about the user's
    // money and a Stop must not erase it…
    expect(result).toEqual({ resumed: true });
    expect(committed).toHaveLength(1);
    // …and the TURN does not run.
    expect(chatResumes).toHaveLength(0);
    // The gate was consulted for the SESSION scope (there is no run row).
    expect(gateCalls[0]?.[1]).toEqual({
      sessionId: SESSION_ID,
      missionRunId: null,
    });
    // The lease still goes back — through the closing decision.
    expect(onlyCall(closeCalls, "closing decision")[1]).not.toBeNull();
  });

  it("threads ONE slice signal into BOTH turn-loop positions", async () => {
    await resumeAgentAfterUserForm(launched());

    const call = onlyCall(chatResumes, "chat turn dispatch");
    const inferenceSignal = call[3] as AbortSignal | undefined;
    const boundarySignal = call[5] as AbortSignal | undefined;
    expect(inferenceSignal).toBeInstanceOf(AbortSignal);
    // One controller, both positions — a Stop landing DURING the resume lands
    // at the next iteration AND mid-provider-call, never mid-dispatch.
    expect(boundarySignal).toBe(inferenceSignal);
    // The lease owner reaches the turn loop, so a compaction cutover can prove
    // ownership instead of silently never applying.
    expect(call[6]).toBe(`launch-form-${INTENT_ID}`);
  });

  /**
   * A busy lease at DISPATCH must leave the continuation OWED.
   *
   * Reporting `resumed: true` here was the second half of the corner: nothing
   * ran, yet the caller was told the wake landed — and with eligibility keyed
   * off the result stamp the durable scan could no longer see the row either,
   * so the turn was lost permanently. It is reported `busy` (retryable) and,
   * decisively, NOT consumed — which is what keeps it in the floor's set even
   * if this process dies before the ladder fires.
   */
  it("leaves the continuation OWED when another runner holds the lease", async () => {
    sessionLeaseBusy = true;

    const result = await resumeAgentAfterUserForm(launched());

    expect(result).toEqual({ resumed: false, reason: "busy" });
    expect(committed).toHaveLength(1);
    expect(chatResumes).toHaveLength(0);
    expect(leaseReleases).toHaveLength(0);
    // THE POINT: no completion marker, so the row stays in the durable set.
    expect(consumeCalls).toHaveLength(0);
  });

  /**
   * A Stop is a TERMINAL answer to the continuation, not a reason to retry it
   * forever. The gated turn declined, but it declined durably — so the
   * completion marker is written and the floor stops re-selecting the row.
   */
  it("CONSUMES the continuation when the gate declined on a stop", async () => {
    stopGate = { kind: "stopped", runStatus: "cancelled", scope: "session" };

    const result = await resumeAgentAfterUserForm(launched());

    expect(result).toEqual({ resumed: true });
    expect(chatResumes).toHaveLength(0);
    expect(consumeCalls).toHaveLength(1);
  });

  /**
   * The MISSION branch keeps its own claim (`claimUserFormResume` flipped the
   * run under a row lock) and must not grow a second, session-scoped one.
   */
  it("leaves the mission-run branch untouched", async () => {
    intent = { ...intent, missionRunId: "run-1" };

    await resumeAgentAfterUserForm(launched());

    expect(missionResumes).toHaveLength(1);
    expect(sessionLeaseClaims).toHaveLength(0);
    expect(gateCalls).toHaveLength(0);
  });
});


/**
 * DEFECT 2 (Codex final review turn 3). `claimUserFormResume` acquires a real
 * RUN lease for a mission form and used to DROP it: the mission branch called
 * `resumeMissionRun`, whose contract states the CALLER owns the lease
 * lifecycle, and nothing ever released it. With no handle there was no
 * heartbeat either, so the row simply sat until its TTL lapsed — the session
 * blocked for minutes with nothing in the process able to shorten it.
 */
describe("the mission-form resume owns its claimed lease", () => {
  beforeEach(() => {
    intent = { ...intent, missionRunId: "run-1" };
  });

  it("hands the claimed RUN lease to the closing decision", async () => {
    const result = await resumeAgentAfterUserForm(launched());

    expect(result).toEqual({ resumed: true });
    expect(missionResumes).toHaveLength(1);
    // The very handle the claim produced — not a second, unrelated claim.
    expect(onlyCall(closeCalls, "closing decision")[1]).toBe(missionLeaseHandle);
  });

  it("RELEASES the claimed lease when the dispatch throws", async () => {
    dispatchThrows = new Error("resume exploded");

    await expect(resumeAgentAfterUserForm(launched())).rejects.toThrow(
      "resume exploded",
    );
    // The closing decision was never reached, so the `finally` owes the
    // release — and it emits control state with it, so the renderer learns the
    // session is free again instead of waiting out the TTL.
    const release = onlyCall(leaseReleases, "lease release");
    expect(release[0]).toBe(missionLeaseHandle);
    expect(release[1]).toBe(SESSION_ID);
    expect(release[2]).toEqual({ missionRunId: "run-1" });
    expect(closeCalls).toHaveLength(0);
  });

  it("RELEASES the claimed lease when the result commit throws", async () => {
    commitThrows = new Error("transcript write failed");

    await expect(resumeAgentAfterUserForm(launched())).rejects.toThrow(
      "transcript write failed",
    );

    expect(onlyCall(leaseReleases, "lease release")[0]).toBe(missionLeaseHandle);
    expect(closeCalls).toHaveLength(0);
  });
});
