/**
 * The Studio approved-DISPATCH path.
 *
 * The properties that make an approved external call safe, each pinned by the
 * observable it would break:
 *
 *   - the slot is claimed under the stop gate, fenced on the dispatch
 *     generation, and NOTHING dispatches when that claim misses;
 *   - a manifest-fingerprint or request-digest mismatch REFUSES before the
 *     dispatch, as a controlled refusal rather than a throw;
 *   - the wallet scope comes from `project_wallets`, so a drifted backing
 *     session mirror cannot decide which key signs;
 *   - the settlement is stored WHOLE with its byte size, through the CAS
 *     fenced on `dispatching`;
 *   - no transcript message and no `result_message_id` are ever written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApproveSnapshot } from "@vex-agent/engine/core/approval-runtime/snapshot.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

type ApprovedInTxSnapshot = Extract<ApproveSnapshot, { type: "approved_in_tx" }>;

const casClaimStudioDispatchSlotWith = vi.fn();
const casRefuseStudioBeforeDispatchWith = vi.fn();
const commitStudioSettlementWith = vi.fn();
const casMarkIndeterminateWithSettlementWith = vi.fn();
const getStudioSettlementByApprovalId = vi.fn();
const admitStudioCall = vi.fn();
const gateOnOperatorStopWithClient = vi.fn();
const acquireSessionControlLock = vi.fn();
const commitApprovedToolResult = vi.fn();
const commitDecisionToolResult = vi.fn();
const poolQuery = vi.fn();
const clientQuery = vi.fn();

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  casClaimStudioDispatchSlotWith,
  casRefuseStudioBeforeDispatchWith,
  commitStudioSettlementWith,
  casMarkIndeterminateWithSettlementWith,
  getStudioSettlementByApprovalId,
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) =>
    fn({ query: clientQuery }),
  query: (sql: string, params?: unknown[]) => poolQuery(sql, params),
  queryOne: vi.fn().mockResolvedValue(null),
  execute: vi.fn().mockResolvedValue(1),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  executeWith: vi.fn().mockResolvedValue(1),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
}));
vi.mock("@vex-agent/mcp/admission.js", () => ({ admitStudioCall }));
// The transcript writers. Mocked ONLY so the assertions below can prove the
// Studio path never reaches them.
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({ commitApprovedToolResult, commitDecisionToolResult }),
);

const { applyStudioApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.js"
);
const { buildApprovalToolCall, computeStudioAuthorityDigest } = await import(
  "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
);
const { buildIntentPreview } = await import(
  "@vex-agent/engine/core/approval-intent-preview.js"
);
const { setStudioDispatchPreflight } = await import(
  "@vex-agent/engine/core/approval-runtime/studio/dispatch-gate.js"
);
const { studioWriteRepairCount, resetStudioWriteRepairForTests } = await import(
  "@vex-agent/engine/core/approval-runtime/studio/write-repair.js"
);

const APPROVAL_ID = "approval-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TOOL_ARGS = { network: "solana" };
const ENVELOPE = buildApprovalToolCall("wallet_send", TOOL_ARGS);
const PREVIEW = buildIntentPreview("wallet_send", TOOL_ARGS);
const EXPIRES_AT = "2026-08-23T11:00:00.000Z";

function pendingAdmission() {
  return {
    result: {
      success: false,
      output: "approval required",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
    } satisfies ToolResult,
    dispatched: true,
  };
}

function scriptApprovedResult(result: ToolResult): void {
  admitStudioCall.mockImplementation(async (_call, rawContext) => {
    const context = requireRecord(rawContext, "Studio tool context");
    return context.approved === true
      ? { result, dispatched: true }
      : pendingAdmission();
  });
}

function scriptApprovedThrow(cause: Error): void {
  admitStudioCall.mockImplementation(async (_call, rawContext) => {
    const context = requireRecord(rawContext, "Studio tool context");
    if (context.approved === true) throw cause;
    return pendingAdmission();
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshot(overrides: Record<string, unknown> = {}): ApprovedInTxSnapshot {
  return {
    type: "approved_in_tx",
    queueResolvedAt: "2026-08-23T10:00:00.000Z",
    row: {
      approval_id: APPROVAL_ID,
      session_id: SESSION_ID,
      mission_run_id: null,
      tool_call_id: "call-1",
      expires_at: EXPIRES_AT,
      preview_json: PREVIEW,
      decision: "approved",
      decision_reason: null,
      decided_at: null,
      execution_status: "not_started",
      execution_result_hash: null,
      origin: "studio_mcp",
      project_id: PROJECT_ID,
      scope_version_at_enqueue: 4,
      request_digest: computeStudioAuthorityDigest({
        envelope: ENVELOPE,
        preview: PREVIEW,
        expiresAt: EXPIRES_AT,
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        scopeVersion: 4,
        permission: "full",
      }),
      queue_status: "approved",
      queue_resolved_at: null,
      queue_created_at: new Date(),
      queue_tool_call: ENVELOPE,
      queue_tool_call_id: "call-1",
      queue_permission_at_enqueue: "full",
      session_permission_live: "full",
      ...overrides,
    },
  };
}

/** Project rows read OUTSIDE the transaction (the authoritative tables). */
function scriptPool(
  wallets: Array<{ family: string; wallet_id: string | null; address: string | null }>,
) {
  poolQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes("FROM projects")) {
      return [
        {
          id: PROJECT_ID,
          scope_version: 4,
          permission: "full",
          backing_session_id: SESSION_ID,
          // An ACTIVE project. `loadProjectScope` reads this column and throws
          // `ProjectDeletedError` for anything non-null, which the dispatch
          // path settles as `project_deleted`.
          deleted_at: null,
        },
      ];
    }
    if (text.includes("FROM project_wallets")) return wallets;
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setStudioDispatchPreflight(null);
  resetStudioWriteRepairForTests();
  gateOnOperatorStopWithClient.mockResolvedValue({ kind: "clear" });
  casClaimStudioDispatchSlotWith.mockResolvedValue(true);
  casRefuseStudioBeforeDispatchWith.mockResolvedValue(true);
  commitStudioSettlementWith.mockResolvedValue(true);
  casMarkIndeterminateWithSettlementWith.mockResolvedValue(true);
  // The default: no durable winner to follow. Every case that needs one scripts
  // it explicitly.
  getStudioSettlementByApprovalId.mockResolvedValue(null);
  clientQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes("FROM projects")) {
      return { rows: [{ scope_version: 4, deleted_at: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  scriptPool([
    { family: "evm", wallet_id: "evm_authoritative", address: "0xAuthoritative" },
    { family: "solana", wallet_id: null, address: null },
  ]);
  scriptApprovedResult({
    success: true,
    output: "sent",
    data: { txHash: "0xabc" },
  });
});

describe("a project deleted between approval and dispatch (B0)", () => {
  it("REFUSES at the hydration read and never reaches the executor", async () => {
    // `loadProjectScope` is the first thing to see the tombstone. It throws a
    // TYPED `ProjectDeletedError` so the caller can settle `project_deleted`
    // rather than the generic `scope_unavailable` - a deleted project is not an
    // unreadable one, and telling the user Vex could not read something would
    // be false.
    scriptPool([]);
    poolQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM projects")) {
        return [
          {
            id: PROJECT_ID,
            scope_version: 4,
            permission: "full",
            backing_session_id: SESSION_ID,
            deleted_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      return [];
    });

    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());

    // THE EXECUTOR SEAM WAS NEVER REACHED. Asserted on the spy, not on row
    // state: a refusal that still called the tool would have moved funds.
    expect(admitStudioCall).not.toHaveBeenCalled();

    // A pre-dispatch refusal is reported as a SETTLED dispatch carrying the
    // refusal as its tool result - the same envelope the final gate produces -
    // so the caller always learns the action's terminal state from one shape.
    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult?.output).toContain("was deleted");
    expect(outcome.toolResult?.output).toContain("no funds moved");

    // Settled under its OWN cause, not the generic `scope_unavailable` a
    // thrown-and-swallowed hydration error used to produce.
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refusalReason: "project_deleted" }),
    );
  });

  it("REFUSES at the FINAL GATE when the tombstone lands after hydration", async () => {
    // The gate re-reads the project row under the session control lock, which
    // is the SAME lock the delete transaction takes as edge 0. So a delete that
    // commits after hydration is necessarily visible here - this is the last
    // thing standing between an approved action and a wallet.
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM projects")) {
        return {
          rows: [
            {
              scope_version: 4,
              deleted_at: new Date("2026-08-29T10:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());

    // THE EXECUTOR SEAM WAS NEVER REACHED - the assertion that actually
    // matters, because the alternative is a tool call against a wallet.
    expect(admitStudioCall).not.toHaveBeenCalled();

    // A gate refusal settles INSIDE the claim transaction and is reported to
    // the caller as a settled dispatch carrying the refusal as its result,
    // rather than as a `refused` envelope: the claim already committed this row
    // in this transaction, so the refusal has to settle it here.
    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult?.success).toBe(false);
    expect(outcome.toolResult?.output).toContain("was deleted");
    expect(outcome.toolResult?.output).toContain("no funds moved");

    // Reported as its own cause, NOT folded into `scope_changed`: a deleted
    // project and a re-scoped one have different remedies.
    expect(commitStudioSettlementWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refusalReason: "project_deleted" }),
    );
  });
});

