import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";

export interface LighterWithdrawalPresentation {
  readonly presentation: "concise_approval" | "concise_progress" | "celebratory_handoff" | "concise_action_required" | "concise_confirmation" | "concise_error";
  readonly message: string;
  readonly userGuidance: string;
  readonly confirmationMessage?: string;
}

export function buildWithdrawalPreparedPresentation(
  amountDisplay: string,
  existingApproval = false,
): LighterWithdrawalPresentation {
  const message = existingApproval
    ? `${amountDisplay} secure withdrawal is already awaiting approval.`
    : `${amountDisplay} secure withdrawal is ready for approval.`;
  return {
    presentation: "concise_approval",
    message,
    userGuidance:
      `Reply briefly: "${message} Review the amount and click Approve if it is correct." Do not include account indexes, API keys, nonces, balances, transaction hashes, wallet addresses, technical preflight details, tables, or unrelated next steps. Do not ask for a typed confirmation.`,
  };
}

export function buildWithdrawalSubmittedPresentation(
  amountDisplay: string,
  withdrawalDelaySeconds: number,
): LighterWithdrawalPresentation {
  const delayDisplay = formatWithdrawalDelay(withdrawalDelaySeconds);
  const message = `🎉 **Your ${amountDisplay} withdrawal is on its way!**

Lighter accepted the withdrawal successfully, and your funds are now moving through its secure withdrawal delay. This usually takes around ${delayDisplay}. The funds haven't reached your Vex wallet yet, but everything is progressing as expected. There's no need to submit the withdrawal again.

Once the delay has passed, I can verify that the funds arrived safely. In the meantime, would you like me to check your withdrawal status, show you what remains in your Lighter account, or help you decide what to do once the funds land?`;
  return {
    presentation: "celebratory_handoff",
    message,
    userGuidance:
      `Reply with exactly this message, preserving its three paragraphs and final question: "${message}" Do not say the funds have reached the wallet, and do not include balances, hashes, addresses, account details, tables, or onboarding. This question is an invitation for the user's next turn: do not check status, fetch balances, or take another action until the user chooses what to do next.`,
  };
}

function formatWithdrawalDelay(withdrawalDelaySeconds: number): string {
  if (!Number.isFinite(withdrawalDelaySeconds) || withdrawalDelaySeconds <= 0) {
    return "a short while";
  }
  if (withdrawalDelaySeconds < 90) return "1 minute";
  const minutes = Math.max(1, Math.round(withdrawalDelaySeconds / 60));
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round((withdrawalDelaySeconds / 3_600) * 10) / 10;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function buildWithdrawalClaimPreparedPresentation(
  amountDisplay: string,
): LighterWithdrawalPresentation {
  const message = `${amountDisplay} is ready for the separate wallet claim approval.`;
  return {
    presentation: "concise_approval",
    message,
    userGuidance:
      `Reply briefly: "${message} Review the amount and click Approve if it is correct." Do not include gas calculations, hashes, addresses, account details, tables, or unrelated next steps.`,
  };
}

export function buildWithdrawalClaimSubmittedPresentation(
  amountDisplay: string,
): LighterWithdrawalPresentation {
  const message = `🎉 ${amountDisplay} claim submitted! Delivery is awaiting final network confirmation.`;
  return {
    presentation: "concise_progress",
    message,
    userGuidance:
      `Reply with exactly this message and nothing else: "${message}" Do not say the funds have arrived, and do not include balances, hashes, addresses, tables, or follow-up questions.`,
  };
}

export function buildWithdrawalStatusPresentation(
  executionState: LighterWithdrawalIntentRow["executionState"],
  amountDisplay: string,
  settlementNetwork: string,
): LighterWithdrawalPresentation {
  if (executionState === "destination_confirmed") {
    const confirmationMessage = `🎉 ${amountDisplay} withdrawal confirmed! The funds have arrived in your wallet.`;
    return {
      presentation: "concise_confirmation",
      message: confirmationMessage,
      confirmationMessage,
      userGuidance:
        `Reply with exactly this confirmation and nothing else: "${confirmationMessage}" Do not include balances, transaction hashes, wallet addresses, claim details, account details, tables, onboarding, or follow-up questions.`,
    };
  }
  if (executionState === "claimable") {
    const message = `🔓 ${amountDisplay} is ready to claim. A separate wallet approval is required for delivery on ${settlementNetwork}.`;
    return {
      presentation: "concise_action_required",
      message,
      userGuidance:
        `Reply with exactly this message and nothing else: "${message}" Do not say the funds have arrived, and do not include balances, hashes, addresses, tables, or unrelated next steps.`,
    };
  }
  if (executionState === "ambiguous") {
    const message = `The ${amountDisplay} withdrawal outcome is still being verified. Please do not retry it yet.`;
    return {
      presentation: "concise_error",
      message,
      userGuidance:
        `Reply with exactly this message and nothing else: "${message}" Do not say it succeeded or failed, and do not include unrelated account details.`,
    };
  }
  if (["failed", "rejected", "expired", "refunded"].includes(executionState)) {
    const message = executionState === "refunded"
      ? `The ${amountDisplay} withdrawal was refunded.`
      : `The ${amountDisplay} withdrawal did not complete.`;
    return {
      presentation: "concise_error",
      message,
      userGuidance:
        `Reply with exactly this message and nothing else: "${message}" Do not include unrelated account details or next steps unless the user asks.`,
    };
  }
  const message = `${amountDisplay} withdrawal is still progressing through Lighter's secure withdrawal process.`;
  return {
    presentation: "concise_progress",
    message,
    userGuidance:
      `Reply with exactly this message and nothing else: "${message}" Do not say delivery is final, and do not include balances, hashes, addresses, tables, or unrelated next steps.`,
  };
}
