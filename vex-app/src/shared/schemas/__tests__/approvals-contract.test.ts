import { describe, expect, it } from "vitest";
import {
  APPROVAL_REASONING_PREVIEW_MAX,
  approvalActionInputSchema,
  approvalActionKindSchema,
  approvalActionResultSchema,
  approvalGetHistoryInputSchema,
  approvalGetInputSchema,
  approvalListPendingAllInputSchema,
  approvalListPendingInputSchema,
  approvalPendingGlobalDtoSchema,
  approvalPermissionSchema,
  approvalStatusSchema,
  approvalSummaryDtoSchema,
} from "../approvals.js";

const SESSION = "00000000-0000-4000-8000-000000000004";
const ISO = "2026-05-21T10:00:00.000Z";

/** A fully-populated global-inbox row (summary fields + sessionTitle). */
function globalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "approval-1",
    sessionId: SESSION,
    toolCallId: "tc-1",
    toolName: "wallet:send",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: ISO,
    resolvedAt: null,
    reasoningPreview: "needs auth",
    actionKind: null,
    riskLevel: null,
    preview: null,
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: "agent",
    projectId: null,
    sessionTitle: "Send ETH to bridge",
    projectName: null,
    ...over,
  };
}

describe("approvals schemas", () => {
  it("approvalStatusSchema accepts pending/approved/rejected only", () => {
    for (const s of ["pending", "approved", "rejected"]) {
      expect(approvalStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(approvalStatusSchema.safeParse("expired").success).toBe(false);
  });

  it("approvalPermissionSchema accepts restricted/full only", () => {
    expect(approvalPermissionSchema.safeParse("restricted").success).toBe(true);
    expect(approvalPermissionSchema.safeParse("full").success).toBe(true);
    expect(approvalPermissionSchema.safeParse("admin").success).toBe(false);
  });

  it("approvalActionKindSchema matches the user-wallet-only taxonomy", () => {
    for (const kind of [
      "read",
      "local_write",
      "schedule",
      "approval_prepare",
      "user_wallet_broadcast",
      "external_post",
      "destructive",
    ]) {
      expect(approvalActionKindSchema.safeParse(kind).success).toBe(true);
    }

    const removedRemoteSigningKind = ["provider", "action", "request"].join(
      "_",
    );
    expect(approvalActionKindSchema.safeParse(removedRemoteSigningKind).success).toBe(
      false,
    );
  });

  it("approvalSummaryDtoSchema parses a fully-populated row", () => {
    // `approval_intents` companion fields are nullable for back-compat:
    // (actionKind, riskLevel, preview, expiresAt, decision, decisionReason,
    // executionStatus). Null here is the "no companion intent" case.
    const parsed = approvalSummaryDtoSchema.safeParse({
      id: "approval-1",
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "wallet:send",
      status: "pending",
      permissionAtEnqueue: "restricted",
      createdAt: ISO,
      resolvedAt: null,
      reasoningPreview: "needs auth",
      actionKind: null,
      riskLevel: null,
      preview: null,
      expiresAt: null,
      decision: null,
      decisionReason: null,
      executionStatus: null,
      origin: "studio_mcp",
      projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(parsed.success).toBe(true);
  });

  it("approvalSummaryDtoSchema rejects extra keys (.strict)", () => {
    const parsed = approvalSummaryDtoSchema.safeParse({
      id: "approval-1",
      sessionId: SESSION,
      toolCallId: null,
      toolName: null,
      status: "pending",
      permissionAtEnqueue: "restricted",
      createdAt: ISO,
      resolvedAt: null,
      reasoningPreview: "ok",
      actionKind: null,
      riskLevel: null,
      preview: null,
      expiresAt: null,
      decision: null,
      decisionReason: null,
      executionStatus: null,
      toolCall: { command: "send", value: "secret-leak" }, // raw JSONB leak attempt
    });
    expect(parsed.success).toBe(false);
  });

  it("reasoningPreview length is bounded", () => {
    const parsed = approvalSummaryDtoSchema.safeParse({
      id: "approval-1",
      sessionId: SESSION,
      toolCallId: null,
      toolName: null,
      status: "pending",
      permissionAtEnqueue: "restricted",
      createdAt: ISO,
      resolvedAt: null,
      reasoningPreview: "x".repeat(APPROVAL_REASONING_PREVIEW_MAX + 1),
      actionKind: null,
      riskLevel: null,
      preview: null,
      expiresAt: null,
      decision: null,
      decisionReason: null,
      executionStatus: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("approvalListPending/get/getHistory inputs require uuid / id", () => {
    expect(
      approvalListPendingInputSchema.safeParse({ sessionId: SESSION }).success,
    ).toBe(true);
    expect(approvalGetInputSchema.safeParse({ id: "approval-1" }).success).toBe(
      true,
    );
    expect(approvalGetInputSchema.safeParse({ id: "" }).success).toBe(false);
    const history = approvalGetHistoryInputSchema.safeParse({ sessionId: SESSION });
    expect(history.success).toBe(true);
    if (history.success) expect(history.data.limit).toBe(20);
  });

  it("approvalActionInput + result Result-typed contract present", () => {
    expect(approvalActionInputSchema.safeParse({ id: "approval-1" }).success).toBe(
      true,
    );
    // Approve/reject results require execution state and cache metadata.
    // The old payload shape is now invalid; the fixture below pins the
    // canonical approve path response.
    expect(
      approvalActionResultSchema.safeParse({
        id: "approval-1",
        status: "approved",
        resolvedAt: ISO,
        runtimeOutcome: "resumed",
        executionStatus: "succeeded",
        missionRunId: "run-1",
        cached: false,
        message: "ok",
      }).success,
    ).toBe(true);
    // Reject path: no dispatch, executionStatus null, mission run optional.
    expect(
      approvalActionResultSchema.safeParse({
        id: "approval-2",
        status: "rejected",
        resolvedAt: ISO,
        runtimeOutcome: "resumed",
        executionStatus: null,
        missionRunId: null,
        cached: false,
        message: "Rejected",
      }).success,
    ).toBe(true);
    // Legacy payload missing required result fields must fail strict parse.
    expect(
      approvalActionResultSchema.safeParse({
        id: "approval-3",
        status: "approved",
        resolvedAt: ISO,
        runtimeOutcome: "resumed",
        message: "ok",
      }).success,
    ).toBe(false);
  });

  // ── Reject reason: the untrusted-input gate ───────────────────────────
  //
  // This schema runs at BOTH boundaries (preload `invokeWithSchema` and the
  // main-side envelope parse), so it is where an over-long or malformed reason
  // is stopped before it can become model-visible transcript text.

  it("accepts an optional reject reason and trims it", () => {
    const parsed = approvalActionInputSchema.safeParse({
      id: "approval-1",
      reason: "  Slippage too high  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reason).toBe("Slippage too high");
  });

  it("rejects a reason over the 500-char bound", () => {
    expect(
      approvalActionInputSchema.safeParse({
        id: "approval-1",
        reason: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      approvalActionInputSchema.safeParse({
        id: "approval-1",
        reason: "x".repeat(500),
      }).success,
    ).toBe(true);
  });

  it("still rejects unknown keys (strict) - reason did not open the object", () => {
    expect(
      approvalActionInputSchema.safeParse({
        id: "approval-1",
        reason: "ok",
        smuggled: "payload",
      }).success,
    ).toBe(false);
  });

  it("`indeterminate` execution status parses (migration 056 widened the CHECK)", () => {
    // If this enum lagged the DB, an approval whose dispatch outcome could not
    // be proven would fail the strict DTO parse and vanish from the renderer
    // instead of being shown as unknown.
    expect(
      approvalActionResultSchema.safeParse({
        id: "approval-4",
        status: "approved",
        resolvedAt: ISO,
        runtimeOutcome: "stopped",
        executionStatus: "indeterminate",
        missionRunId: null,
        cached: true,
        message: "Outcome unknown",
      }).success,
    ).toBe(true);
  });

  it("`deferred_busy` runtime outcome parses", () => {
    expect(
      approvalActionResultSchema.safeParse({
        id: "approval-5",
        status: "approved",
        resolvedAt: ISO,
        runtimeOutcome: "deferred_busy",
        executionStatus: "not_started",
        missionRunId: null,
        cached: false,
        message: "Queued",
      }).success,
    ).toBe(true);
  });
});

describe("approvalPendingGlobalDtoSchema (app-wide inbox)", () => {
  it("parses a row with a session title", () => {
    expect(approvalPendingGlobalDtoSchema.safeParse(globalRow()).success).toBe(
      true,
    );
  });

  it("accepts a null sessionTitle (session-less / deleted-session row)", () => {
    const parsed = approvalPendingGlobalDtoSchema.safeParse(
      globalRow({ sessionId: null, sessionTitle: null }),
    );
    expect(parsed.success).toBe(true);
  });

  it("requires the sessionTitle key (missing → reject)", () => {
    const { sessionTitle: _omit, ...withoutTitle } = globalRow();
    expect(
      approvalPendingGlobalDtoSchema.safeParse(withoutTitle).success,
    ).toBe(false);
  });

  it("rejects a raw tool_call JSONB leak key (.strict on the extension)", () => {
    // Pins Zod 4 `.extend(...).strict()` — the extended shape stays closed, so
    // a smuggled raw-blob key can never ride along with the sanitized DTO.
    const parsed = approvalPendingGlobalDtoSchema.safeParse(
      globalRow({ tool_call: { command: "send", value: "secret-leak" } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects any other unknown key", () => {
    expect(
      approvalPendingGlobalDtoSchema.safeParse(globalRow({ surprise: 1 }))
        .success,
    ).toBe(false);
  });
});

describe("approvalListPendingAllInputSchema", () => {
  it("accepts the empty object", () => {
    expect(approvalListPendingAllInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects any non-empty payload (.strict)", () => {
    expect(
      approvalListPendingAllInputSchema.safeParse({ sessionId: SESSION })
        .success,
    ).toBe(false);
  });
});
