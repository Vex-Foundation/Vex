/**
 * `runStudioCall` - the composition an external coding agent actually feels.
 *
 * Two properties are pinned here because both were defects:
 *
 *   1. THE CAP IS CLAIMED BEFORE THE ENQUEUE. Reporting `not_queued` after an
 *      intent was written leaves a live, approvable action in Vex behind a
 *      caller that was told nothing would happen. So a refused reservation must
 *      mean the enqueue never ran at all, and a refused enqueue must give the
 *      reservation back.
 *   2. THE OUTCOME IS READ FROM TYPED COLUMNS. An expiry is
 *      `refusal_reason = 'expired'`, not a regular expression over a human
 *      sentence; an APPROVED row that carries a refusal reason is a
 *      pre-dispatch refusal and must be reported as one rather than decoded as
 *      a result that does not exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StudioSettlementRow } from "@vex-agent/db/repos/approval-intents.js";
import type { ProjectScope } from "@vex-agent/mcp/project-scope.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const ensureEngineDbUrl = vi.fn();
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (id: string) => ensureEngineDbUrl(id),
}));
const isSecretSessionUnlocked = vi.fn(() => true);
vi.mock("../../secrets/session.js", () => ({
  isSecretSessionUnlocked: () => isSecretSessionUnlocked(),
  isStudioDispatchPoisoned: () => false,
}));
const executeStudioTool = vi.fn();
vi.mock("@vex-agent/mcp/executor.js", () => ({ executeStudioTool }));
const enqueueStudioApprovalIntent = vi.fn();
vi.mock("@vex-agent/mcp/approvals.js", () => ({ enqueueStudioApprovalIntent }));
vi.mock("@vex-agent/mcp/project-context.js", () => ({
  buildProjectToolContext: () => ({}),
}));
const loadProjectScopeSnapshot = vi.fn();
vi.mock("../../database/projects/scope-snapshot.js", () => ({
  loadProjectScopeSnapshot: (projectId: string, correlationId: string) =>
    loadProjectScopeSnapshot(projectId, correlationId),
}));
const getStudioSettlementByApprovalId = vi.fn();
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getStudioSettlementByApprovalId,
}));

const { runStudioCall } = await import("../approval-service.js");
const { setStudioExecutorLoaderForTests } = await import("../executor-loader.js");
const {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  markStudioFenceUninitialized,
  markStudioRuntimeShuttingDown,
  resetStudioReadinessForTests,
} = await import("../readiness.js");

/**
 * Open a fresh initialization and complete it. Every readiness transition
 * carries the epoch it was started under, so a test that wants a READY runtime
 * has to own one - which is the same discipline the bridge follows.
 */
function markReady(): void {
  markStudioRuntimeReady(beginStudioReadinessEpoch());
}
const {
  configureStudioApprovalBroker,
  disposeStudioApprovalBroker,
  reserveStudioWaiterSlot,
  settleStudioWaiter,
  studioReservationCount,
  STUDIO_WAITER_CAP,
} = await import("../approval-broker.js");

const SCOPE: ProjectScope = {
  projectId: "11111111-1111-4111-8111-111111111111",
  scopeVersion: 3,
  permission: "restricted",
  backingSessionId: "22222222-2222-4222-8222-222222222222",
  wallets: { evm: null, solana: null },
};
const PROJECT_ID = SCOPE.projectId;
const CALL = { name: "wallet_send", args: {}, toolCallId: "call-1" };

function row(overrides: Partial<StudioSettlementRow> = {}): StudioSettlementRow {
  return {
    approvalId: "a-1",
    projectId: SCOPE.projectId,
    decision: "approved",
    decisionReason: null,
    refusalReason: null,
    executionStatus: "succeeded",
    settlement: { v: 1, result: { success: true, output: "done" } },
    settlementBytes: 40,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSecretSessionUnlocked.mockReturnValue(true);
  // Every case below is about a Studio that finished starting. The barrier
  // itself has its own describe block.
  markReady();
  ensureEngineDbUrl.mockResolvedValue({ ok: true, value: "postgres://x" });
  loadProjectScopeSnapshot.mockResolvedValue({ kind: "ok", scope: SCOPE });
  executeStudioTool.mockResolvedValue({
    result: { success: false, output: "needs approval", pendingApproval: true },
  });
  enqueueStudioApprovalIntent.mockResolvedValue({
    kind: "enqueued",
    approvalId: "a-1",
  });
  getStudioSettlementByApprovalId.mockResolvedValue(null);
  configureStudioApprovalBroker({
    refuseIntent: vi.fn().mockResolvedValue(true),
    expireIntent: vi.fn().mockResolvedValue(undefined),
    readSettlement: vi.fn().mockResolvedValue(null),
  });
});

