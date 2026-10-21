/**
 * The three Vex Inference tools at the engine boundary: discovery gating with
 * a typed reason, by-name refusal of every field that could redirect a
 * deposit, the session wallet scope, the trusted card handoff and its
 * validator, and the confirm's authority mapping (approved card, full
 * permission, none -> needs_user_approval, never a thin card for a direct
 * model call).
 *
 * The host is a fake implementing the seam contract; the main-process owners
 * behind it are covered in `vex-app/src/main/vex-cloud/__tests__/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestContext } from "../../_test-context.js";

vi.mock("../../../../../vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => selected.address),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: `scope: ${String(err)}` })),
}));
vi.mock("@vex-agent/db/repos/session-reasoning-effort.js", () => ({
  getSessionReasoningEffort: vi.fn(async () => "medium"),
}));

const selected = { address: "0x1111111111111111111111111111111111111111" };

const { getVisibleToolDefs, defaultVisibilityContext } = await import("@vex-agent/tools/registry/visibility.js");
const { registerVexInferenceHost, resetVexInferenceHost, vexInferenceToolAvailability } = await import("@vex-agent/tools/internal/vex-inference/host.js");
const { handleVexInferenceDepositConfirm, handleVexInferenceDepositPrepare, depositCardArgs } = await import("@vex-agent/tools/internal/vex-inference/deposit.js");
const { handleVexInferenceStatus } = await import("@vex-agent/tools/internal/vex-inference/status.js");
const { validatePreparedActionFollowUp } = await import("@vex-agent/tools/registry/prepared-action-follow-ups.js");
const { allowVexCloudDevOverride } = await import("../../../../../lib/vex-cloud-endpoint.js");
import type { AgentDepositConfirmRequest, AgentDepositIntentView, VexInferenceHost } from "@vex-agent/tools/internal/vex-inference/host.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "@vex-agent/tools/types.js";

const DEPOSIT = "0x00000000000000000000000000000000000D3905";
const NAMES = ["VexInferenceStatus", "VexInferenceDepositPrepare", "VexInferenceDepositConfirm"];

function intent(): AgentDepositIntentView {
  const amount = { wei: "6000000000000000000000", vex: "6000", usdMicroEstimate: "6000000", usdEstimate: "6" };
  return {
    intentId: "vxdep-00000000-0000-4000-8000-000000000001",
    chainId: 4663,
    token: { address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", symbol: "VEX", decimals: 18 },
    amount,
    requested: { unit: "VEX", value: "6000" },
    from: "0x1111111111111111111111111111111111111111",
    depositAddress: DEPOSIT,
    minimum: { wei: "5000000000000000000000", vex: "5000", usdMicroEstimate: "5000000", usdEstimate: "5" },
    networkFee: { gasLimit: "100000", maxFeePerGasWei: "40000000", maxPriorityFeePerGasWei: "0", maxNetworkFeeWei: "4000000000000", nativeSymbol: "ETH", nativeDecimals: 18 },
    walletVex: amount,
    preparedAt: "2026-10-21T12:00:00.000Z",
    expiresAt: "2026-10-21T12:10:00.000Z",
    autoTopUp: { covered: false, reason: "no auto top-up rule exists" },
  };
}

const confirmCalls: AgentDepositConfirmRequest[] = [];
let confirmAnswer: "needs" | "executed" = "needs";
const host: VexInferenceHost = {
  readStatus: vi.fn(async () => ({ ok: false as const, refusal: { kind: "unavailable", detail: "not in this test" } })),
  prepareAgentDeposit: vi.fn(async () => ({ ok: true as const, value: intent() })),
  peekAgentDeposit: vi.fn(() => ({ ok: true as const, value: intent() })),
  confirmAgentDeposit: vi.fn(async (request: AgentDepositConfirmRequest) => {
    confirmCalls.push(request);
    return confirmAnswer === "needs"
      ? { ok: true as const, value: { kind: "needs_user_approval" as const, reason: "no active auto top-up rule covers it", intent: intent() } }
      : { ok: true as const, value: { kind: "executed" as const, status: "confirmed" as const, txHash: `0x${"ab".repeat(32)}`, transferProven: true, notified: true, authority: "approved_card" as const, ruleId: null, executionId: "vxexec-1", intent: intent() } };
  }),
};

const ENV_KEYS = ["AGENT_PROVIDER", "AGENT_MODEL", "VEX_CLOUD_SESSION_TOKEN", "VEX_DEV_CLOUD_DEPOSIT_ADDRESS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.AGENT_PROVIDER = "vexcloud";
  process.env.AGENT_MODEL = "anthropic/claude-haiku-5.5";
  process.env.VEX_CLOUD_SESSION_TOKEN = "vxs_test_bearer_000000000001";
  process.env.VEX_DEV_CLOUD_DEPOSIT_ADDRESS = DEPOSIT;
  allowVexCloudDevOverride(true);
  registerVexInferenceHost(host);
  confirmCalls.length = 0;
  confirmAnswer = "needs";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  allowVexCloudDevOverride(false);
  resetVexInferenceHost();
});

describe("discovery", () => {
  it("offers the three tools only under Vex Inference with a session and a mounted host, each absence with its typed reason", () => {
    const visible = () => getVisibleToolDefs(defaultVisibilityContext()).map((tool) => tool.name).filter((name) => NAMES.includes(name));
    expect(visible()).toEqual(NAMES);
    resetVexInferenceHost();
    expect(vexInferenceToolAvailability()).toEqual({ available: false, reason: "host_not_mounted" });
    expect(visible()).toEqual([]);
    registerVexInferenceHost(host);
    process.env.VEX_CLOUD_SESSION_TOKEN = "";
    expect(vexInferenceToolAvailability()).toEqual({ available: false, reason: "not_signed_in" });
    expect(visible()).toEqual([]);
    process.env.VEX_CLOUD_SESSION_TOKEN = "vxs_test_bearer_000000000001";
    process.env.AGENT_PROVIDER = "openrouter";
    expect(vexInferenceToolAvailability()).toEqual({ available: false, reason: "provider_not_vex_inference" });
    expect(visible()).toEqual([]);
  });

  it("a direct call while unavailable refuses by name and reaches no host", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    const result = await handleVexInferenceDepositPrepare({ amountIn: "6000" }, makeTestContext());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/inference provider is not Vex Inference/);
    expect(host.prepareAgentDeposit).not.toHaveBeenCalled();
  });
});

describe("prepare refuses every redirecting field by name", () => {
  it.each(["to", "destination", "depositAddress", "token", "chain", "chainId", "from", "feeReceiver"])("refuses `%s`", async (key) => {
    vi.mocked(host.prepareAgentDeposit).mockClear();
    const result = await handleVexInferenceDepositPrepare({ amountIn: "6000", [key]: "0x0000000000000000000000000000000000000bad" }, makeTestContext());
    expect(result.success).toBe(false);
    expect(result.output).toContain(`\`${key}\``);
    expect(result.output).toMatch(/pinned in this Vex build/);
    expect(host.prepareAgentDeposit).not.toHaveBeenCalled();
  });

  it("refuses a JSON number amount, an unknown key and a wallet other than the session's", async () => {
    expect((await handleVexInferenceDepositPrepare({ amountIn: 6000 }, makeTestContext())).output).toMatch(/STRING decimal/);
    expect((await handleVexInferenceDepositPrepare({ amountIn: "6000", slippage: "1" }, makeTestContext())).output).toMatch(/unknown parameter `slippage`/);
    const other = await handleVexInferenceDepositPrepare({ amountIn: "6000", walletAddress: "0x2222222222222222222222222222222222222222" }, makeTestContext());
    expect(other.output).toMatch(/not the EVM wallet selected for this session/);
  });

  it("passes only the amount, the session wallet and the session to the host, and hands the card to the trusted confirm", async () => {
    vi.mocked(host.prepareAgentDeposit).mockClear();
    const context = makeTestContext();
    const result = await handleVexInferenceDepositPrepare({ amountIn: "20", denomination: "USD" }, context);
    expect(host.prepareAgentDeposit).toHaveBeenCalledWith(
      { sessionId: context.sessionId, walletAddress: selected.address, amount: { unit: "USD", value: "20" } },
      expect.anything(),
    );
    expect(result.success).toBe(true);
    const followUp = result.preparedActionFollowUp;
    expect(followUp?.toolName).toBe("VexInferenceDepositConfirm");
    expect(followUp?.args).toEqual({ intentId: intent().intentId });
    expect(followUp?.approvalPreview.criticalArgs).toMatchObject({ realFunds: expect.stringContaining("REAL FUNDS"), depositAddress: DEPOSIT, amountVex: "6000", chainId: 4663 });
    if (followUp === undefined) return;
    expect(validatePreparedActionFollowUp("VexInferenceDepositPrepare", followUp).ok).toBe(true);
  });

  it("over MCP there is no follow-up and the summary names the confirm call", async () => {
    const result = await handleVexInferenceDepositPrepare({ amountIn: "6000" }, makeTestContext({ toolLane: "mcp" }));
    expect(result.preparedActionFollowUp).toBeUndefined();
    expect(result.output).toMatch(/Call VexInferenceDepositConfirm with intentId/);
  });
});

describe("the card validator re-derives what could redirect funds", () => {
  const base = (): PreparedActionFollowUp & { approvalPreview: { criticalArgs: Record<string, ApprovalPreviewScalar> } } => ({
    toolName: "VexInferenceDepositConfirm",
    args: { intentId: intent().intentId },
    expiresAt: intent().expiresAt,
    approvalPreview: { toolName: "VexInferenceDepositConfirm", criticalArgs: { ...depositCardArgs(intent()) } },
  });

  it("refuses a card whose deposit address is not the pinned one", () => {
    const card = base();
    card.approvalPreview.criticalArgs.depositAddress = "0x0000000000000000000000000000000000000bad";
    expect(validatePreparedActionFollowUp("VexInferenceDepositPrepare", card)).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("refuses another chain, another token, an extra line, a missing line and a wrong source tool", () => {
    const chain = base();
    chain.approvalPreview.criticalArgs.chainId = 1;
    expect(validatePreparedActionFollowUp("VexInferenceDepositPrepare", chain).ok).toBe(false);
    const token = base();
    token.approvalPreview.criticalArgs.tokenAddress = "0x0000000000000000000000000000000000000bad";
    expect(validatePreparedActionFollowUp("VexInferenceDepositPrepare", token).ok).toBe(false);
    const extra = base();
    extra.approvalPreview.criticalArgs = { ...extra.approvalPreview.criticalArgs, note: "trust me" };
    expect(validatePreparedActionFollowUp("VexInferenceDepositPrepare", extra).ok).toBe(false);
    const missing = base();
    const { minimumVex: _minimum, ...rest } = missing.approvalPreview.criticalArgs;
    missing.approvalPreview.criticalArgs = rest;
    expect(validatePreparedActionFollowUp("VexInferenceDepositPrepare", missing).ok).toBe(false);
    expect(validatePreparedActionFollowUp("WalletSendPrepare", base())).toEqual({ ok: false, reason: "unknown_mapping" });
  });
});

describe("confirm authority", () => {
  const args = { intentId: intent().intentId };

  it("restricted, engine-dispatched, no rule: pendingApproval (the card), nothing else", async () => {
    const result = await handleVexInferenceDepositConfirm(args, makeTestContext({ sessionPermission: "restricted" }));
    expect(result).toMatchObject({ success: false, pendingApproval: true });
    expect(result.output).toMatch(/^needs_user_approval:/);
    expect(result.preparedActionFollowUp).toBeUndefined();
    expect(confirmCalls[0]?.authority).toEqual({ kind: "none" });
  });

  it("a confirm the model called directly never raises a card without its lines", async () => {
    const result = await handleVexInferenceDepositConfirm(args, makeTestContext({ sessionPermission: "restricted", modelOriginated: true }));
    expect(result.pendingApproval).toBeUndefined();
    expect(result.output).toMatch(/^needs_user_approval:.*Call VexInferenceDepositPrepare again/);
  });

  it("maps an approved resume and a full-permission session onto their authorities", async () => {
    confirmAnswer = "executed";
    await handleVexInferenceDepositConfirm(args, makeTestContext({ approved: true, approvalId: "approval-1" }));
    await handleVexInferenceDepositConfirm(args, makeTestContext({ sessionPermission: "full" }));
    expect(confirmCalls.map((call) => call.authority)).toEqual([{ kind: "approved_card", approvalId: "approval-1" }, { kind: "full_permission" }]);
  });

  it("refuses an intent prepared from a wallet that is no longer the session's selection", async () => {
    selected.address = "0x3333333333333333333333333333333333333333";
    try {
      const result = await handleVexInferenceDepositConfirm(args, makeTestContext({ sessionPermission: "full" }));
      expect(result.output).toMatch(/selected for this session is now/);
      expect(confirmCalls).toHaveLength(0);
    } finally {
      selected.address = "0x1111111111111111111111111111111111111111";
    }
  });

  it("refuses an extra key on confirm by name", async () => {
    const result = await handleVexInferenceDepositConfirm({ ...args, to: DEPOSIT }, makeTestContext());
    expect(result.output).toMatch(/Refused: `to`/);
    expect(confirmCalls).toHaveLength(0);
  });
});

describe("status", () => {
  it("refuses a limit above the maximum by name, never clamping it", async () => {
    const result = await handleVexInferenceStatus({ limit: 51 }, makeTestContext());
    expect(result.output).toMatch(/whole number from 1 to 50/);
    expect(host.readStatus).not.toHaveBeenCalled();
  });
});