describe("the happy dispatch", () => {
  it("claims the slot under the stop gate, then dispatches with the project wallets", async () => {
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("succeeded");
    expect(outcome.toolResult).toEqual({ success: true, output: "sent" });

    // Gate first, claim second: taking the intent row before the control
    // requests would invert the global lock order.
    expect(acquireSessionControlLock).toHaveBeenCalledTimes(1);
    expect(gateOnOperatorStopWithClient).toHaveBeenCalledTimes(1);
    expect(casClaimStudioDispatchSlotWith).toHaveBeenCalledWith(
      expect.anything(),
      APPROVAL_ID,
    );

    // The wallet resolution comes from `project_wallets`, which is
    // AUTHORITATIVE; the backing session's mirrored columns are never read.
    const rebuildContext = requireRecord(
      admitStudioCall.mock.calls[0]?.[1],
      "card rebuild context",
    );
    expect(rebuildContext.approved).toBe(false);
    const context = requireRecord(
      admitStudioCall.mock.calls[1]?.[1],
      "approved dispatch context",
    );
    expect(context.walletResolution).toEqual({
      source: "session",
      evm: { id: "evm_authoritative", address: "0xAuthoritative" },
      solana: null,
    });
    // The approval, and only the approval, grants `approved: true`.
    expect(context.approved).toBe(true);
    expect(context.approvalId).toBe(APPROVAL_ID);
    expect(context.sourceSurface).toBe("mcp_local");

    // The settlement is stored WHOLE, with the byte size of the stored body.
    const settlement = commitStudioSettlementWith.mock.calls[0]?.[1] as {
      settlementJson: string;
      settlementBytes: number;
      status: string;
    };
    expect(settlement.status).toBe("succeeded");
    expect(JSON.parse(settlement.settlementJson).result).toMatchObject({
      success: true,
      output: "sent",
      data: { txHash: "0xabc" },
    });
    expect(settlement.settlementBytes).toBe(
      Buffer.byteLength(settlement.settlementJson, "utf8"),
    );

    // No transcript, ever.
    expect(commitApprovedToolResult).not.toHaveBeenCalled();
    expect(commitDecisionToolResult).not.toHaveBeenCalled();
  });

  it("carries a CONTROLLED tool failure through as a real answer", async () => {
    scriptApprovedResult({ success: false, output: "insufficient funds" });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult.output).toBe("insufficient funds");
    expect(commitStudioSettlementWith).toHaveBeenCalledTimes(1);
  });

  it("rebuilds and dispatches a protocol envelope through its public Studio name", async () => {
    const args = {
      chain: "base",
      tokenIn: "0x1111111111111111111111111111111111111111",
      tokenOut: "0x2222222222222222222222222222222222222222",
      amountIn: "1",
    };
    const envelope = buildApprovalToolCall("kyberswap__swap__execute", args);
    const preview = buildIntentPreview("kyberswap__swap__execute", args);
    const digest = computeStudioAuthorityDigest({
      envelope,
      preview,
      expiresAt: EXPIRES_AT,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      scopeVersion: 4,
      permission: "full",
    });

    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({
        queue_tool_call: envelope,
        preview_json: preview,
        request_digest: digest,
      }),
    );
    expect(outcome.kind).toBe("dispatched");
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    for (const call of admitStudioCall.mock.calls) {
      const publicCall = requireRecord(call[0], "public Studio call");
      expect(publicCall.name).toBe("kyberswap__swap__execute");
      expect(publicCall.args).toEqual(args);
    }
  });
});

