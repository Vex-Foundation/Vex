import { describe, expect, it } from "vitest";

import { lighterLiveOrderCreateUserGuidance } from "@vex-agent/tools/protocols/lighter/handlers/write.js";
import type { ExecuteApprovedLighterCreateOrderResult } from "@vex-agent/tools/protocols/lighter/order-create-execution.js";

function confirmed(
  executionState: Extract<
    ExecuteApprovedLighterCreateOrderResult,
    { status: "provider_confirmed" }
  >["executionState"],
): ExecuteApprovedLighterCreateOrderResult {
  return {
    status: "provider_confirmed",
    intentId: "lighter-exec-1",
    environment: "core",
    executionState,
    signerTxHash: "0xsigner",
    submittedTxHash: "0xsubmitted",
    evidenceSource: "inactive_order",
    clientOrderIndex: "123",
    providerOrderId: "987",
    providerOrderStatus: executionState,
    message: `Lighter provider evidence confirmed order state ${executionState}.`,
  };
}

describe("Lighter live order create user guidance", () => {
  it("reports an open or partially filled order as placed", () => {
    for (const state of ["open", "partially_filled"] as const) {
      const guidance = lighterLiveOrderCreateUserGuidance(confirmed(state));
      expect(guidance).toContain(state);
      expect(guidance.toLowerCase()).toContain("order was placed");
      expect(guidance.toLowerCase()).toContain("on-chain");
      // It steers the model away from the stale preview/preparation framing.
      expect(guidance.toLowerCase()).toContain("do not describe this as a preview");
    }
  });

  it("reports confirmed full fills using execution amounts and average price", () => {
    const guidance = lighterLiveOrderCreateUserGuidance(confirmed("filled"));
    expect(guidance).toContain("fully filled");
    expect(guidance).toContain("filledBaseAmount");
    expect(guidance).toContain("averageExecutionPrice");
    expect(guidance).toContain("not the average fill price");
    expect(guidance).toContain("Do not describe this as a preview");
  });

  it("does not claim final order status from a single trade", () => {
    const result = confirmed("partially_filled");
    if (result.status !== "provider_confirmed") throw new Error("expected confirmed fixture");
    const guidance = lighterLiveOrderCreateUserGuidance({ ...result, evidenceSource: "account_trade" });
    expect(guidance).toContain("trade alone does not prove a partial or full fill");
    expect(guidance).toContain("lighter.order.status");
    expect(guidance).toContain("observed trade size and price");
  });

  it("describes state=open only as an open order, never an open position", () => {
    const guidance = lighterLiveOrderCreateUserGuidance(confirmed("open"));

    expect(guidance.toLowerCase()).toContain("open/resting order");
    expect(guidance.toLowerCase()).not.toContain("open position");
    expect(guidance.toLowerCase()).toContain("position without fill evidence");
  });

  it("reports canceled/rejected orders as not opening a position", () => {
    for (const state of ["canceled", "rejected"] as const) {
      const guidance = lighterLiveOrderCreateUserGuidance(confirmed(state));
      expect(guidance).toContain(state);
      expect(guidance.toLowerCase()).toContain("no position was opened");
    }
  });

  it("reports sequencer_pending as submitted-and-accepted, still settling", () => {
    const guidance = lighterLiveOrderCreateUserGuidance({
      status: "sequencer_pending",
      intentId: "lighter-exec-1",
      environment: "core",
      executionState: "sequencer_pending",
      signerTxHash: "0xsigner",
      submittedTxHash: "0xsubmitted",
      submitCode: 200,
      predictedExecutionTimeMs: 0,
      volumeQuotaRemaining: null,
      evidenceSource: "not_found",
      clientOrderIndex: "123",
      providerOrderId: null,
      providerOrderStatus: null,
      message: "pending",
    });
    expect(guidance.toLowerCase()).toContain("submitted and accepted");
    expect(guidance).toContain("lighter.order.status");
  });

  it("reports ambiguous outcomes as uncertain and never asks to approve again", () => {
    const guidance = lighterLiveOrderCreateUserGuidance({
      status: "ambiguous",
      intentId: "lighter-exec-1",
      environment: "core",
      executionState: "ambiguous",
      reason: "sendtx_failed_after_submit_attempt",
      signerTxHash: "0xsigner",
      message: "ambiguous",
    });
    expect(guidance.toLowerCase()).toContain("uncertain");
    expect(guidance).toContain("lighter.order.status");
    expect(guidance.toLowerCase()).toContain("reconcile");
  });
});
