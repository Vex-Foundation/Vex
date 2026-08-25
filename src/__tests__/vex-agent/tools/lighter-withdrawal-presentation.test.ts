import { describe, expect, it } from "vitest";

import {
  buildWithdrawalClaimSubmittedPresentation,
  buildWithdrawalPreparedPresentation,
  buildWithdrawalStatusPresentation,
  buildWithdrawalSubmittedPresentation,
} from "@vex-agent/tools/protocols/lighter/withdrawal-presentation.js";

describe("Lighter withdrawal presentation", () => {
  it("keeps preparation concise and approval-gated", () => {
    const presentation = buildWithdrawalPreparedPresentation("5 USDG");

    expect(presentation).toMatchObject({
      presentation: "concise_approval",
      message: "5 USDG secure withdrawal is ready for approval.",
    });
    expect(presentation.userGuidance).toContain("Do not ask for a typed confirmation");
  });

  it("celebrates submission without claiming final delivery", () => {
    const presentation = buildWithdrawalSubmittedPresentation("5 USDG", 360);

    expect(presentation).toMatchObject({
      presentation: "celebratory_handoff",
      message: expect.stringContaining("🎉 **Your 5 USDG withdrawal is on its way!**"),
    });
    expect(presentation.message).toContain("This usually takes around 6 minutes.");
    expect(presentation.message).toContain("There's no need to submit the withdrawal again.");
    expect(presentation.message).toContain(
      "would you like me to check your withdrawal status, show you what remains in your Lighter account, or help you decide what to do once the funds land?",
    );
    expect(presentation.userGuidance).toContain("Do not say the funds have reached the wallet");
    expect(presentation.userGuidance).toContain("do not check status, fetch balances, or take another action");
  });

  it("describes the reviewed secure delay instead of hardcoding six minutes", () => {
    const presentation = buildWithdrawalSubmittedPresentation("5 USDC", 1_227);

    expect(presentation.message).toContain("This usually takes around 20 minutes.");
  });

  it("marks claim submission as pending final network confirmation", () => {
    const presentation = buildWithdrawalClaimSubmittedPresentation("5 USDG");

    expect(presentation.message).toBe(
      "🎉 5 USDG claim submitted! Delivery is awaiting final network confirmation.",
    );
    expect(presentation.userGuidance).toContain("Do not say the funds have arrived");
  });

  it("celebrates only exact destination-confirmed delivery", () => {
    const presentation = buildWithdrawalStatusPresentation(
      "destination_confirmed",
      "5 USDG",
      "Robinhood Chain mainnet",
    );

    expect(presentation).toMatchObject({
      presentation: "concise_confirmation",
      message: "🎉 5 USDG withdrawal confirmed! The funds have arrived in your wallet.",
      confirmationMessage:
        "🎉 5 USDG withdrawal confirmed! The funds have arrived in your wallet.",
    });
    expect(presentation.userGuidance).toContain("exactly this confirmation and nothing else");
  });

  it("keeps claimable status concise and action-specific", () => {
    const presentation = buildWithdrawalStatusPresentation(
      "claimable",
      "5 USDG",
      "Robinhood Chain mainnet",
    );

    expect(presentation).toMatchObject({
      presentation: "concise_action_required",
      message:
        "🔓 5 USDG is ready to claim. A separate wallet approval is required for delivery on Robinhood Chain mainnet.",
    });
    expect(presentation.userGuidance).toContain("Do not say the funds have arrived");
  });
});
