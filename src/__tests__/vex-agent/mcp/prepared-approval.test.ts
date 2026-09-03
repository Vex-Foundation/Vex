import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
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
    const envelope = buildApprovalToolCall(result.approvalCall!.name, result.approvalCall!.args);
    expect(envelope).toMatchObject({ command: "execute_tool", args: { toolId: "lighter.order.create", params: { intentId: pendingIntent().intentId } } });
    const resumed = readStudioApprovalToolCall(envelope, call.toolCallId)!;
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