describe("refusals before the dispatch", () => {
  it("does not dispatch when the slot claim misses (generation moved or taken)", async () => {
    casClaimStudioDispatchSlotWith.mockResolvedValue(false);
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(admitStudioCall).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.success).toBe(false);
    expect(outcome.toolResult.output).toMatch(/locked/i);
    expect(outcome.toolResult.output).toMatch(/Nothing was executed/i);
    // TERMINAL, not merely reported: a row left `not_started` would still be
    // dispatchable behind a caller that was already told nothing happened.
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvalId: APPROVAL_ID,
        refusalReason: "generation_superseded",
      }),
    );
  });

  it("does not dispatch when the operator stopped the session", async () => {
    gateOnOperatorStopWithClient.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
      scope: "session",
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(admitStudioCall).not.toHaveBeenCalled();
    // The slot is never claimed on the stopped path - and the row is made
    // TERMINAL in the same gate transaction, because nothing else owns it.
    expect(casClaimStudioDispatchSlotWith).not.toHaveBeenCalled();
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refusalReason: "stopped" }),
    );
    expect(outcome.kind).toBe("dispatched");
  });

  it("does not dispatch when the project scope moved after the decision committed", async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM projects")) {
        return { rows: [{ scope_version: 9, deleted_at: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/permission or wallet selection changed/i);
    // The claim already committed the row to `dispatching`, so the refusal has
    // to settle it in the SAME transaction: a gate never commits a claim it
    // refuses.
    expect(commitStudioSettlementWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", refusalReason: "scope_changed" }),
    );
  });

  it("refuses on a request-digest mismatch, without throwing", async () => {
    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({ request_digest: "a-digest-of-something-else" }),
    );
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/no longer matches/i);
    // A refusal is still a SETTLEMENT: the slot was claimed, so the row must
    // leave `dispatching` rather than sit there for the reconciler.
    expect(commitStudioSettlementWith).toHaveBeenCalledTimes(1);
  });

  it("refuses when expiry changed after enqueue", async () => {
    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({ expires_at: "2026-08-23T12:00:00.000Z" }),
    );
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/no longer matches/i);
  });

  it("refuses a co-edited card even when its authority digest was recomputed", async () => {
    const tamperedPreview = {
      ...PREVIEW,
      criticalArgs: { ...PREVIEW.criticalArgs, safety: "safe" },
    };
    const tamperedDigest = computeStudioAuthorityDigest({
      envelope: ENVELOPE,
      preview: tamperedPreview,
      expiresAt: EXPIRES_AT,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      scopeVersion: 4,
      permission: "full",
    });
    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({
        preview_json: tamperedPreview,
        request_digest: tamperedDigest,
      }),
    );
    // The unapproved call rebuilds the live card, but the approved mutator is
    // never entered because the complete card has an added field.
    expect(admitStudioCall).toHaveBeenCalledTimes(1);
    const context = requireRecord(
      admitStudioCall.mock.calls[0]?.[1],
      "card rebuild context",
    );
    expect(context.approved).toBe(false);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/complete approval card/i);
  });

  it("refuses on a manifest-fingerprint mismatch", async () => {
    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({
        queue_tool_call: {
          command: "execute_tool",
          args: { toolId: "kyberswap.swap.execute", params: {} },
          vex: {
            v: 2,
            originalToolName: "kyberswap__swap__execute",
            manifestFingerprint: "stale-fingerprint",
          },
        },
        request_digest: null,
      }),
    );
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.success).toBe(false);
    expect(outcome.toolResult.output).toMatch(/Nothing was executed/i);
  });
});

