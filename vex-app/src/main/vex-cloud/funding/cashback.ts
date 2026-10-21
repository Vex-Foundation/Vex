/**
 * Claim cashback to the Vex Cloud balance (owner decision D13, phase 2:
 * balance only; the wallet destination is phase 3 and has no path here).
 *
 * ONE IDEMPOTENCY KEY PER CLAIM, KEPT UNTIL ITS OUTCOME IS KNOWN. A claim
 * moves everything claimable, and the backend answers a repeated key with
 * the SAME claimed amount (`VexVirtualsCompute/src/ledger/cashback.ts`). When
 * the answer does not prove a refusal (`isDefinitiveRefusal`: a body this
 * build cannot read, a timeout, a 5xx), the claim may have committed: the
 * outcome is `unknown` and the key is kept, so the next press ("Check
 * status") repeats the same claim and reports what that claim moved instead
 * of a fresh claim that finds nothing left and says "0". A success or a
 * definitive refusal retires the key. Process memory: a restart forgets it,
 * which costs only the honest figure, never a double claim.
 */

import { randomUUID } from "node:crypto";
import type { VexCloudClaimCashbackResult } from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../../logger/index.js";
import type { VexCloudApi } from "../api-client.js";
import type { VexCloudOutcome } from "../outcome.js";
import { backendRefusal, isDefinitiveRefusal, requireBearer, type SessionPort } from "./backend-call.js";

export interface CashbackDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "claimCashbackToBalance">;
  readonly mintIdempotencyKey?: () => string;
}

/** The key of a claim whose outcome is unknown; `null` when none is open. */
let unresolvedClaimKey: string | null = null;

/** Test-only reset. */
export function __resetCashbackStateForTests(): void {
  unresolvedClaimKey = null;
}

export async function claimCashbackToBalance(
  deps: CashbackDeps,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudClaimCashbackResult>> {
  log.info(`[vex-cloud:cashback] asked correlationId=${correlationId}`);
  const outcome = await runClaim(deps, signal);
  const decided = !outcome.ok ? `refused:${outcome.refusal.kind}` : outcome.value.outcome;
  log.info(`[vex-cloud:cashback] decided outcome=${decided} correlationId=${correlationId}`);
  return outcome;
}

async function runClaim(deps: CashbackDeps, signal: AbortSignal): Promise<VexCloudOutcome<VexCloudClaimCashbackResult>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const key = unresolvedClaimKey ?? (deps.mintIdempotencyKey ?? (() => `vxc_${randomUUID().replace(/-/g, "")}`))();
  // Held BEFORE the send: whatever happens next, the key survives until a definitive answer.
  unresolvedClaimKey = key;
  const claimed = await deps.api.claimCashbackToBalance(bearer.value, key, signal);
  if (claimed.ok) {
    if (unresolvedClaimKey === key) unresolvedClaimKey = null;
    return { ok: true, value: { outcome: "claimed", claimedWei: claimed.value.claimedWei } };
  }
  if (isDefinitiveRefusal(claimed.failure)) {
    if (unresolvedClaimKey === key) unresolvedClaimKey = null;
    return backendRefusal(deps, claimed.failure);
  }
  return { ok: true, value: { outcome: "unknown" } };
}
