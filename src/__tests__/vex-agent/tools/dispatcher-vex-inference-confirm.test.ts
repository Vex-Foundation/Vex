/**
 * `VexInferenceDepositConfirm` through the REAL dispatcher (`dispatchTool` ->
 * `routeInternalTool` -> the handler -> the approval binding), the real
 * enqueue preview builder and the real rejection hook, with a fake host that
 * keeps the main-process contract (single-use, session-bound intents; rule
 * coverage; retirement) and in-memory approval rows.
 *
 * Proves (R1): the generic restricted gate never raises a thin card for this
 * tool; a direct model call is refused by name and signs nothing, with or
 * without a prior prepare and after a rejected card; a rule-covered
 * follow-up reaches the rule path and executes once without a card; an
 * approved resume signs only when its approval is bound to this intent's
 * complete card.
 *
 * Does not prove the main-process authority table (`vex-app` suites) or the
 * enqueue transaction (Postgres).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./_dispatcher-test-mocks.js";

const approvals = new Map<string, { id: string; sessionId: string; toolCall: Record<string, unknown> }>();
const cards = new Map<string, { previewJson: unknown }>();
vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: async (id: string, sessionId: string) => {
    const row = approvals.get(id);
    return row !== undefined && row.sessionId === sessionId ? row : null;
  },
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: async (id: string) => cards.get(id) ?? null,
}));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ markAutoRetryUnsafe: vi.fn() }));
vi.mock("@vex-agent/tools/dispatcher/plan-acceptance-gate.js", () => ({ checkPlanAcceptanceDeny: vi.fn(async () => null) }));
const withTransaction = vi.fn(async (..._args: unknown[]): Promise<never> => {
  throw new Error("the enqueue transaction must not be reached");
});
vi.mock("@vex-agent/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTransaction: (...args: unknown[]) => withTransaction(...args),
}));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const { makeTestContext } = await import("./_test-context.js");
const { registerVexInferenceHost, resetVexInferenceHost } = await import("@vex-agent/tools/internal/vex-inference/host.js");
const { retireDepositIntentOfRejectedApproval } = await import("@vex-agent/tools/internal/vex-inference/approval-binding.js");
const { VEX_INFERENCE_DEPOSIT_CARD_KEYS } = await import("@vex-agent/tools/internal/vex-inference/card.js");
const { buildApprovalIntentPreview, enqueueApprovalIntentWithGate } = await import("@vex-agent/engine/core/approval-runtime/enqueue.js");
const { buildApprovalToolCall } = await import("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js");
const { allowVexCloudDevOverride } = await import("../../../lib/vex-cloud-endpoint.js");
import type {
  AgentDepositConfirmRequest,
  AgentDepositIntentView,
  VexInferenceHost,
} from "@vex-agent/tools/internal/vex-inference/host.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

const SESSION = "test-session";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const DEPOSIT = "0x00000000000000000000000000000000000D3905";
const CONFIRM = "VexInferenceDepositConfirm";

function intentView(intentId: string): AgentDepositIntentView {
  const amount = { wei: "6000000000000000000000", vex: "6000", usdMicroEstimate: "6000000", usdEstimate: "6" };
  return {
    intentId,
    chainId: 4663,
    token: { address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", symbol: "VEX", decimals: 18 },
    amount,
    requested: { unit: "VEX", value: "6000" },
    from: WALLET,
    depositAddress: DEPOSIT,
    minimum: { wei: "5000000000000000000000", vex: "5000", usdMicroEstimate: "5000000", usdEstimate: "5" },
    networkFee: { gasLimit: "180000", maxFeePerGasWei: "40000000", maxPriorityFeePerGasWei: "0", maxNetworkFeeWei: "7200000000000", nativeSymbol: "ETH", nativeDecimals: 18 },
    walletVex: amount,
    preparedAt: "2026-10-21T12:00:00.000Z",
    expiresAt: "2099-10-21T12:10:00.000Z",
    autoTopUp: { covered: false, reason: "no auto top-up rule exists" },
  };
}

/** The main-process contract in miniature: intents are single use, session bound, retirable; a rule may cover. */
class FakeHost implements VexInferenceHost {
  readonly intents = new Map<string, { sessionId: string; view: AgentDepositIntentView }>();
  readonly confirms: AgentDepositConfirmRequest[] = [];
  signed = 0;
  ruleCovers = false;