describe("failures after the dispatch", () => {
  it("records `indeterminate` and does NOT retry when the dispatch throws", async () => {
    scriptApprovedThrow(new Error("provider exploded"));
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    // ONE statement: status AND settlement together, because the settlement
    // CAS is fenced on `dispatching`, which a prior status flip would have left.
    expect(casMarkIndeterminateWithSettlementWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvalId: APPROVAL_ID }),
    );
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "dispatched") return;
    // The REPORTED status is the durable one. `failed` here would invite the
    // one retry that must never happen.
    expect(outcome.executionStatus).toBe("indeterminate");
    expect(outcome.toolResult.output).toMatch(/cannot prove whether it took effect/i);
    expect(outcome.toolResult.output).toMatch(/NOT be retried/i);
  });

  it("records `indeterminate` when the settlement WRITE fails after a real dispatch", async () => {
    commitStudioSettlementWith.mockImplementation(async (_c: unknown, input: { status: string }) => {
      if (input.status === "succeeded") throw new Error("write failed");
      return true;
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(casMarkIndeterminateWithSettlementWith).toHaveBeenCalledTimes(1);
    // The preserved OUTPUT rides with the status, in that one statement.
    const preserved = casMarkIndeterminateWithSettlementWith.mock.calls[0]?.[1] as {
      settlementJson: string;
      settlementBytes: number;
    };
    expect(JSON.parse(preserved.settlementJson).result.output).toBe("sent");
    expect(preserved.settlementBytes).toBe(
      Buffer.byteLength(preserved.settlementJson, "utf8"),
    );
    // Never dispatched twice: the call already ran, and an unprovable outcome
    // is not a reason to run it again.
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("indeterminate");
  });

  it("does not overwrite a terminal verdict when the fenced CAS misses, and REPORTS THE WINNER", async () => {
    commitStudioSettlementWith.mockResolvedValue(false);
    // The row left `dispatching` underneath this writer: the reconciler
    // declared it indeterminate. That is the answer; ours is a belief about a
    // write that never landed.
    getStudioSettlementByApprovalId.mockResolvedValue({
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      decision: "approved",
      decisionReason: null,
      refusalReason: null,
      executionStatus: "indeterminate",
      settlement: { v: 1, result: { success: false, output: "reconciled by the sweep" } },
      settlementBytes: 60,
      expiresAt: null,
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(outcome.kind).toBe("dispatched");
    // One attempt, no escalation, no second settlement.
    expect(commitStudioSettlementWith).toHaveBeenCalledTimes(1);
    expect(commitApprovedToolResult).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("indeterminate");
    expect(outcome.toolResult.output).toBe("reconciled by the sweep");
    expect(outcome.toolResult.success).toBe(false);
  });

  it("reports UNCONFIRMED, not `succeeded`, when the lost CAS's row cannot be read", async () => {
    commitStudioSettlementWith.mockResolvedValue(false);
    getStudioSettlementByApprovalId.mockRejectedValue(new Error("db down"));
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    if (outcome.kind !== "dispatched") return;
    // The dispatch RAN, so the honest status is the one that says the outcome
    // is unknown - never the `succeeded` this writer intended to commit.
    expect(outcome.executionStatus).toBe("indeterminate");
    expect(outcome.toolResult.output).toMatch(/could neither prove its outcome nor record one/i);
    expect(outcome.toolResult.output).toMatch(/NOT be retried/i);
  });

  it("retries the indeterminate STATUS WRITE, bounded, and never the dispatch", async () => {
    scriptApprovedThrow(new Error("provider exploded"));
    casMarkIndeterminateWithSettlementWith
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValue(true);
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(casMarkIndeterminateWithSettlementWith).toHaveBeenCalledTimes(2);
    // The retried thing is a status write on a row whose dispatch already ran.
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("indeterminate");
  });

  it("does NOT claim `indeterminate` when the status write never committed", async () => {
    scriptApprovedThrow(new Error("provider exploded"));
    casMarkIndeterminateWithSettlementWith.mockRejectedValue(new Error("db down"));
    getStudioSettlementByApprovalId.mockResolvedValue({
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      decision: "approved",
      decisionReason: null,
      refusalReason: null,
      // Still mid-flight: nothing terminal committed for this row.
      executionStatus: "dispatching",
      settlement: null,
      settlementBytes: null,
      expiresAt: null,
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    // Bounded: three attempts, then it stops. No dispatch retry, ever.
    expect(casMarkIndeterminateWithSettlementWith).toHaveBeenCalledTimes(3);
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "dispatched") return;
    // The text says the outcome is BOTH unknown and unrecorded, rather than
    // asserting a durable `indeterminate` that does not exist.
    expect(outcome.toolResult.output).toMatch(/could neither prove its outcome nor record one/i);
  });

  it("reports the durable winner when the status write LOST the CAS", async () => {
    scriptApprovedThrow(new Error("provider exploded"));
    casMarkIndeterminateWithSettlementWith.mockResolvedValue(false);
    getStudioSettlementByApprovalId.mockResolvedValue({
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      decision: "approved",
      decisionReason: null,
      refusalReason: null,
      executionStatus: "failed",
      settlement: { v: 1, result: { success: false, output: "settled by the other writer" } },
      settlementBytes: 60,
      expiresAt: null,
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    // A `false` CAS is NOT retryable: the predicate requires `dispatching` and
    // the row has left it.
    expect(casMarkIndeterminateWithSettlementWith).toHaveBeenCalledTimes(1);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult.output).toBe("settled by the other writer");
  });
});

describe("a refusal that did not commit is never reported as one", () => {
  it("reports the durable winner when the pre-dispatch refusal lost its CAS", async () => {
    setStudioDispatchPreflight(() => false);
    casRefuseStudioBeforeDispatchWith.mockResolvedValue(false);
    getStudioSettlementByApprovalId.mockResolvedValue({
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      decision: "approved",
      decisionReason: null,
      refusalReason: null,
      executionStatus: "succeeded",
      settlement: { v: 1, result: { success: true, output: "the other dispatcher sent it" } },
      settlementBytes: 60,
      expiresAt: null,
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    // The refusal DID NOT HAPPEN. Reporting it would tell an external agent
    // nothing ran while the row says something did.
    expect(outcome.executionStatus).toBe("succeeded");
    expect(outcome.toolResult.success).toBe(true);
    expect(outcome.toolResult.output).toBe("the other dispatcher sent it");
  });

  it("says the answer is UNCONFIRMED when the refusal did not commit and the row is not terminal", async () => {
    setStudioDispatchPreflight(() => false);
    casRefuseStudioBeforeDispatchWith.mockResolvedValue(false);
    getStudioSettlementByApprovalId.mockResolvedValue({
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      decision: "approved",
      decisionReason: null,
      refusalReason: null,
      executionStatus: "dispatching",
      settlement: null,
      settlementBytes: null,
      expiresAt: null,
    });
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/could not record its refusal/i);
    expect(outcome.toolResult.output).toMatch(/may still be pending/i);
    // Nothing dispatched on this path, so it is NOT reported as an unknown
    // effect.
    expect(outcome.executionStatus).toBe("failed");
  });

  it("still reports the refusal when it DID commit", async () => {
    setStudioDispatchPreflight(() => false);
    casRefuseStudioBeforeDispatchWith.mockResolvedValue(true);
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(getStudioSettlementByApprovalId).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult.output).toMatch(/Nothing was executed/i);
  });
});

describe("the commit-time scope check compares against the ENQUEUE version", () => {
  it("refuses when the project moved on, even though the version it just loaded matches itself", async () => {
    // The scope edit committed AFTER the approval snapshot: the project row now
    // says 9 everywhere, and the intent still records 4. Comparing the freshly
    // loaded version with itself would always match and would dispatch under
    // the NEW wallets; the enqueue version is the only value that proves the
    // wallets are the ones the human approved.
    scriptPool([]);
    poolQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM projects")) {
        return [
          {
            id: PROJECT_ID,
            scope_version: 9,
            permission: "full",
            backing_session_id: SESSION_ID,
            deleted_at: null,
          },
        ];
      }
      return [];
    });
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM projects")) {
        return { rows: [{ scope_version: 9, deleted_at: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(admitStudioCall).not.toHaveBeenCalled();
    expect(commitStudioSettlementWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", refusalReason: "scope_changed" }),
    );
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.success).toBe(false);
  });

  it("refuses a Studio row that recorded no enqueue version at all", async () => {
    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({ scope_version_at_enqueue: null }),
    );
    // Nothing may dispatch under authority that cannot be re-proven.
    expect(casClaimStudioDispatchSlotWith).not.toHaveBeenCalled();
    expect(admitStudioCall).not.toHaveBeenCalled();
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refusalReason: "scope_unavailable" }),
    );
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/Nothing was executed/i);
  });

  it("refuses durably when the project scope cannot be read", async () => {
    poolQuery.mockRejectedValue(new Error("db down"));
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(casClaimStudioDispatchSlotWith).not.toHaveBeenCalled();
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refusalReason: "scope_unavailable" }),
    );
    expect(outcome.kind).toBe("dispatched");
  });
});

