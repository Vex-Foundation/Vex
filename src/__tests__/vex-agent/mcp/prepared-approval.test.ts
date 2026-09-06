import { lifecycleIntent } from "../../helpers/lighter-intents.js";
import { requireValue } from "../../helpers/require-value.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPreviewScalar } from "@vex-agent/tools/types.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { deposit, registration, withdrawal, claim, oco, leg } from "./lighter-prepared-fixtures.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
const repos = vi.hoisted(() => ({ fees: vi.fn(), lifecycle: vi.fn(), deposit: vi.fn(), registration: vi.fn(), withdrawal: vi.fn(), claim: vi.fn(), oco: vi.fn() }));
vi.mock("@vex-agent/db/repos/lighter-order-lifecycle-intents.js", () => ({ findByIntentId: repos.lifecycle }));
vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({ findByIntentId: repos.deposit }));
vi.mock("@vex-agent/db/repos/lighter-key-registration-intents.js", () => ({ findLighterKeyRegistrationIntent: repos.registration }));
vi.mock("@vex-agent/db/repos/lighter-withdrawal-intents.js", () => ({ findByIntentId: repos.withdrawal }));
vi.mock("@vex-agent/db/repos/lighter-withdrawal-claims.js", () => ({ findByClaimId: repos.claim }));
vi.mock("@vex-agent/db/repos/lighter-oco-execution-intents.js", () => ({ findByIntentId: repos.oco }));
vi.mock("@vex-agent/db/repos/lighter-fee-authorization-intents.js", () => ({ findLighterFeeAuthorizationIntent: repos.fees }));
const findIntent = vi.fn();
const findPreview = vi.fn();
const handler = vi.fn();
vi.mock("@vex-agent/db/repos/lighter-order-execution-intents.js", () => ({ findByIntentId: (...args: unknown[]) => findIntent(...args) }));
vi.mock("@vex-agent/db/repos/lighter-order-previews.js", () => ({ findById: (...args: unknown[]) => findPreview(...args) }));
vi.mock("@vex-agent/tools/protocols/catalog.js", async (original) => ({
  ...await original<typeof import("@vex-agent/tools/protocols/catalog.js")>(),
  getProtocolHandler: () => handler,
}));
vi.mock("@vex-agent/tools/protocols/runtime/capture.js", () => ({ captureExecution: vi.fn() }));
const { executeStudioTool } = await import("@vex-agent/mcp/executor.js");
const { admitStudioCall } = await import("@vex-agent/mcp/admission.js");
const { buildProjectToolContext } = await import("@vex-agent/mcp/project-context.js");
const { buildCreateApprovalFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/write.js");
const { buildApprovalToolCall, readStudioApprovalToolCall } = await import("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js");
const scope = { projectId: "project-1", backingSessionId: "session-1", scopeVersion: 1,
  permission: "restricted" as const, wallets: { evm: null, solana: null } };
const call = { name: "lighter__order_create_prepare", args: { environment: "rhc" }, toolCallId: "call-1" };
const ORDER_EXPIRY_MS = Date.parse("2030-01-01T00:00:00.000Z");

function previewRow(overrides: Partial<LighterOrderPreviewRow> = {}): LighterOrderPreviewRow {
  return {
    previewId: "lighter-preview-1",
    sessionId: "session-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "12500",
    priceInteger: "299999",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: ORDER_EXPIRY_MS,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-order-preview-v1",
    previewJson: {
      symbol: "ETH",
      marketType: "perp",
      baseAmount: { display: "1.25", integer: "12500", decimals: 4 },
      price: { display: "2999.99", integer: "299999", decimals: 2 },
      quoteNotional: { display: "3749.9875", integer: "3749987500", decimals: 6 },
    },
    liveSourceJson: { source: "live_lighter_public_api" },
    createdAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  } as LighterOrderPreviewRow;
}

function intentRow(
  overrides: Partial<LighterOrderExecutionIntentRow> = {},
): LighterOrderExecutionIntentRow {
  return {
    intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    previewId: "lighter-preview-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "12500",
    priceInteger: "299999",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: ORDER_EXPIRY_MS,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-order-preview-v1",
    ...overrides,
  } as LighterOrderExecutionIntentRow;
}


function pendingIntent(overrides: Partial<LighterOrderExecutionIntentRow> = {}) {
  return intentRow({ approvalStatus: "approval_pending", executionState: "approval_pending", expiresAt: "2030-01-01T00:00:00.000Z", ...overrides });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.values(repos).forEach((repo) => repo.mockReset().mockResolvedValue(null));
  findIntent.mockResolvedValue(pendingIntent());
  findPreview.mockResolvedValue(previewRow());
  handler.mockResolvedValue({ success: true, output: "card available", preparedActionFollowUp: buildCreateApprovalFollowUp(pendingIntent(), previewRow()) });
});
describe("Studio prepared Lighter order approval", () => {
  it.each(["restricted", "full"] as const)("queues the execution target, preserving terms and expiry under %s", async (permission) => {
    const result = await executeStudioTool({ ...scope, permission }, call);
    expect(result.result.pendingApproval).toBe(true);
    expect(result.result.output).not.toContain("card available");
    expect(handler).toHaveBeenCalledTimes(1); // Only prepare; execution stops at the gate.
    expect(result.approvalCall).toEqual({ name: "lighter__order_create", args: { intentId: pendingIntent().intentId }, toolCallId: call.toolCallId });
    expect(result.preparedApproval?.approvalPreview.criticalArgs).toMatchObject({ baseAmountDisplay: "1.25", priceDisplay: "2999.99", marketSymbol: "ETH", environment: "rhc" });
    expect(result.preparedApproval?.expiresAt).toBe(pendingIntent().expiresAt);
    const envelope = buildApprovalToolCall(requireValue(result.approvalCall).name, requireValue(result.approvalCall).args);
    expect(envelope).toMatchObject({ command: "execute_tool", args: { toolId: "lighter.order.create", params: { intentId: pendingIntent().intentId } } });
    const resumed = requireValue(readStudioApprovalToolCall(envelope, call.toolCallId));
    const rebuilt = await admitStudioCall({ name: resumed.toolName, args: resumed.toolArgs, toolCallId: resumed.toolCallId }, buildProjectToolContext(scope));
    expect(rebuilt.preparedApproval).toEqual(result.preparedApproval);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each([null, pendingIntent({ expiresAt: "2000-01-01T00:00:00Z" }), pendingIntent({ executionState: "submitted" })])("refuses an unavailable or stale intent", async (intent) => {
    findIntent.mockResolvedValue(intent);
    const result = await executeStudioTool(scope, call);
    expect(result.result.success).toBe(false);
    expect(result.result.pendingApproval).not.toBe(true);
    expect(findIntent).toHaveBeenCalledWith(scope.backingSessionId, pendingIntent().intentId);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("refuses changed durable order terms", async () => {
    findPreview.mockResolvedValue(previewRow({ priceInteger: "1" }));
    expect((await executeStudioTool(scope, call)).result.pendingApproval).not.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("refuses a forged follow-up before the execution gate", async () => {
    const followUp = buildCreateApprovalFollowUp(pendingIntent(), previewRow());
    handler.mockResolvedValue({ success: true, output: "card available", preparedActionFollowUp: { ...followUp, args: { toolId: "lighter.order.create", params: { intentId: "forged" } } } });
    const result = await executeStudioTool(scope, call);
    expect(result.result.output).toContain("No approval card");
    expect(findIntent).not.toHaveBeenCalled();
  });
  it("does not queue a canceled preparation", async () => {
    const controller = new AbortController();
    handler.mockImplementation(async () => {
      controller.abort();
      return { success: true, output: "card available", preparedActionFollowUp: buildCreateApprovalFollowUp(pendingIntent(), previewRow()) };
    });
    const result = await executeStudioTool(scope, call, controller.signal);
    expect(result.result.pendingApproval).not.toBe(true);
    expect(findIntent).not.toHaveBeenCalled();
  });
  it("keeps execute_tool inaccessible externally", async () => {
    const result = await executeStudioTool(scope, { ...call, name: "execute_tool", args: buildCreateApprovalFollowUp(pendingIntent(), previewRow()).args });
    expect(result.result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

const { cancelFollowUp, modifyFollowUp, cancelAllFollowUp, closePositionFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/order-lifecycle.js");
const { buildDepositApprovalFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/deposit.js");
const { buildKeyRegistrationApprovalFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/key-registration.js");
const { buildApprovalFollowUp, buildClaimApprovalFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/withdrawal.js");
const { buildOcoApprovalFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/oco.js");
const { toInjectedToolName } = await import("@vex-agent/tools/registry/injected-protocol-tools.js");
const { validatePreparedActionFollowUp } = await import("@vex-agent/tools/registry/prepared-action-follow-ups.js");
const snapshot = { clientOrderId: "123", side: "buy", type: "limit", timeInForce: "good-till-time",
  price: "50", initialBaseAmount: "1", remainingBaseAmount: "0.5", filledBaseAmount: "0.5",
  requestedBaseAmount: "0.75", requestedPrice: "51.25", orders: [{ marketIndex: 0, orderId: "123" }],
  position: { symbol: "ETH", side: "long", position: "1", averageEntryPrice: "50" },
  baseAmount: "1", worstAcceptablePrice: "49.5", maxSlippageBps: 100 };
function lifecycle(actionType: LighterOrderLifecycleIntentRow["actionType"]): LighterOrderLifecycleIntentRow {
  return lifecycleIntent({ ...pendingIntent(), intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001",
    actionType, providerOrderId: "123", requestedSide: "sell", requestedBaseAmountInteger: "10000",
    requestedPriceInteger: "4950", providerSnapshotJson: snapshot });
}
const { buildLighterFeeAuthorizationApprovalFollowUp } = await import("@vex-agent/tools/protocols/lighter/handlers/fee-authorization.js");
const feeAuthorization: import("@vex-agent/db/repos/lighter-fee-authorization-intents.js").LighterFeeAuthorizationIntentRow = {
  intentId: "lighter-fees-00000000-0000-4000-8000-000000000001", sessionId: "session-1",
  environment: "core", walletAddress: "0x" + "1".repeat(40), accountIndex: 42, apiKeyIndex: 7,
  approvalStatus: "approval_pending", executionState: "approval_pending", approvalId: null,
  nonceValue: null, txHash: null, txExpiryMs: null, failureReason: null,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"), verifiedAt: null,
  terms: { collectorAccountIndex: 999, collectorL1Address: "0x" + "2".repeat(40),
    maxPerpsMakerFee: 1000, maxPerpsTakerFee: 1000, maxSpotMakerFee: 2500, maxSpotTakerFee: 2500,
    authorizationExpiryMs: Date.parse("2036-01-01T00:00:00.000Z"), revoke: false,
    publicKey: "a".repeat(80), currentTier: "standard", targetTier: "plus",
    exchangeMakerFeeTick: 50, exchangeTakerFeeTick: 50 },
};
const families = [
  { source: "lighter.fees.approve.prepare", row: feeAuthorization, repo: repos.fees, candidate: buildLighterFeeAuthorizationApprovalFollowUp(feeAuthorization) },
  ...([
    ["lighter.order.cancel", "cancel_one", cancelFollowUp],
    ["lighter.order.modify", "modify", modifyFollowUp],
    ["lighter.order.cancelAll", "cancel_all", cancelAllFollowUp],
    ["lighter.position.close", "close_position", closePositionFollowUp],
  ] as const).map(([target, action, build]) => ({ source: `${target}.prepare`, row: lifecycle(action), repo: repos.lifecycle, candidate: build(lifecycle(action)) })),
  { source: "lighter.deposit.prepare", row: deposit, repo: repos.deposit, candidate: buildDepositApprovalFollowUp(deposit) },
  { source: "lighter.key.register.prepare", row: registration, repo: repos.registration, candidate: buildKeyRegistrationApprovalFollowUp(registration) },
  { source: "lighter.withdraw.prepare", row: withdrawal, repo: repos.withdrawal, candidate: buildApprovalFollowUp(withdrawal) },
  { source: "lighter.withdraw.claim.prepare", row: claim, repo: repos.claim, candidate: buildClaimApprovalFollowUp(claim) },
  { source: "lighter.position.protect", row: oco, repo: repos.oco, candidate: buildOcoApprovalFollowUp(oco, leg("stop-loss"), leg("take-profit")) },
];
function prepareFamily(family: typeof families[number]) {
  findIntent.mockResolvedValue(null);
  findPreview.mockImplementation(async (_session, _env, id) => leg(id === "sl" ? "stop-loss" : "take-profit"));
  family.repo.mockResolvedValue(family.row);
  handler.mockResolvedValue({ success: true, output: "prepared", preparedActionFollowUp: family.candidate });
  const args: Record<string, Record<string, unknown>> = {
    "lighter.order.cancel.prepare": { marketId: 0, orderId: "123" },
    "lighter.order.modify.prepare": { marketId: 0, orderId: "123", totalBaseAmountIn: "1", price: "49.5" },
    "lighter.order.cancelAll.prepare": {},
    "lighter.position.close.prepare": { marketId: 0, slippageBps: 100 },
    "lighter.deposit.prepare": { amountIn: "1" },
    "lighter.key.register.prepare": {},
    "lighter.fees.approve.prepare": {},
    "lighter.withdraw.prepare": { amountIn: "2" },
    "lighter.withdraw.claim.prepare": { intentId: withdrawal.intentId },
    "lighter.position.protect": { marketId: 0, orderExpiryOffsetMinutes: 10, side: "sell", baseAmountIn: "1", stopLossTriggerPrice: "2900", stopLossPrice: "2850", takeProfitTriggerPrice: "3300", takeProfitPrice: "3250" },
  };
  return { name: toInjectedToolName(family.source), args: requireValue(args[family.source]), toolCallId: "family-call" };
}
describe.each(families)("Studio handoff: $source", (family) => {
  it.each(["restricted", "full"] as const)("queues and rebuilds exact terms with %s permissions without executing", async (permission) => {
    const input = prepareFamily(family);
    const result = await executeStudioTool({ ...scope, permission }, input);
    expect(result.result.pendingApproval, result.result.output).toBe(true);
    expect(result.preparedApproval).toEqual(family.candidate);
    expect(result.approvalCall).toEqual({ name: toInjectedToolName(String(family.candidate.args.toolId)), args: family.candidate.args.params, toolCallId: input.toolCallId });
    expect(handler).toHaveBeenCalledTimes(1);
    const resumed = await admitStudioCall(requireValue(result.approvalCall), buildProjectToolContext(scope));
    expect(resumed.preparedApproval).toEqual(result.preparedApproval);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "expired", "other-session", "submitted"])("refuses %s durable state", async (condition) => {
    const input = prepareFamily(family);
    const changes = condition === "expired" ? { expiresAt: new Date(0) }
      : condition === "other-session" ? { sessionId: "another-session" } : { executionState: "submitted", state: "submitted" };
    family.repo.mockResolvedValue(condition === "missing" ? null : { ...family.row, ...changes });
    expect((await executeStudioTool(scope, input)).result.pendingApproval).not.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("rejects changed card terms between preparation and enqueue", async () => {
    const input = prepareFamily(family);
    handler.mockResolvedValue({ success: true, output: "prepared", preparedActionFollowUp: {
      ...family.candidate, expiresAt: "2030-01-01T01:00:00.000Z",
    } });
    expect((await executeStudioTool(scope, input)).result.pendingApproval).not.toBe(true);
  });
});

it("refuses a lifecycle intent belonging to a different action", async () => {
  const input = prepareFamily(requireValue(families.find((family) => family.source === "lighter.order.cancel.prepare")));
  repos.lifecycle.mockResolvedValue(lifecycle("modify"));
  expect((await executeStudioTool(scope, input)).result.pendingApproval).not.toBe(true);
});
it("preserves the confirmed allowance recovery path without accepting a submitted deposit", async () => {
  const family = requireValue(families.find((f) => f.source === "lighter.deposit.prepare"));
  const input = prepareFamily(family);
  const recovery = { ...deposit, executionState: "approve_confirmed", approveTxHash: "0xabc", approveTxFrom: deposit.walletAddress,
    approveTxNonce: "1", depositTxHash: null, depositTxFrom: null, depositTxNonce: null,
    depositReplacementTxHash: null, depositL1BlockHash: null, lighterTxHash: null, failureReason: null };
  repos.deposit.mockResolvedValue(recovery);
  expect((await executeStudioTool(scope, input)).result.pendingApproval).toBe(true);
  repos.deposit.mockResolvedValue({ ...recovery, depositTxHash: "0xdef" });
  expect((await executeStudioTool(scope, input)).result.pendingApproval).not.toBe(true);
});
it.each<Record<string, ApprovalPreviewScalar>>([{ reduceOnly: false }, { groupingType: "anything" }, { stopLossPriceInteger: "0" }, { intentId: "other" }, { marketType: "spot" }])("rejects malformed OCO terms", (changes) => {
  const candidate = buildOcoApprovalFollowUp(oco, leg("stop-loss"), leg("take-profit"));
  const forged = { ...candidate, approvalPreview: { ...candidate.approvalPreview, criticalArgs: { ...candidate.approvalPreview.criticalArgs, ...changes } } };
  expect(validatePreparedActionFollowUp("lighter.position.protect", forged).ok).toBe(false);
});
it("covers every exported Lighter execution target and every protocol handler", async () => {
  const { LIGHTER_WRITE_TOOLS } = await import("@vex-agent/tools/protocols/lighter/manifests/write.js");
  const { LIGHTER_READ_TOOLS } = await import("@vex-agent/tools/protocols/lighter/manifests/read.js");
  const { LIGHTER_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers.js");
  const targets = LIGHTER_WRITE_TOOLS.filter((tool) => tool.actionKind !== "approval_prepare").map((tool) => tool.toolId).sort();
  expect(targets).toEqual([...new Set(["lighter.order.create", ...families.map((family) => family.candidate.args.toolId)])].sort());
  for (const tool of [...LIGHTER_READ_TOOLS, ...LIGHTER_WRITE_TOOLS]) expect(LIGHTER_HANDLERS[tool.toolId]).toBeTypeOf("function");
});
it("refuses a changed OCO child preview before enqueue", async () => {
  const input = prepareFamily(requireValue(families.find((f) => f.source === "lighter.position.protect")));
  findPreview.mockResolvedValue({ ...leg("stop-loss"), priceInteger: "1" });
  expect((await executeStudioTool(scope, input)).result.pendingApproval).not.toBe(true);
});
