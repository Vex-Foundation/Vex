/**
 * The ticket gate's onboarding checklist: which of the three steps the chat
 * walks through (first deposit, trading key, fee approval) this session's
 * wallet has already completed.
 *
 * Read-only and address-only. The wallet comes from the session the same way
 * the AI lane resolves it (selected EVM wallet under the session's policy,
 * never a key decrypt); the deposit is the public Lighter account owned by
 * that address; the key is a scope in the unlocked vault for that account;
 * the fee is the same inspection the fee-setup tool runs.
 */

import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import { buildLighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-readers.js";
import type { LighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-status.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";
import { resolveSelectedAddressForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  getLighterOnboardingWorkflow,
  type LighterOnboardingWorkflowRow,
} from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type { LighterOnboardingChecklist } from "@shared/schemas/lighter-trading.js";
import { inspectLighterFeeAuthorization } from "./fee-authorization-preparation.js";
import { listUnlockedLighterTradingCredentialScopes } from "../secrets/lighter-trading-credential.js";

export interface SessionWalletScope {
  /** The selected EVM address, resolved under the policy; the read-only variant. */
  readonly walletAddress: string;
  readonly walletResolution: WalletResolution;
  readonly walletPolicy: WalletPolicy;
}

export interface LighterOnboardingChecklistDeps {
  readonly readSessionWallet: (sessionId: string) => Promise<SessionWalletScope>;
  readonly readLighterAccount: LighterOnboardingReaders["readLighterAccount"];
  readonly readWorkflow: (
    environment: LighterIntegrationEnvironment,
    walletAddress: string,
  ) => Promise<LighterOnboardingWorkflowRow | null>;
  readonly hasTradingKey: (environment: LighterIntegrationEnvironment, accountIndex: number) => boolean;
  readonly inspectFee: typeof inspectLighterFeeAuthorization;
}

function workflowProgress(
  workflow: LighterOnboardingWorkflowRow | null,
): Pick<LighterOnboardingChecklist, "progress" | "detail" | "nextAction" | "updatedAt"> {
  if (workflow === null) {
    return {
      progress: "not_started",
      detail: "Setup has not started.",
      nextAction: "start_setup",
      updatedAt: null,
    };
  }
  const updatedAt = workflow.updatedAt.toISOString();
  switch (workflow.workflowState) {
    case "ambiguous":
      return {
        progress: "needs_reconciliation",
        detail: "Setup needs a status check before you continue.",
        nextAction: "check_status",
        updatedAt,
      };
    case "failed":
      return {
        progress: "failed",
        detail: "Setup stopped before completion.",
        nextAction: "continue_setup",
        updatedAt,
      };
    case "deposit_approval_pending":
    case "key_registration_approval_pending":
      return {
        progress: "action_required",
        detail: "An approval is required to continue setup.",
        nextAction: "continue_setup",
        updatedAt,
      };
    case "deposit_l1_confirmed":
    case "deposit_l2_pending":
      return {
        progress: "in_progress",
        detail: "Deposit confirmed on Ethereum. Waiting for Lighter credit.",
        nextAction: "check_status",
        updatedAt,
      };
    case "change_pub_key_submitted":
      return {
        progress: "in_progress",
        detail: "Trading key submitted. Waiting for Lighter confirmation.",
        nextAction: "check_status",
        updatedAt,
      };
    case "ready_to_trade":
      return {
        progress: "ready",
        detail: "Lighter setup is complete.",
        nextAction: "none",
        updatedAt,
      };
    default:
      return {
        progress: "in_progress",
        detail: "Lighter setup is in progress.",
        nextAction: "continue_setup",
        updatedAt,
      };
  }
}

export async function resolveLighterOnboardingChecklist(
  input: { readonly sessionId: string; readonly environment: LighterIntegrationEnvironment },
  deps: LighterOnboardingChecklistDeps = defaultDeps(),
): Promise<LighterOnboardingChecklist> {
  const { walletAddress, walletResolution, walletPolicy } = await deps.readSessionWallet(input.sessionId);
  const [account, workflow] = await Promise.all([
    deps.readLighterAccount(input.environment, walletAddress),
    deps.readWorkflow(input.environment, walletAddress),
  ]);
  const progress = workflowProgress(workflow);
  if (account === null) {
    return {
      deposit: "todo",
      key: "todo",
      fee: "todo",
      ...(progress.progress === "ready"
        ? {
            progress: "needs_reconciliation" as const,
            detail: "Setup records are complete, but the Lighter account is not available yet.",
            nextAction: "check_status" as const,
            updatedAt: progress.updatedAt,
          }
        : progress),
    };
  }
  const key = deps.hasTradingKey(input.environment, account.account_index) ? "done" : "todo";
  const fee = await deps.inspectFee({
    sessionId: input.sessionId,
    environment: input.environment,
    walletResolution,
    walletPolicy,
  });
  const steps = {
    deposit: "done",
    key,
    fee: fee.status === "ready" ? "done" : fee.status === "disabled" ? "not_required" : "todo",
  } as const;
  if (steps.key === "done" && steps.fee !== "todo") {
    return {
      ...steps,
      progress: "ready",
      detail: "Lighter setup is complete.",
      nextAction: "none",
      updatedAt: progress.updatedAt,
    };
  }
  if (progress.progress === "needs_reconciliation" || progress.progress === "failed") {
    return { ...steps, ...progress };
  }
  return {
    ...steps,
    progress: "action_required",
    detail: steps.key === "todo"
      ? "Trading key approval is required."
      : "Fee approval is required.",
    nextAction: "continue_setup",
    updatedAt: progress.updatedAt,
  };
}

async function readSessionWalletFromEngine(sessionId: string): Promise<SessionWalletScope> {
  // The engine's own hydration, the way the desk lane and approval resume get
  // their wallet scope; fails closed when the session is gone.
  const { buildSessionWalletResolution, hydrateEngineSession } = await import(
    "@vex-agent/engine/core/hydrate.js"
  );
  const hydrated = await hydrateEngineSession(sessionId);
  if (hydrated === null) throw new Error("Lighter checklist: session not found.");
  const walletResolution = buildSessionWalletResolution(hydrated.context);
  const walletPolicy = hydrated.context.walletPolicy;
  return {
    walletAddress: resolveSelectedAddressForRead(walletResolution, walletPolicy, "eip155"),
    walletResolution,
    walletPolicy,
  };
}

function defaultDeps(): LighterOnboardingChecklistDeps {
  return {
    readSessionWallet: readSessionWalletFromEngine,
    readLighterAccount: buildLighterOnboardingReaders().readLighterAccount,
    readWorkflow: getLighterOnboardingWorkflow,
    hasTradingKey: (environment, accountIndex) =>
      listUnlockedLighterTradingCredentialScopes(environment)
        .some((scope) => scope.accountIndex === accountIndex),
    inspectFee: inspectLighterFeeAuthorization,
  };
}