  seed(intentId: string): AgentDepositIntentView {
    const view = intentView(intentId);
    this.intents.set(intentId, { sessionId: SESSION, view });
    return view;
  }
  readStatus = vi.fn(async () => ({ ok: false as const, refusal: { kind: "unavailable", detail: "not in this test" } }));
  prepareAgentDeposit = vi.fn(async () => ({ ok: false as const, refusal: { kind: "unavailable", detail: "not in this test" } }));
  peekAgentDeposit(sessionId: string, intentId: string) {
    const found = this.intents.get(intentId);
    if (found === undefined || found.sessionId !== sessionId) {
      return { ok: false as const, refusal: { kind: "proposal_missing", detail: "No such prepared deposit in this session." } };
    }
    return { ok: true as const, value: found.view };
  }
  retireAgentDeposit(sessionId: string, intentId: string): void {
    if (this.intents.get(intentId)?.sessionId === sessionId) this.intents.delete(intentId);
  }
  async confirmAgentDeposit(request: AgentDepositConfirmRequest) {
    this.confirms.push(request);
    const found = this.intents.get(request.intentId);
    if (found === undefined) return { ok: false as const, refusal: { kind: "proposal_missing", detail: "already used" } };
    let authority: "approved_card" | "full_permission" | "auto_top_up_rule";
    if (request.authority.kind === "approved_card") authority = "approved_card";
    else if (request.authority.kind === "full_permission") authority = "full_permission";
    else if (this.ruleCovers) authority = "auto_top_up_rule";
    else return { ok: true as const, value: { kind: "needs_user_approval" as const, reason: "no active auto top-up rule covers it", intent: found.view } };
    this.intents.delete(request.intentId);
    this.signed += 1;
    return {
      ok: true as const,
      value: {
        kind: "executed" as const,
        status: "confirmed" as const,
        txHash: `0x${"ab".repeat(32)}`,
        transferProven: true,
        notified: true,
        authority,
        ruleId: authority === "auto_top_up_rule" ? "vxrule-00000000-0000-4000-8000-000000000001" : null,
        executionId: "vxexec-00000000-0000-4000-8000-000000000001",
        intent: found.view,
      },
    };
  }
}

let host: FakeHost;
const ENV_KEYS = ["AGENT_PROVIDER", "AGENT_MODEL", "VEX_CLOUD_SESSION_TOKEN", "VEX_DEV_CLOUD_DEPOSIT_ADDRESS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.AGENT_PROVIDER = "vexcloud";
  process.env.AGENT_MODEL = "anthropic/claude-haiku-5.5";
  process.env.VEX_CLOUD_SESSION_TOKEN = "vxs_test_bearer_000000000001";
  process.env.VEX_DEV_CLOUD_DEPOSIT_ADDRESS = DEPOSIT;
  allowVexCloudDevOverride(true);
  host = new FakeHost();
  registerVexInferenceHost(host);
  approvals.clear();
  cards.clear();
  withTransaction.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  allowVexCloudDevOverride(false);
  resetVexInferenceHost();
});

const restricted = (overrides: Parameters<typeof makeTestContext>[0] = {}) => makeTestContext({ sessionPermission: "restricted", ...overrides });
const confirmCall = (intentId: string) => ({ name: CONFIRM, args: { intentId }, toolCallId: "tc-1" });

/** What the turn loop stores when it enqueues the handler's approval request, and the card row it renders. */
function storeApproval(approvalId: string, result: ToolResult, intentId: string) {
  const binding = result.preparedApprovalBinding;
  const toolCall = buildApprovalToolCall(CONFIRM, { intentId }, binding);
  const preview = buildApprovalIntentPreview({ toolName: CONFIRM, toolArgs: { intentId }, result, ...(binding === undefined ? {} : { preparedApprovalBinding: binding }) });
  approvals.set(approvalId, { id: approvalId, sessionId: SESSION, toolCall });
  cards.set(approvalId, { previewJson: preview });
  return { toolCall, preview };
}

