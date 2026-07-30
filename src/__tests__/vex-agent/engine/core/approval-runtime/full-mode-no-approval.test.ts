/**
 * A9 — AUTONOMY GUARANTEE: a `permission: 'full'` session never enters the
 * approval state machine.
 *
 * Full Autonomous is a product promise, not a convenience: the agent pursues a
 * mission until it is fulfilled, executing mutating actions with no approval
 * card and no confirmation gate. Restrictions live in the tools, not in a
 * runtime prompt. Every change to the approval lifecycle is a chance to leak a
 * gate into that mode by accident, so this suite pins the guarantee at the
 * three places — and only three places — that can ever set `pendingApproval`.
 *
 * `pendingApproval` is the SOLE trigger for `enqueueApprovalIntent`, which is
 * the SOLE writer of the approval state machine (the single transaction that
 * inserts the `approval_queue` row, the `approval_intents` row, and flips the
 * run to `paused_approval` — `turn-loop-tool-batch/approval-stop.ts`). So
 * proving no gate raises `pendingApproval` under `full` proves no queue row, no
 * intent, and no `paused_approval` transition.
 *
 * These tests call the REAL gate functions. They deliberately do not
 * re-implement the predicate: a suite that hand-copied the permission check
 * would stay green while the product had already changed underneath it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWalletSendConfirmHandler = vi.fn();

// Replace ONLY the handler behind a known mutating internal tool, so the real
// routing + approval gate in `dispatcher/protocol-route.ts` runs unchanged and
// we can observe whether it let the call through.
vi.mock("@vex-agent/tools/dispatcher/internal-loaders.js", async () => {
  const actual = await vi.importActual<
    typeof import("@vex-agent/tools/dispatcher/internal-loaders.js")
  >("@vex-agent/tools/dispatcher/internal-loaders.js");
  return {
    ...actual,
    INTERNAL_TOOL_LOADERS: {
      ...actual.INTERNAL_TOOL_LOADERS,
      wallet_send_confirm: async () => mockWalletSendConfirmHandler,
    },
  };
});

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { evaluateApprovalGate } = await import(
  "@vex-agent/tools/protocols/runtime/gates.js"
);
const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const { isMutatingTool } = await import("@vex-agent/tools/registry.js");

// ── Fixtures ────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-0000000000a9";

/** A mutating, non-`local_write` protocol tool — the gate's target shape. */
function mutatingManifest() {
  return {
    mutating: true,
    actionKind: "user_wallet_broadcast",
  } as unknown as Parameters<typeof evaluateApprovalGate>[0];
}

function protocolContext(sessionPermission: "restricted" | "full") {
  return {
    sessionPermission,
    approved: false,
    sessionId: SESSION_ID,
    contextUsageBand: "normal",
    walletResolution: { source: "session", evm: null, solana: null },
    walletPolicy: { kind: "none" },
  } as unknown as Parameters<typeof evaluateApprovalGate>[3];
}

function callGate(sessionPermission: "restricted" | "full") {
  return evaluateApprovalGate(
    mutatingManifest(),
    { toolId: "kyberswap:swap" },
    {}, // not a dryRun preview
    protocolContext(sessionPermission),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

function internalToolContext(sessionPermission: "restricted" | "full") {
  return {
    sessionId: SESSION_ID,
    loadedDocuments: new Map(),
    sessionPermission,
    approved: false,
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    planMode: false,
    contextUsageBand: "normal",
    sourceSurface: "vex_agent",
    sourceSession: SESSION_ID,
    walletResolution: { source: "session", evm: null, solana: null },
    walletPolicy: { kind: "none" },
  } as unknown as Parameters<typeof dispatchTool>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWalletSendConfirmHandler.mockResolvedValue({
    success: true,
    output: "broadcast",
  });
});

// ── The protocol-tool gate ──────────────────────────────────────────────

describe("A9 autonomy guarantee — protocol approval gate", () => {
  it("restricted + mutating → pendingApproval (the gate exists and works)", () => {
    // Control case. Without this, a gate that never fires at all would make
    // every `full` assertion below vacuously true.
    const result = callGate("restricted");

    expect(result).toBeDefined();
    expect(result?.pendingApproval).toBe(true);
  });

  it("full + mutating → NO approval: the gate does not fire", () => {
    const result = callGate("full");

    expect(result).toBeUndefined();
  });

  it("full + the highest-risk action kind → still NO approval", () => {
    // Risk level must not smuggle a gate back into full autonomy. A
    // destructive, wallet-broadcasting action is exactly what full mode exists
    // to let the agent do unattended.
    const manifest = {
      mutating: true,
      actionKind: "destructive",
    } as unknown as Parameters<typeof evaluateApprovalGate>[0];

    const result = evaluateApprovalGate(
      manifest,
      { toolId: "kyberswap:swap" },
      {},
      protocolContext("full"),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(result).toBeUndefined();
  });
});

// ── The internal-tool gate (real dispatcher routing) ────────────────────

describe("A9 autonomy guarantee — internal mutating tool dispatch", () => {
  it("the tool under test really is classified as mutating", () => {
    // Guards the two tests below from silently passing because the registry
    // stopped classifying this tool as mutating.
    expect(isMutatingTool("wallet_send_confirm")).toBe(true);
  });

  it("restricted → pendingApproval and the handler is NOT executed", async () => {
    const result = await dispatchTool(
      { name: "wallet_send_confirm", args: {}, toolCallId: "tc-1" },
      internalToolContext("restricted"),
    );

    expect(result.pendingApproval).toBe(true);
    expect(mockWalletSendConfirmHandler).not.toHaveBeenCalled();
  });

  it("full → executes immediately, NEVER raises pendingApproval", async () => {
    const result = await dispatchTool(
      { name: "wallet_send_confirm", args: {}, toolCallId: "tc-1" },
      internalToolContext("full"),
    );

    // `pendingApproval` is the only trigger for `enqueueApprovalIntent`, which
    // is the only writer of queue row + intent row + `paused_approval`. Absent
    // here means the approval state machine is never entered.
    expect(result.pendingApproval).toBeUndefined();
    expect(mockWalletSendConfirmHandler).toHaveBeenCalledTimes(1);
  });
});