afterEach(() => {
  disposeStudioApprovalBroker();
  resetStudioReadinessForTests();
  setStudioExecutorLoaderForTests(null);
});

describe("the readiness barrier", () => {
  it("refuses to queue anything before the barrier completes", async () => {
    // The reconciler declares every `dispatching` row indeterminate on the
    // premise that this process has just started and owns none of them. A call
    // admitted before it finishes could become a dispatch that races it for its
    // own row, so the honest answer is `not_queued` with the real cause.
    resetStudioReadinessForTests();
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    expect(outcome.reason).toMatch(/still starting/i);
    expect(outcome.reason).toMatch(/Nothing was executed/i);
    // Nothing ran and nothing was written: the refusal is before every effect.
    expect(executeStudioTool).not.toHaveBeenCalled();
    expect(enqueueStudioApprovalIntent).not.toHaveBeenCalled();
  });

  it("stays closed when the dispatch preflight could not be registered", async () => {
    markStudioFenceUninitialized(beginStudioReadinessEpoch());
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    // FAIL CLOSED, and by name: an unregistered preflight leaves the engine
    // defaulting to ALLOW, which is exactly what must not decide this.
    expect(outcome.reason).toMatch(/approval fence/i);
    expect(executeStudioTool).not.toHaveBeenCalled();
  });

  it("proceeds once the barrier marked the runtime ready", async () => {
    markReady();
    executeStudioTool.mockResolvedValue({
      result: { success: true, output: "read-only answer" },
    });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("completed");
    expect(executeStudioTool).toHaveBeenCalledTimes(1);
  });
});

describe("the cap is claimed before anything is written", () => {
  it("refuses at capacity WITHOUT enqueuing an approval", async () => {
    const claimed: Array<{ release: () => void }> = [];
    for (let i = 0; i < STUDIO_WAITER_CAP; i++) {
      const reserved = reserveStudioWaiterSlot();
      if (reserved.ok) claimed.push(reserved.reservation);
    }
    try {
      const outcome = await runStudioCall(PROJECT_ID, CALL);
      expect(outcome.kind).toBe("not_queued");
      if (outcome.kind !== "not_queued") return;
      expect(outcome.reason).toMatch(/Nothing was executed/i);
      // THE point: no row, no approval card, nothing for a human to approve.
      expect(enqueueStudioApprovalIntent).not.toHaveBeenCalled();
    } finally {
      for (const reservation of claimed) reservation.release();
    }
  });

  it("hands the executor's result to the enqueue seam WHOLE, binding included", async () => {
    // Stage A4b: a generic signing confirm attaches what its approval must be
    // BOUND TO - the decoded preview, the intent's own expiry and the proposal
    // digest, all rebuilt from the durable row. This function must not project,
    // filter or re-shape that result on the way to the enqueue, or the approval
    // would be bound to `{walletFamily, intentId}` again. What the binding then
    // does to the approval row is proven on real Postgres in the engine suite
    // (`integration/repos/wallet-transaction-approval-binding.int.test.ts`).
    const boundResult = {
      success: false,
      output: "needs approval",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
      preparedApprovalBinding: {
        preview: { label: "approve: let 0xspender spend 1000000", criticalArgs: { spender: "0xspender" } },
        intentExpiresAt: "2026-08-24T00:01:00.000Z",
        proposalDigest: "digest-abc",
        proposalDigestVersion: "v1",
        resource: { table: "wallet_transaction_intents", intentId: "wtx-1" },
      },
    };
    executeStudioTool.mockResolvedValue({ result: boundResult });

    // Not awaited: the call parks on the approval waiter, which is the point -
    // what is asserted is what reached the seam on the way there.
    const running = runStudioCall(PROJECT_ID, CALL);
    await vi.waitFor(() => {
      expect(enqueueStudioApprovalIntent).toHaveBeenCalledTimes(1);
    });
    settleStudioWaiter(row({ approvalId: "a-1" }));
    await running;

    const passed = enqueueStudioApprovalIntent.mock.calls[0]?.[0] as { result: unknown };
    expect(passed.result).toBe(boundResult);
  });

  it("gives the reservation back when the enqueue itself refuses", async () => {
    enqueueStudioApprovalIntent.mockResolvedValue({
      kind: "refused",
      reason: "Vex is locked. Nothing was executed.",
    });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    // A leaked reservation would shrink the cap for every later call.
    const reserved = reserveStudioWaiterSlot();
    expect(reserved.ok).toBe(true);
    if (reserved.ok) reserved.reservation.release();
  });
});

