/**
 * Dismissing an agent-requested pools.fun form - the transition, the wake, and
 * the four things that must NOT happen.
 *
 * The defect this closes: closing the dialog left the `awaiting_user_form`
 * intent live and the agent's turn parked, so the user's decision reached the
 * agent only when `sync/launch-form-expiry.ts` swept the window fifteen minutes
 * later - and reached it as an EXPIRY rather than as a dismissal.
 *
 * WHAT IS REAL HERE: `cancelAwaitingPoolsLaunchForm` itself. Faked are exactly
 * the three boundaries it crosses - the intents repo, the session control lock,
 * and the resume - so no database, lease or model provider is reached. What is
 * asserted is the state machine over them.
 *
 * THE AUTHORITY TABLE (one row per intent status, and every row has a case
 * below). Only `awaiting_user_form` may be cancelled, exactly as
 * `cancelIfAwaitingWith` allows one layer down; a launch past that point has no
 * exit that is not terminal, so cancelling from any other status is refused BY
 * NAME rather than attempted:
 *
 *   previewed           refused - advisory, holds no authorization, nothing parked
 *   awaiting_user_form  CANCELLED, then the parked turn is woken `dismissed`
 *   authorized          refused - the signing path has consumed the consent
 *   consuming           refused - mid-signature
 *   broadcast_pending   refused - already on the network
 *   awaiting_keeper     refused - signed and settled, waiting on somebody else
 *   confirmed           refused - over
 *   terminal_failure    refused - over
 *   cancelled           refused - over
 *   expired             refused - over
 *   superseded_unproven refused - broadcast, outcome never established
 *
 * NOT-OURS rows are refused too: another launchpad's form, and any intent id
 * that does not resolve inside THIS session.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

let mockGetById: Mock;
let mockCancel: Mock;
let mockResume: Mock;
/** Every session id the control lock was taken for, in order. */
let lockedSessions: string[];

function reset(): void {
  mockGetById = vi.fn();
  mockCancel = vi.fn(async () => ({ intentId: "i1", status: "cancelled" }));
  mockResume = vi.fn(async () => ({ resumed: true }));
  lockedSessions = [];
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  getById: (...a: unknown[]) => mockGetById(...a),
  cancelIfAwaitingWith: (...a: unknown[]) => mockCancel(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (sessionId: string, fn: (c: unknown) => Promise<unknown>) => {
    lockedSessions.push(sessionId);
    return fn({});
  },
}));
vi.mock("@vex-agent/engine/core/launch-form-resume.js", () => ({
  resumeAgentAfterUserForm: (...a: unknown[]) => mockResume(...a),
}));

const { cancelAwaitingPoolsLaunchForm } = await import(
  "@vex-agent/tools/protocols/pools/launch/desktop-form-cancel.js"
);

const SESSION = {
  sessionId: "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e",
  walletAddress: `0x${"1".repeat(40)}`,
} as const;
const INTENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** An intent row as `getById` maps it, in whatever status the case needs. */
function intent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: INTENT_ID,
    sessionId: SESSION.sessionId,
    protocol: "pools_fun",
    status: "awaiting_user_form",
    origin: "agent_requested_form",
    toolCallId: "call-9",
    ...over,
  };
}

function cancel(): ReturnType<typeof cancelAwaitingPoolsLaunchForm> {
  return cancelAwaitingPoolsLaunchForm(SESSION, { intentId: INTENT_ID });
}

function refusalOf(outcome: Awaited<ReturnType<typeof cancel>>): {
  readonly kind: string;
  readonly message: string;
} {
  if (outcome.ok) throw new Error("expected a refusal, got a success");
  return outcome.refusal;
}

function valueOf(outcome: Awaited<ReturnType<typeof cancel>>): {
  readonly cancelled: boolean;
  readonly resumedAgentTurn: boolean;
} {
  if (!outcome.ok) {
    throw new Error(`expected a success, got ${outcome.refusal.kind}: ${outcome.refusal.message}`);
  }
  return outcome.value;
}

beforeEach(() => {
  reset();
});

