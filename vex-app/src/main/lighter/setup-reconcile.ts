/** Evidence-only recovery for the selected wallet's unfinished setup. */
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type { LighterSetupReconcile } from "@shared/schemas/lighter-trading.js";
import { findByIntentId } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { getLighterOnboardingWorkflow } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import {
  buildProductionLighterDepositRepairDeps,
  repairLighterDepositIntent,
} from "@vex-agent/sync/lighter-deposit-repair.js";
import { reconcileSetupKeyRegistration } from "./key-registration-reconcile.js";
import { readSessionWalletFromEngine } from "./onboarding-checklist.js";

const DEPOSIT_EVIDENCE_STATES: ReadonlySet<string> = new Set([
  "ambiguous",
  "approve_staged",
  "deposit_staged",
  "deposit_l1_confirmed",
  "deposit_l2_pending",
  "account_resolved",
]);

export async function reconcileSetupAttempt(input: {
  readonly sessionId: string;
  readonly environment: LighterIntegrationEnvironment;
}): Promise<LighterSetupReconcile> {
  const wallet = await readSessionWalletFromEngine(input.sessionId);
  const workflow = await getLighterOnboardingWorkflow(input.environment, wallet.walletAddress);

  if (workflow !== null && workflow.activeDepositIntentId !== null
    && DEPOSIT_EVIDENCE_STATES.has(workflow.workflowState)) {
    const deposit = await findByIntentId(workflow.activeDepositIntentId);
    if (
      deposit === null
      || deposit.environment !== input.environment
      || deposit.walletAddress.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return { attempted: false, status: "manual_review" };
    }
    const report = await repairLighterDepositIntent(deposit, buildProductionLighterDepositRepairDeps());
    if (report.resolution === "manual_review") return { attempted: true, status: "manual_review" };
    if (report.resolution !== "credited" && report.resolution !== "terminal") {
      return { attempted: true, status: "pending" };
    }
  }

  const key = await reconcileSetupKeyRegistration(input);
  if (key.attempted) return key;
  return {
    attempted: workflow?.workflowState === "ambiguous",
    // A staged key may still be sendable, so the key reconciler deliberately
    // does nothing until expiry. The setup status decides whether an unrelated
    // ambiguous workflow truly lacks an attributable intent for manual review.
    status: workflow?.workflowState === "ambiguous" ? "pending" : key.status,
  };
}
