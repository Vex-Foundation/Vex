/** Evidence-only startup/periodic repair for staged Lighter withdrawals. */

import { getLighterClient } from "@tools/lighter/client.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import * as leasesRepo from "@vex-agent/db/repos/lighter-evm-execution-leases.js";
import * as claimsRepo from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import { withSessionControlLocks } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { resolveLighterReadOnlyAccountAuth } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { reconcileLighterWithdrawal } from "@vex-agent/tools/protocols/lighter/withdrawal-reconciliation.js";

export interface LighterWithdrawalRepairReport {
  readonly examined: number;
  readonly advanced: number;
  readonly awaitingVault: number;
  readonly awaitingEvidence: number;
  readonly errors: number;
  readonly lastError: string | null;
}

export async function repairUnresolvedLighterWithdrawals(): Promise<LighterWithdrawalRepairReport> {
  const candidates = await intentsRepo.listReconciliationCandidates(5);
  const client = getLighterClient();
  let advanced = 0;
  let awaitingVault = 0;
  let awaitingEvidence = 0;
  let errors = 0;
  let lastError: string | null = null;
  for (const original of candidates) {
    try {
      let intent = original;
      const deployment = getUniswapDeployment(intent.settlementChainId);
      if (deployment === undefined) throw new Error("Settlement network is unavailable for Lighter withdrawal repair.");
      const publicClient = getUniswapPublicClient(deployment);
      const claim = await claimsRepo.findLatestForWithdrawalIntent(intent.intentId);
      if (claim?.state === "prepared" && Date.parse(claim.expiresAt) <= Date.now()) {
        await withSessionControlLocks([intent.sessionId, claim.sessionId], (db) =>
          claimsRepo.expirePreparedWith(db, claim.claimId, claim.sessionId));
        intent = await intentsRepo.findByIntentId(intent.sessionId, intent.intentId) ?? intent;
      } else if (
        claim?.state === "approved" && claim.txHash === null
        && Date.now() - Date.parse(claim.updatedAt) >= 120_000
      ) {
        const lease = await leasesRepo.getLighterEvmExecutionLease(intent.settlementChainId, intent.walletAddress).catch(() => null);
        if (lease === null || lease.expiresAt.getTime() <= Date.now()) {
          await withSessionControlLocks([intent.sessionId, claim.sessionId], (db) => claimsRepo.markUnsubmittedFailureWith(db, {
            claimId: claim.claimId,
            sessionId: claim.sessionId,
            reason: "approved manual claim had no staged transaction after the execution lease window",
          }));
          intent = await intentsRepo.findByIntentId(intent.sessionId, intent.intentId) ?? intent;
        }
      }
      const auth = await resolveLighterReadOnlyAccountAuth(intent.environment, intent.accountIndex);
      if (auth === null) {
        awaitingVault += 1;
        continue;
      }
      const reconciled = await reconcileLighterWithdrawal({ intent, client, privilegedAuth: auth, publicClient });
      if (reconciled.executionState === intent.executionState) awaitingEvidence += 1;
      else advanced += 1;
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { examined: candidates.length, advanced, awaitingVault, awaitingEvidence, errors, lastError };
}
