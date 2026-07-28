/**
 * `GET /v1/dashboard/merkle-rewards/{user}` — merkle-distributed reward accruals.
 *
 * G-10 PROBE RESULT (live, 2026-07-27, against a wallet holding 7 pending
 * rewards): the response carries NO `proof` array and NO `verifyCallData`. A
 * claimable row is exactly `{user, token, merkleRoot, chainId, assetId, amount,
 * toTimestamp, fromTimestamp}`. The endpoint therefore cannot build a claim
 * transaction, and this stays a READ. (The `/v1/spendle/{address}` endpoint is
 * the one that documents `multiTokenProof{proof, verifyCallData}` — a different
 * surface, and out of scope here.)
 *
 * This validator drops two fields the body does carry, deliberately:
 *   - `merkleRoot` — distribution material with no read value, kept out so no
 *     later card can mistake this type for something claim-capable;
 *   - `user`       — the caller's own address, echoed back. Carrying identity
 *     the caller already holds only widens what can leak into a log, a prompt or
 *     a fixture (rules/06 data minimisation).
 */

import { pendleInvalidResponse } from "../../errors.js";
import type { PendleReadMerkleReward, PendleReadMerkleRewards } from "../types.js";
import {
  isRecord,
  readDisplayString,
  requireAddress,
  requireChainId,
  requireDigitString,
} from "./_shared.js";

const ENDPOINT = "merkle rewards";

function normalizeReward(raw: unknown): PendleReadMerkleReward | null {
  if (!isRecord(raw)) return null;
  const chainId = requireChainId(raw.chainId);
  const token = requireAddress(raw.token);
  // STRICT: a reward amount is a raw base-unit u256. A JSON number here has
  // already lost precision, and a formatted string is a different unit — either
  // way the row is unusable, so it is dropped rather than coerced.
  const amountRaw = requireDigitString(raw.amount);
  if (chainId === null || token === null || amountRaw === null) return null;

  return {
    chainId,
    token,
    assetId: readDisplayString(raw.assetId),
    amountRaw,
    fromTimestamp: readDisplayString(raw.fromTimestamp),
    toTimestamp: readDisplayString(raw.toTimestamp),
  };
}

function normalizeRewardList(raw: unknown, side: string): PendleReadMerkleReward[] {
  if (!Array.isArray(raw)) {
    throw pendleInvalidResponse(ENDPOINT, `\`${side}\` was absent or not an array`);
  }
  const rewards = raw.map(normalizeReward).filter((r): r is PendleReadMerkleReward => r !== null);
  if (rewards.length === 0 && raw.length > 0) {
    throw pendleInvalidResponse(ENDPOINT, `no \`${side}\` row carried a readable chain, token and raw amount`);
  }
  return rewards;
}

/**
 * `GET /v1/dashboard/merkle-rewards/{user}` → claimable + already-claimed rows.
 *
 * Both documented arrays must be present. A wallet with nothing pending returns
 * two empty arrays, which is a determined answer and passes through; a body we
 * cannot read RAISES, so "no rewards" can never be produced by a parse failure.
 */
export function validatePendleMerkleRewards(raw: unknown): PendleReadMerkleRewards {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(ENDPOINT, "expected a JSON object at the root");
  }
  return {
    claimable: normalizeRewardList(raw.claimableRewards, "claimableRewards"),
    claimed: normalizeRewardList(raw.claimedRewards, "claimedRewards"),
  };
}