async function settleWith(settled: StudioSettlementRow): Promise<unknown> {
  const running = runStudioCall(PROJECT_ID, CALL);
  await vi.waitFor(() => {
    expect(getStudioSettlementByApprovalId).toHaveBeenCalled();
  });
  await Promise.resolve();
  settleStudioWaiter(settled);
  return running;
}

describe("the committed row becomes a typed outcome", () => {
  it("reads an expiry from `refusal_reason`, not from prose", async () => {
    const outcome = await settleWith(
      row({
        decision: "rejected",
        refusalReason: "expired",
        decisionReason: "expired_ttl",
        executionStatus: "not_started",
        settlement: null,
      }),
    );
    expect(outcome).toEqual({ kind: "expired", approvalId: "a-1" });
  });

  it("reports an APPROVED row carrying a refusal reason as a confirmed refusal", async () => {
    const refusal =
      "Approved action refused: Vex was stopped before this action could "
      + "start. Nothing was executed and no funds moved. Request the action "
      + "again if you still want it.";
    const outcome = await settleWith(
      row({
        decision: "approved",
        refusalReason: "stopped",
        executionStatus: "failed",
        settlement: { v: 1, result: { success: false, output: refusal } },
      }),
    );
    expect(outcome).toEqual({
      kind: "refused",
      approvalId: "a-1",
      reason: refusal,
      confirmed: true,
    });
  });

  it("does not read `expired` out of a declined row's wording", async () => {
    // The old prose match turned any sentence containing "expired" into an
    // expiry. A human decline is a decline, whatever words it used.
    const outcome = await settleWith(
      row({
        decision: "rejected",
        refusalReason: null,
        decisionReason: "No, that quote has expired and I want a fresh one.",
        executionStatus: "not_started",
        settlement: null,
      }),
    );
    expect(outcome).toMatchObject({ kind: "declined", approvalId: "a-1" });
  });

  it("reports an unprovable dispatch as `indeterminate`", async () => {
    const outcome = await settleWith(
      row({ executionStatus: "indeterminate", settlement: null }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", approvalId: "a-1" });
  });

  it("hands a settled result back WHOLE", async () => {
    const outcome = await settleWith(row());
    expect(outcome).toMatchObject({
      kind: "completed",
      approvalId: "a-1",
      result: { success: true, output: "done" },
    });
  });
});

describe("readiness is re-checked INSIDE the enqueue transaction", () => {
  /**
   * The barrier check at the top of `runStudioCall` describes the state BEFORE
   * `executeStudioTool` ran, and that call can take as long as a provider round
   * trip. A shutdown that begins in that window used to write an approval row
   * anyway: an intent parked in a process that will never dispatch it, behind a
   * blocked external agent, until a restart's reconciler found it.
   *
   * So the injected reader is evaluated inside the enqueue transaction, and
   * these cases drive exactly that interleaving.
   */
  it("refuses inside the transaction when readiness flips during the tool call", async () => {
    let availabilityAtEnqueue: { available: boolean; reason?: string } | null =
      null;
    // The enqueue gate runs the injected reader INSIDE its transaction. This
    // double stands in for that transaction and refuses on its answer, exactly
    // as `runStudioEnqueueGate` does.
    enqueueStudioApprovalIntent.mockImplementation(
      async (input: {
        readStudioRuntimeAvailability: () => {
          available: boolean;
          reason?: string;
        };
      }) => {
        availabilityAtEnqueue = input.readStudioRuntimeAvailability();
        if (!availabilityAtEnqueue.available) {
          return { kind: "refused", reason: availabilityAtEnqueue.reason };
        }
        return { kind: "enqueued", approvalId: "a-1" };
      },
    );
    // The shutdown lands AFTER the call was admitted and BEFORE the row would
    // be written.
    executeStudioTool.mockImplementation(async () => {
      markStudioRuntimeShuttingDown();
      return {
        result: { success: false, output: "needs approval", pendingApproval: true },
      };
    });

    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    // The REAL cause, by name: not "locked", not a generic error.
    expect(outcome.reason).toMatch(/shutting down/i);
    expect(outcome.reason).toMatch(/Nothing was executed/i);
    expect(availabilityAtEnqueue).toEqual({
      available: false,
      reason: expect.stringMatching(/shutting down/i),
    });
  });

  it("reports STARTING and LOCKED as different causes", async () => {
    const readers: Array<() => { available: boolean; reason?: string }> = [];
    enqueueStudioApprovalIntent.mockImplementation(
      async (input: {
        readStudioRuntimeAvailability: () => {
          available: boolean;
          reason?: string;
        };
      }) => {
        readers.push(input.readStudioRuntimeAvailability);
        const verdict = input.readStudioRuntimeAvailability();
        return verdict.available
          ? { kind: "enqueued", approvalId: "a-1" }
          : { kind: "refused", reason: verdict.reason };
      },
    );
    executeStudioTool.mockImplementation(async () => {
      resetStudioReadinessForTests();
      return {
        result: { success: false, output: "needs approval", pendingApproval: true },
      };
    });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    // Three causes, three remedies: wait, unlock, restart. Collapsing them
    // would tell the agent to do the wrong thing for two of them.
    expect(outcome.reason).toMatch(/still starting/i);
    expect(outcome.reason).not.toMatch(/locked/i);
  });

  it("gives the reservation back so a refusal leaves NO place held", async () => {
    enqueueStudioApprovalIntent.mockImplementation(
      async (input: {
        readStudioRuntimeAvailability: () => {
          available: boolean;
          reason?: string;
        };
      }) => {
        const verdict = input.readStudioRuntimeAvailability();
        return verdict.available
          ? { kind: "enqueued", approvalId: "a-1" }
          : { kind: "refused", reason: verdict.reason };
      },
    );
    executeStudioTool.mockImplementation(async () => {
      markStudioRuntimeShuttingDown();
      return {
        result: { success: false, output: "needs approval", pendingApproval: true },
      };
    });
    await runStudioCall(PROJECT_ID, CALL);
    expect(studioReservationCount()).toBe(0);
  });
});

/**
 * THE PER-CALL SCOPE SNAPSHOT (stage A4a, spec item 2).
 *
 * The caller hands in a `projectId`; the scope is loaded HERE, on every call,
 * and a connection can hold no cached copy of it. These cases are the reason
 * that design was chosen over a handshake-bound scope: each one is a state an
 * open connection can be sitting in while the user edits or deletes the
 * project underneath it.
 */
describe("the authoritative per-call scope snapshot", () => {
  it("loads the scope on every call, using the projectId it was given", async () => {
    executeStudioTool.mockResolvedValue({
      result: { success: true, output: "ok" },
      durationMs: 4,
    });
    await runStudioCall(PROJECT_ID, CALL);
    expect(loadProjectScopeSnapshot).toHaveBeenCalledTimes(1);
    expect(loadProjectScopeSnapshot.mock.calls[0]?.[0]).toBe(PROJECT_ID);
    // The scope the executor ran under is the one the snapshot returned, not
    // anything the caller supplied.
    expect(executeStudioTool.mock.calls[0]?.[0]).toEqual(SCOPE);
  });

  it("sees a full-to-restricted edit made between two calls on one connection", async () => {
    // This is the defect a connection-scoped scope would have: a connection
    // opened under `full` keeps executing mutations after the project turns
    // restricted, and no approval row exists for the A3 gates to protect.
    executeStudioTool.mockResolvedValue({
      result: { success: true, output: "ok" },
    });
    loadProjectScopeSnapshot.mockResolvedValueOnce({
      kind: "ok",
      scope: { ...SCOPE, permission: "full" },
    });
    await runStudioCall(PROJECT_ID, CALL);
    expect(executeStudioTool.mock.calls[0]?.[0]).toMatchObject({
      permission: "full",
      scopeVersion: 3,
    });

    loadProjectScopeSnapshot.mockResolvedValueOnce({
      kind: "ok",
      scope: { ...SCOPE, permission: "restricted", scopeVersion: 4 },
    });
    await runStudioCall(PROJECT_ID, CALL);
    expect(executeStudioTool.mock.calls[1]?.[0]).toMatchObject({
      permission: "restricted",
      scopeVersion: 4,
    });
  });

  it("sees a wallet edit made between two calls on one connection", async () => {
    executeStudioTool.mockResolvedValue({
      result: { success: true, output: "ok" },
    });
    const before = { id: "w-1", address: "0xaaa" };
    const after = { id: "w-2", address: "0xbbb" };
    loadProjectScopeSnapshot.mockResolvedValueOnce({
      kind: "ok",
      scope: { ...SCOPE, wallets: { evm: before, solana: null } },
    });
    await runStudioCall(PROJECT_ID, CALL);
    loadProjectScopeSnapshot.mockResolvedValueOnce({
      kind: "ok",
      scope: {
        ...SCOPE,
        scopeVersion: 4,
        wallets: { evm: after, solana: null },
      },
    });
    await runStudioCall(PROJECT_ID, CALL);

    expect(executeStudioTool.mock.calls[0]?.[0]?.wallets.evm).toEqual(before);
    // The signing key the second call would use is the NEW selection. A cached
    // scope would have signed with the key the user just replaced.
    expect(executeStudioTool.mock.calls[1]?.[0]?.wallets.evm).toEqual(after);
  });

  it("refuses a deleted project by name, and executes nothing", async () => {
    loadProjectScopeSnapshot.mockResolvedValue({ kind: "unknown_project" });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    expect(outcome.reason).toMatch(/no longer exists/i);
    expect(outcome.reason).toMatch(/nothing was executed/i);
    expect(executeStudioTool).not.toHaveBeenCalled();
  });

  it("refuses wallet drift naming the family, and executes nothing", async () => {
    loadProjectScopeSnapshot.mockResolvedValue({
      kind: "wallet_drift",
      family: "solana",
    });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    expect(outcome.reason).toMatch(/solana/);
    expect(outcome.reason).toMatch(/no funds moved/i);
    expect(executeStudioTool).not.toHaveBeenCalled();
  });

  it("refuses a scope that fails validation, and executes nothing", async () => {
    loadProjectScopeSnapshot.mockResolvedValue({
      kind: "invalid",
      detail: "the stored project scope failed validation",
    });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    expect(outcome.reason).toMatch(/could not establish/i);
    expect(executeStudioTool).not.toHaveBeenCalled();
  });

  it("separates an unreachable database from a missing project", async () => {
    loadProjectScopeSnapshot.mockResolvedValue({ kind: "unavailable" });
    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("not_queued");
    if (outcome.kind !== "not_queued") return;
    expect(outcome.reason).toMatch(/cannot reach its local database/i);
    // The remedy differs: a missing project is permanent, this one is worth a
    // retry, and the two sentences must not be interchangeable.
    expect(outcome.reason).not.toMatch(/no longer exists/i);
  });
});

/**
 * THE TWO GATES A CALL MUST PASS BEFORE ANYTHING DISPATCHES.
 *
 * `runStudioCall` is not the host's property: it is reachable from any caller
 * holding a projectId, and the two conditions below can both become true while
 * a call is already inside it. Neither was checked, so both produced the same
 * failure - `executeStudioTool` running for a call that must not run, which on
 * a full-permission project is real money moving.
 */
describe("the lock gate", () => {
  it("refuses without loading a scope or executing anything", async () => {
    isSecretSessionUnlocked.mockReturnValue(false);

    const outcome = await runStudioCall(PROJECT_ID, CALL);

    expect(outcome.kind).toBe("not_queued");
    expect(outcome.kind === "not_queued" ? outcome.reason : "").toMatch(/locked/i);
    expect(outcome.kind === "not_queued" ? outcome.reason : "").toMatch(
      /nothing was executed/i,
    );
    // NOTHING RAN, and nothing was even asked: no scope read, no tool.
    expect(loadProjectScopeSnapshot).not.toHaveBeenCalled();
    expect(executeStudioTool).not.toHaveBeenCalled();
    expect(enqueueStudioApprovalIntent).not.toHaveBeenCalled();
  });
});

describe("the pre-dispatch abort gate", () => {
  /** Hold the scope snapshot, so the abort lands where it used to be missed. */
  function heldSnapshot(): { release: () => void } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadProjectScopeSnapshot.mockImplementation(async () => {
      await gate;
      return { kind: "ok", scope: SCOPE };
    });
    return { release };
  }

  it("dispatches NOTHING when the client cancels while the scope read blocks", async () => {
    const held = heldSnapshot();
    const controller = new AbortController();

    const pending = runStudioCall(PROJECT_ID, CALL, {
      signal: controller.signal,
      cancelCause: () => "cancelled",
    });
    controller.abort("client asked");
    held.release();

    const outcome = await pending;
    expect(outcome.kind).toBe("not_queued");
    expect(outcome.kind === "not_queued" ? outcome.reason : "").toMatch(/cancelled/i);
    // THE ASSERTION THAT MATTERS: the tool never ran.
    expect(executeStudioTool).not.toHaveBeenCalled();
    expect(enqueueStudioApprovalIntent).not.toHaveBeenCalled();
  });

  it("dispatches NOTHING when the peer disconnects while the scope read blocks", async () => {
    const held = heldSnapshot();
    const controller = new AbortController();

    const pending = runStudioCall(PROJECT_ID, CALL, {
      signal: controller.signal,
      cancelCause: () => "disconnect",
    });
    controller.abort();
    held.release();

    const outcome = await pending;
    expect(outcome.kind).toBe("not_queued");
    // The TYPED cause decides the sentence, never the client's abort reason.
    expect(outcome.kind === "not_queued" ? outcome.reason : "").toMatch(
      /connection to Vex closed/i,
    );
    expect(executeStudioTool).not.toHaveBeenCalled();
  });

  it("names a quit as a quit rather than a cancellation", async () => {
    const held = heldSnapshot();
    const controller = new AbortController();

    const pending = runStudioCall(PROJECT_ID, CALL, {
      signal: controller.signal,
      cancelCause: () => "vex_quit",
    });
    controller.abort();
    held.release();

    const outcome = await pending;
    expect(outcome.kind === "not_queued" ? outcome.reason : "").toMatch(
      /shutting down/i,
    );
    expect(executeStudioTool).not.toHaveBeenCalled();
  });

  it("dispatches NOTHING when the client cancels while the EXECUTOR CHUNK loads", async () => {
    // THE DEFECT THIS PINS. The executor's dynamic import used to sit BELOW the
    // abort gate, so the gate answered "not aborted", the chunk load awaited,
    // the client cancelled inside it, and `executeStudioTool` then ran for a
    // call nobody was waiting for. A mutating tool would have spent real funds.
    //
    // The loader is HELD rather than timed: the abort lands while the import is
    // genuinely unresolved, which is the only version of this test that proves
    // anything.
    let releaseLoader: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    let loaderCalls = 0;
    setStudioExecutorLoaderForTests(async () => {
      loaderCalls += 1;
      await held;
      return { executeStudioTool };
    });
    const controller = new AbortController();

    const pending = runStudioCall(PROJECT_ID, CALL, {
      signal: controller.signal,
      cancelCause: () => "cancelled",
    });
    // Suspended inside the chunk load, before the scope snapshot.
    await Promise.resolve();
    expect(loaderCalls).toBe(1);
    expect(loadProjectScopeSnapshot).not.toHaveBeenCalled();

    controller.abort("client asked");
    releaseLoader();

    const outcome = await pending;
    expect(outcome.kind).toBe("not_queued");
    expect(outcome.kind === "not_queued" ? outcome.reason : "").toMatch(/cancelled/i);
    // THE ASSERTION THAT MATTERS: the tool never ran, and nothing was parked.
    expect(executeStudioTool).not.toHaveBeenCalled();
    expect(enqueueStudioApprovalIntent).not.toHaveBeenCalled();
  });

  it("resolves the executor chunk BEFORE the scope snapshot", async () => {
    // The ordering IS the property: an await below the gate is a window the
    // gate cannot cover, so the chunk load has to happen above the snapshot.
    const order: string[] = [];
    setStudioExecutorLoaderForTests(async () => {
      order.push("executor");
      return { executeStudioTool };
    });
    loadProjectScopeSnapshot.mockImplementation(async () => {
      order.push("snapshot");
      return { kind: "ok", scope: SCOPE };
    });
    executeStudioTool.mockResolvedValue({ result: { success: true, output: "ran" } });

    const outcome = await runStudioCall(PROJECT_ID, CALL);
    expect(outcome.kind).toBe("completed");
    expect(order).toEqual(["executor", "snapshot"]);
  });

  it("still runs a call whose signal never aborted", async () => {
    // The gate must not refuse the ordinary path: a signal that is present and
    // not aborted is the normal case for every served call.
    const controller = new AbortController();
    executeStudioTool.mockResolvedValue({
      result: { success: true, output: "ran" },
      durationMs: 3,
    });

    const outcome = await runStudioCall(PROJECT_ID, CALL, {
      signal: controller.signal,
    });
    expect(outcome.kind).toBe("completed");
    expect(executeStudioTool).toHaveBeenCalledTimes(1);
  });
});
