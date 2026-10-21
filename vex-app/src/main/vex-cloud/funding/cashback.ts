/**
 * Claim cashback to the Vex Cloud balance (owner decision D13, phase 2:
 * balance only; the wallet destination is phase 3 and has no path here).
 *
 * ONE IDEMPOTENCY KEY PER CLAIM, KEPT UNTIL ITS OUTCOME IS KNOWN. A claim
 * moves everything claimable, and the backend answers a repeated key with
 * the SAME claimed amount (`VexVirtualsCompute/src/ledger/cashback.ts`). When
 * the first send's answer does not prove a refusal (`isDefinitiveRefusal`: a
 * body this build cannot read, a timeout, a 5xx), the claim may have
 * committed: the outcome is `unknown` and the key is kept, so the next press
 * ("Check status") repeats the same claim and reports what that claim moved
 * instead of a fresh claim that finds nothing left and says "0".
 *
 * A REPLAY RESOLVES ONLY ON SUCCESS. The ledger has no refusal after its key
 * lookup (`replayVerdict`, the table in `backend-call.ts`), so every refusal
 * of a replay (a 401, route validation, a 5xx) proves nothing about the
 * original claim and keeps the key; a 401 still clears the expired session.
 *
 * KEYED BY ACCOUNT. Vex Cloud looks a key up per account, so the claim reads
 * the account first, with the bearer it then claims with, and holds at most
 * one open key per account: a sign-out and a sign-in to the same account
 * replay the same key, and another account never inherits it. Bounded by
 * {@link MAX_HELD_ACCOUNTS}. Process memory: a restart forgets it, which
 * costs only the honest figure, never a double claim.
 */

import { randomUUID } from "node:crypto";
import type { VexCloudClaimCashbackResult } from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../../logger/index.js";
import type { VexCloudApi } from "../api-client.js";
import type { VexCloudOutcome } from "../outcome.js";
import { backendRefusal, isDefinitiveRefusal, replaySignedOut, replayVerdict, requireBearer, type SessionPort } from "./backend-call.js";

export interface CashbackDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "claimCashbackToBalance">;
  readonly mintIdempotencyKey?: () => string;
}

/** How many accounts may hold an open claim key at once; past it the oldest is forgotten. */
const MAX_HELD_ACCOUNTS = 8;

/** Account id to the key of its claim whose outcome is unknown. Insertion order is age. */
let unresolvedClaimKeys = new Map<string, string>();

/** Test-only reset. */
export function __resetCashbackStateForTests(): void {
  unresolvedClaimKeys = new Map<string, string>();
}

function hold(accountId: string, key: string): void {
  unresolvedClaimKeys.delete(accountId);
  while (unresolvedClaimKeys.size >= MAX_HELD_ACCOUNTS) {
    const oldest = unresolvedClaimKeys.keys().next();
    if (oldest.done === true) break;
    unresolvedClaimKeys.delete(oldest.value);
  }
  unresolvedClaimKeys.set(accountId, key);
}

function release(accountId: string, key: string): void {
  if (unresolvedClaimKeys.get(accountId) === key) unresolvedClaimKeys.delete(accountId);
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
  // No claim is sent yet, so a refusal here (a 401 included) changes nothing and keeps any held key.
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  const accountId = read.value.account_id;
  const held = unresolvedClaimKeys.get(accountId);
  const key = held ?? (deps.mintIdempotencyKey ?? (() => `vxc_${randomUUID().replace(/-/g, "")}`))();
  // Held BEFORE the send: whatever happens next, the key survives until an answer about it.
  hold(accountId, key);
  const claimed = await deps.api.claimCashbackToBalance(bearer.value, key, signal);
  if (claimed.ok) {
    release(accountId, key);
    return { ok: true, value: { outcome: "claimed", claimedWei: claimed.value.claimedWei } };
  }
  if (held === undefined) {
    if (isDefinitiveRefusal(claimed.failure)) {
      release(accountId, key);
      return backendRefusal(deps, claimed.failure);
    }
    return { ok: true, value: { outcome: "unknown" } };
  }
  if (replayVerdict("cashback_claim", claimed.failure) === "not_created") {
    // Unreachable against today's backend (its table row is empty); kept so the table stays the one decision.
    release(accountId, key);
    return backendRefusal(deps, claimed.failure);
  }
  if (claimed.failure.kind === "unauthorized") return replaySignedOut(deps, "cashback claim");
  return { ok: true, value: { outcome: "unknown" } };
}