describe("VexInferenceDepositConfirm at the dispatcher", () => {
  it("a restricted follow-up with no covering rule raises ONLY the complete card: every money line, never the intentId alone", async () => {
    const view = host.seed("vxdep-00000000-0000-4000-8000-000000000001");
    const result = await dispatchTool(confirmCall(view.intentId), restricted());
    expect(result).toMatchObject({ success: false, pendingApproval: true, actionKind: "user_wallet_broadcast" });
    // The generic gate's line never appears for this tool.
    expect(result.output).not.toMatch(/requires approval - mutating tool/);
    const binding = result.preparedApprovalBinding;
    expect(binding?.resource).toEqual({ table: "vex_inference_agent_deposit_intents", intentId: view.intentId });
    const card = buildApprovalIntentPreview({ toolName: CONFIRM, toolArgs: { intentId: view.intentId }, result, ...(binding === undefined ? {} : { preparedApprovalBinding: binding }) });
    expect(card.toolName).toBe(CONFIRM);
    for (const key of VEX_INFERENCE_DEPOSIT_CARD_KEYS) expect(card.criticalArgs).toHaveProperty(key);
    expect(card.criticalArgs).toMatchObject({ amountWei: view.amount.wei, from: WALLET, depositAddress: DEPOSIT, maxNetworkFeeWei: "7200000000000", expiresAt: view.expiresAt });
    expect(host.signed).toBe(0);
  });

  it("the enqueue refuses a Confirm approval that carries no complete-card binding, before any row is written", async () => {
    const outcome = await enqueueApprovalIntentWithGate(
      {
        sessionId: SESSION,
        missionId: null,
        missionRunId: null,
        permission: "restricted",
        toolName: CONFIRM,
        toolArgs: { intentId: "vxdep-00000000-0000-4000-8000-000000000001" },
        toolCallId: "tc-1",
        result: { success: false, output: "needs approval", pendingApproval: true, actionKind: "user_wallet_broadcast" },
        toolContext: restricted(),
        intentActionKind: "user_wallet_broadcast",
        origin: "agent",
      },
      async () => ({ kind: "clear" }),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "handler_owned_approval_without_binding" });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("a direct model Confirm after the user REJECTED the card is refused by name and nothing is signed, rule or not", async () => {
    const view = host.seed("vxdep-00000000-0000-4000-8000-000000000002");
    const asked = await dispatchTool(confirmCall(view.intentId), restricted());
    expect(asked.pendingApproval).toBe(true);
    const stored = storeApproval("approval-rejected", asked, view.intentId);
    // The rejection path runs the hook with the STORED envelope.
    retireDepositIntentOfRejectedApproval(SESSION, stored.toolCall);

    host.ruleCovers = true;
    const direct = await dispatchTool(confirmCall(view.intentId), restricted({ modelOriginated: true }));
    expect(direct.success).toBe(false);
    expect(direct.pendingApproval).toBeUndefined();
    expect(direct.output).toMatch(/proposal_missing/);
    // Even the engine's own dispatch finds nothing to sign.
    expect((await dispatchTool(confirmCall(view.intentId), restricted())).output).toMatch(/proposal_missing/);
    expect(host.signed).toBe(0);
  });

  it("a direct model Confirm with no prior prepare is refused, and with a live intent is refused BY NAME before the host", async () => {
    const none = await dispatchTool(confirmCall("vxdep-00000000-0000-4000-8000-0000000000ff"), restricted({ modelOriginated: true }));
    expect(none).toMatchObject({ success: false });
    expect(none.pendingApproval).toBeUndefined();
    expect(none.output).toMatch(/proposal_missing/);

    const view = host.seed("vxdep-00000000-0000-4000-8000-000000000003");
    host.ruleCovers = true;
    const live = await dispatchTool(confirmCall(view.intentId), restricted({ modelOriginated: true }));
    expect(live.success).toBe(false);
    expect(live.pendingApproval).toBeUndefined();
    expect(live.preparedApprovalBinding).toBeUndefined();
    expect(live.output).toMatch(/^needs_user_approval: .*do not call VexInferenceDepositConfirm yourself/);
    expect(host.confirms).toHaveLength(0);
    expect(host.signed).toBe(0);
  });

  it("a rule-covered follow-up executes ONCE through the rule authority, without any card", async () => {
    const view = host.seed("vxdep-00000000-0000-4000-8000-000000000004");
    host.ruleCovers = true;
    const result = await dispatchTool(confirmCall(view.intentId), restricted());
    expect(result).toMatchObject({ success: true });
    expect(result.pendingApproval).toBeFalsy();
    expect(result.output).toMatch(/under the user's auto top-up rule vxrule-/);
    expect(host.confirms.map((c) => c.authority)).toEqual([{ kind: "none" }]);
    const again = await dispatchTool(confirmCall(view.intentId), restricted());
    expect(again.output).toMatch(/proposal_missing/);
    expect(host.signed).toBe(1);
  });

  it("an approved resume signs only when its approval is bound to this intent's complete card", async () => {
    const view = host.seed("vxdep-00000000-0000-4000-8000-000000000005");
    const asked = await dispatchTool(confirmCall(view.intentId), restricted());
    const bound = storeApproval("approval-bound", asked, view.intentId);

    // A generic card (no binding, intentId only) never authorizes the transfer.
    approvals.set("approval-thin", { id: "approval-thin", sessionId: SESSION, toolCall: buildApprovalToolCall(CONFIRM, { intentId: view.intentId }) });
    cards.set("approval-thin", { previewJson: { toolName: CONFIRM, criticalArgs: { intentId: view.intentId } } });
    const thin = await dispatchTool(confirmCall(view.intentId), restricted({ approved: true, approvalId: "approval-thin" }));
    expect(thin.output).toMatch(/approval_not_bound/);
    expect(host.signed).toBe(0);

    // A bound approval whose stored card row was edited does not either.
    approvals.set("approval-edited", { id: "approval-edited", sessionId: SESSION, toolCall: bound.toolCall });
    cards.set("approval-edited", { previewJson: { ...bound.preview, criticalArgs: { ...bound.preview.criticalArgs, amountVex: "60" } } });
    expect((await dispatchTool(confirmCall(view.intentId), restricted({ approved: true, approvalId: "approval-edited" }))).output).toMatch(/approval_not_bound/);
    expect(host.signed).toBe(0);

    const approved = await dispatchTool(confirmCall(view.intentId), restricted({ approved: true, approvalId: "approval-bound" }));
    expect(approved).toMatchObject({ success: true });
    expect(host.confirms.at(-1)?.authority).toEqual({ kind: "approved_card", approvalId: "approval-bound" });
    expect(host.signed).toBe(1);
  });
});
