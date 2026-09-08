import { beforeEach, describe, expect, it, vi } from "vitest";

import { orderExecutionIntent } from "../../helpers/lighter-intents.js";

import { lighterOrderFeeCriticalArgs } from "@tools/lighter/order-fee-terms.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  getAuditIntent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: mocks.getApproval,
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: mocks.getAuditIntent,
}));

const { assertLighterOrderCreateApprovalBinding } = await import(
  "@vex-agent/tools/protocols/lighter/approval-binding.js"
);

const INTENT_ID = "lighter-order-00000000-0000-4000-8000-000000000001";

const INTENT = orderExecutionIntent({
  intentId: INTENT_ID,
  previewId: "preview-1",
  environment: "core",
  accountIndex: 42,
  apiKeyIndex: 4,
  marketIndex: 1,
  baseAmountInteger: "1000",
  priceInteger: "250000",
  credentialRefJson: {
    kind: "encrypted_vault_reference", environment: "core", accountIndex: 42, apiKeyIndex: 4,
    vaultCredentialId: "lighter/core/account-42/api-key-4",
  },
});

/** The exact card the trusted prepared-action enqueue stores today. */
function currentCriticalArgs(
  intent: LighterOrderExecutionIntentRow,
): Record<string, unknown> {
  return {
    toolId: "lighter.order.create",
    intentId: intent.intentId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    marketType: "perp",
    marketSymbol: "ETH",
    side: intent.side,
    baseAmountInteger: intent.baseAmountInteger,
    baseAmountDisplay: "0.001 ETH",
    priceInteger: intent.priceInteger,
    priceDisplay: "2500 USDC",
    triggerPriceInteger: intent.triggerPriceInteger,
    triggerPriceDisplay: null,
    orderType: intent.orderType,
    timeInForce: intent.timeInForce,
    reduceOnly: intent.reduceOnly,
    previewId: intent.previewId,
    matchHash: intent.matchHash,
    orderExpiryIso: new Date(intent.orderExpiryMs).toISOString(),
    orderSummary: "Buy 0.001 ETH at 2500 USDC.",
    notionalDisplay: "2.5 USDC",
    ...lighterOrderFeeCriticalArgs(intent.integratorFees),
  };
}

function approvalCard(criticalArgs: Record<string, unknown>): void {
  const args = criticalArgs;
  mocks.getApproval.mockResolvedValue({
    status: "approved",
    toolCall: {
      command: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId: INTENT_ID },
      },
    },
  });
  mocks.getAuditIntent.mockResolvedValue({
    sessionId: "session-1",
    decision: "approved",
    actionKind: "external_post",
    executionStatus: "dispatching",
    previewJson: {
      namespace: "lighter",
      toolName: "order.create",
      criticalArgs: args,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lighter order-create approval binding", () => {
  it("binds the current card to the prepared execution intent", async () => {
    approvalCard(currentCriticalArgs(INTENT));
    await expect(
      assertLighterOrderCreateApprovalBinding({
        approvalId: "approval-1",
        sessionId: "session-1",
        intent: INTENT,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a card without the trigger-price keys, unattributed or not", async () => {
    // Reproducer for the deleted `legacyNonProtective` shim: a card missing
    // triggerPriceInteger / triggerPriceDisplay used to be accepted whenever the
    // intent carried no fees and no trigger price. No such approval was ever
    // shipped, and accepting one means signing against a card the human never
    // saw those fields on.
    const args = currentCriticalArgs(INTENT);
    delete args.triggerPriceInteger;
    delete args.triggerPriceDisplay;
    approvalCard(args);
    await expect(
      assertLighterOrderCreateApprovalBinding({
        approvalId: "approval-1",
        sessionId: "session-1",
        intent: INTENT,
      }),
    ).rejects.toThrow(/does not match the prepared execution intent/);
  });

  it("refuses a fee-bearing intent approved on a card that omits the fee keys", async () => {
    const feeIntent: LighterOrderExecutionIntentRow = {
      ...INTENT,
      integratorFees: {
        integratorAccountIndex: 743799,
        integratorMakerFee: 1000,
        integratorTakerFee: 1000,
      },
    };
    approvalCard(currentCriticalArgs(INTENT));
    await expect(
      assertLighterOrderCreateApprovalBinding({
        approvalId: "approval-1",
        sessionId: "session-1",
        intent: feeIntent,
      }),
    ).rejects.toThrow(/does not match the prepared execution intent/);
  });

  it("refuses a card whose trigger price does not match the intent", async () => {
    const triggerIntent: LighterOrderExecutionIntentRow = {
      ...INTENT,
      triggerPriceInteger: "240000",
    };
    approvalCard(currentCriticalArgs(INTENT));
    await expect(
      assertLighterOrderCreateApprovalBinding({
        approvalId: "approval-1",
        sessionId: "session-1",
        intent: triggerIntent,
      }),
    ).rejects.toThrow(/does not match the prepared execution intent/);
  });
});