describe("an awaiting form is cancelled and its turn is woken", () => {
  it("moves the row to cancelled and resumes the parked turn as DISMISSED", async () => {
    mockGetById.mockResolvedValue(intent());

    const outcome = await cancel();

    expect(valueOf(outcome)).toEqual({ cancelled: true, resumedAgentTurn: true });
    // The SAME writer family the expiry sweep uses, under the SAME lock.
    expect(lockedSessions).toEqual([SESSION.sessionId]);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel.mock.calls[0]?.[1]).toBe(INTENT_ID);
    expect(mockCancel.mock.calls[0]?.[2]).toBe(SESSION.sessionId);
    // `dismissed`, never `expired`: the user decided, and the model is told so.
    expect(mockResume).toHaveBeenCalledWith({
      intentId: INTENT_ID,
      sessionId: SESSION.sessionId,
      outcome: { kind: "dismissed" },
    });
  });

  it("cancels BEFORE resuming - a turn is never told a live form died", async () => {
    mockGetById.mockResolvedValue(intent());
    const order: string[] = [];
    mockCancel.mockImplementation(async () => {
      order.push("cancel");
      return { intentId: INTENT_ID };
    });
    mockResume.mockImplementation(async () => {
      order.push("resume");
      return { resumed: true };
    });

    await cancel();

    expect(order).toEqual(["cancel", "resume"]);
  });

  it("writes NO failure reason - a user's own dismissal is not a launch failure", async () => {
    mockGetById.mockResolvedValue(intent());

    await cancel();

    // `cancelIfAwaitingWith` takes (client, intentId, sessionId) and nothing
    // else. A fourth argument would be a reason, and a `cancelled` row WITH one
    // is read by the expiry sweep's recovery arm as a cancellation somebody
    // other than the user made - which would answer the model "the launch did
    // not go through" for a form the user simply closed.
    expect(mockCancel.mock.calls[0]).toHaveLength(3);
  });

  it("reports resumedAgentTurn FALSE when the lease was busy, and still cancels", async () => {
    mockGetById.mockResolvedValue(intent());
    mockResume.mockResolvedValue({ resumed: false, reason: "busy" });

    // The row is terminal either way: the user genuinely dismissed the form.
    // The continuation stays owed and the expiry sweep's durable floor finds it.
    expect(valueOf(await cancel())).toEqual({ cancelled: true, resumedAgentTurn: false });
  });

  it("a THROWN resume does not un-cancel the row", async () => {
    mockGetById.mockResolvedValue(intent());
    mockResume.mockRejectedValue(new Error("provider down"));

    expect(valueOf(await cancel())).toEqual({ cancelled: true, resumedAgentTurn: false });
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it("a CAS miss is a success with cancelled:false, and wakes nothing", async () => {
    // The form was submitted or swept in the same instant. THAT path owns the
    // parked call's one result; a second `dismissed` would answer it twice.
    mockGetById.mockResolvedValue(intent());
    mockCancel.mockResolvedValue(null);

    expect(valueOf(await cancel())).toEqual({ cancelled: false, resumedAgentTurn: false });
    expect(mockResume).not.toHaveBeenCalled();
  });
});

describe("every other status is refused BY NAME", () => {
  const REFUSED_STATUSES = [
    ["previewed", /preview/i],
    ["authorized", /authorized/i],
    ["consuming", /authorized/i],
    ["broadcast_pending", /broadcast/i],
    ["awaiting_keeper", /broadcast/i],
    ["confirmed", /confirmed/i],
    ["terminal_failure", /terminal_failure/i],
    ["cancelled", /cancelled/i],
    ["expired", /expired/i],
    ["superseded_unproven", /superseded_unproven/i],
  ] as const;

  it.each(REFUSED_STATUSES)(
    "%s refuses without writing or waking anything",
    async (status, sentence) => {
      mockGetById.mockResolvedValue(intent({ status }));

      const refusal = refusalOf(await cancel());

      expect(refusal.kind).toBe("form_not_cancellable");
      // The message names the state, because "cannot be cancelled" alone is
      // unactionable.
      expect(refusal.message).toMatch(sentence);
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockResume).not.toHaveBeenCalled();
      expect(lockedSessions).toEqual([]);
    },
  );

  it("another launchpad's form is refused - this dialog does not own it", async () => {
    mockGetById.mockResolvedValue(intent({ protocol: "virtuals" }));

    const refusal = refusalOf(await cancel());

    expect(refusal.kind).toBe("form_not_cancellable");
    expect(refusal.message).toMatch(/different launchpad/i);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("an id that does not resolve in THIS session is refused, and reads nothing else", async () => {
    // `getById` is session-scoped, so another session's intent misses exactly as
    // an unknown id does - and both are answered identically, on purpose.
    mockGetById.mockResolvedValue(null);

    const refusal = refusalOf(await cancel());

    expect(refusal.kind).toBe("form_not_cancellable");
    expect(mockGetById).toHaveBeenCalledWith(INTENT_ID, SESSION.sessionId);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });
});

describe("a failed read or write refuses honestly", () => {
  it("an unreadable intent refuses as provider_unavailable and leaks no message", async () => {
    mockGetById.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://vex:hunter2@127.0.0.1:5432/vex"),
    );

    const refusal = refusalOf(await cancel());

    expect(refusal.kind).toBe("provider_unavailable");
    expect(refusal.message).not.toContain("hunter2");
    expect(refusal.message).toMatch(/nothing was signed/i);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("a failed cancel write refuses and does not wake a turn about a live form", async () => {
    mockGetById.mockResolvedValue(intent());
    mockCancel.mockRejectedValue(new Error("deadlock detected"));

    const refusal = refusalOf(await cancel());

    expect(refusal.kind).toBe("provider_unavailable");
    expect(refusal.message).not.toContain("deadlock");
    expect(mockResume).not.toHaveBeenCalled();
  });
});

/**
 * NO MONEY PATH IS REACHABLE FROM HERE, asserted structurally.
 *
 * The behavioural cases above can only prove that a signer was not called on the
 * paths they drive. This one proves there is no edge to call: the module's whole
 * static import list is three boundaries, and a fingerprint store, plan builder,
 * signing client or activity writer appearing among them is the change that
 * would turn a dismissal into a money path.
 */
describe("the dismissal has no edge into the signing path", () => {
  it("imports the intents repo, the session lock and the resume, and nothing else", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL(
        "../../../../../vex-agent/tools/protocols/pools/launch/desktop-form-cancel.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const imported = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)]
      .map((match) => match[1])
      .sort();

    expect(imported).toEqual([
      "./runtime-contract.js",
      "@vex-agent/db/repos/token-launch-intents.js",
      "@vex-agent/engine/core/launch-form-resume.js",
      "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js",
    ]);
    // Belt and braces on the names themselves, so a widened barrel import from
    // one of the four above is still visible.
    expect(source).not.toMatch(/fingerprint-store|execute\/plan|launch-signing-clients|agent_activity/);
  });
});