describe("the dispatch preflight", () => {
  it("refuses BEFORE anything else when the lock fence cannot be proven", async () => {
    setStudioDispatchPreflight(() => false);
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    // Before the scope read and before the gate: the fence is what the whole
    // dispatch decision rests on.
    expect(poolQuery).not.toHaveBeenCalled();
    expect(casClaimStudioDispatchSlotWith).not.toHaveBeenCalled();
    expect(admitStudioCall).not.toHaveBeenCalled();
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refusalReason: "generation_superseded" }),
    );
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/Nothing was executed/i);
  });

  it("dispatches normally when nothing registered a preflight", async () => {
    // The durable generation CAS is the authority in every case but the failed
    // advance, so a headless engine must not be blocked by an absent predicate.
    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("succeeded");
  });

  it("denies a non-signing mutation when lock begins during card rebuild", async () => {
    let allows = true;
    setStudioDispatchPreflight(() => allows);
    admitStudioCall.mockImplementation(async (_call, rawContext) => {
      const context = requireRecord(rawContext, "Studio tool context");
      if (context.approved === true) {
        throw new Error("approved non-signing mutator must not start");
      }
      // This models lockSecretSession's synchronous transition flag landing
      // while a provider-backed preview rebuild was awaiting. The second
      // preflight must observe it before any approved local write begins.
      allows = false;
      return pendingAdmission();
    });

    const args = { network: "solana", token: "So11111111111111111111111111111111111111112" };
    const envelope = buildApprovalToolCall("wallet_track_token", args);
    const preview = buildIntentPreview("wallet_track_token", args);
    const digest = computeStudioAuthorityDigest({
      envelope,
      preview,
      expiresAt: EXPIRES_AT,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      scopeVersion: 4,
      permission: "full",
    });
    const outcome = await applyStudioApproveSideEffects(
      APPROVAL_ID,
      snapshot({
        queue_tool_call: envelope,
        preview_json: preview,
        request_digest: digest,
      }),
    );

    expect(admitStudioCall).toHaveBeenCalledTimes(1);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult.output).toMatch(/lock fence/i);
  });
});

