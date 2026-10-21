/**
 * Claim cashback to the Vex Cloud balance (owner decision D13, phase 2:
 * balance only; the wallet destination is phase 3 and has no path here).
 *
 * One idempotency key per press, minted here. Claiming "everything
 * claimable" is safe to repeat: a second claim after a lost answer finds
 * nothing left and returns 0, so a fresh key per press cannot pay twice.
 */

import { randomUUID } from "node:crypto";
import type { VexCloudClaimCashbackResult } from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../../logger/index.js";
import type { VexCloudApi } from "../api-client.js";
import type { VexCloudOutcome } from "../outcome.js";
import { withBearer, type SessionPort } from "./backend-call.js";

export interface CashbackDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "claimCashbackToBalance">;
  readonly mintIdempotencyKey?: () => string;
}

export async function claimCashbackToBalance(
  deps: CashbackDeps,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudClaimCashbackResult>> {
  const key = (deps.mintIdempotencyKey ?? (() => `vxc_${randomUUID().replace(/-/g, "")}`))();
  log.info(`[vex-cloud:cashback] asked correlationId=${correlationId}`);
  const claimed = await withBearer(deps, (bearer) => deps.api.claimCashbackToBalance(bearer, key, signal));
  log.info(
    `[vex-cloud:cashback] decided outcome=${claimed.ok ? "claimed" : `refused:${claimed.refusal.kind}`} correlationId=${correlationId}`,
  );
  if (!claimed.ok) return claimed;
  return { ok: true, value: { claimedWei: claimed.value.claimedWei } };
}