describe("a terminal write that THROWS is handed to the repair owner", () => {
  /**
   * Not a retry of the DISPATCH - never that - but of the WRITE. These three
   * paths used to give up and name the expiry sweep as their floor, which is
   * false for an approved row: that sweep scans `decision IS NULL` only. The
   * row was then left in a state that can still RUN (`not_started`) or that
   * nobody owns (`dispatching`), with the external caller blocked until Vex
   * restarted.
   */
  it("registers the refusal when the OWN-TRANSACTION refusal CAS throws", async () => {
    setStudioDispatchPreflight(() => false);
    casRefuseStudioBeforeDispatchWith.mockRejectedValue(new Error("db down"));

    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(studioWriteRepairCount()).toBe(1);
    // Nothing dispatched, and the caller is told the refusal is UNCONFIRMED
    // rather than being told a clean refusal happened.
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/could not record its refusal/i);
  });

  it("registers the refusal when the whole GATE TRANSACTION throws", async () => {
    // The transaction rolls back: no slot claimed, no refusal written, nothing
    // dispatched - and the row is still `approved/not_started`.
    acquireSessionControlLock.mockRejectedValueOnce(new Error("db down"));

    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(studioWriteRepairCount()).toBe(1);
    expect(casClaimStudioDispatchSlotWith).not.toHaveBeenCalled();
    expect(admitStudioCall).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") return;
    expect(outcome.toolResult.output).toMatch(/Nothing was executed/i);
  });

  it("registers the indeterminate write once its bounded attempts are exhausted", async () => {
    // The dispatch RAN and threw, so the outcome is unprovable; then every
    // attempt at the status write throws too.
    scriptApprovedThrow(new Error("provider exploded"));
    casMarkIndeterminateWithSettlementWith.mockRejectedValue(new Error("db down"));

    const outcome = await applyStudioApproveSideEffects(APPROVAL_ID, snapshot());
    expect(casMarkIndeterminateWithSettlementWith).toHaveBeenCalledTimes(3);
    expect(studioWriteRepairCount()).toBe(1);
    // ONE dispatch, ever. The repair owner replays the write, never the call.
    expect(admitStudioCall).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "dispatched") return;
    expect(outcome.executionStatus).toBe("indeterminate");
  });
});
