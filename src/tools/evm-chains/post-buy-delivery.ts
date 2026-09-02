/**
 * Post-buy delivery verification: after a swap that ACQUIRED an ERC-20 confirms
 * on-chain, ask the token itself what the wallet holds.
 *
 * Live incident 2026-08-10 (Robinhood Chain 4663): a confirmed buy of 43,932
 * TOM emitted a Transfer log to the wallet, the settlement decoder read that
 * log, and `balanceOf(wallet)` was zero. Receipt logs are contract-authored, so
 * a fake-transfer token can produce a perfectly decodable settlement while
 * delivering nothing. The agent read the transfer as truth and burned five
 * minutes of blind sell retries.
 *
 * Deliberately narrow: ONE read, and a claim only on an exact zero. The verdict
 * is phrased as an observation plus the pattern it matches, never as proof of
 * intent, because one zero read is all the evidence there is. A non-zero
 * balance adds nothing (there is no "materially short" tolerance here), and a
 * failed read is logged and stays out of agent-facing text entirely.
 *
 * Never allowed to fail the swap: the funds already moved.
 */

import type { Address } from "viem";

import { readErc20Balance, type Erc20ReadClient } from "./erc20-reads.js";
import logger from "../../utils/logger.js";

export interface PostBuyDeliveryRequest {
  readonly client: Erc20ReadClient;
  /** The ACQUIRED (token-out) ERC-20. Native legs never reach here. */
  readonly tokenAddress: Address;
  readonly owner: Address;
  /** Chain slug or id, for the fail-soft log only. */
  readonly chainLabel: string;
  readonly txHash: string;
}

const ZERO_DELIVERY_VERDICT =
  "Delivery check: balanceOf returned zero immediately after the confirmed buy; "
  + "this matches a fake-transfer/honeypot delivery failure; "
  + "do not retry the sale on this evidence.";

/**
 * The agent-facing verdict when the buy delivered nothing, or `null` when the
 * wallet holds the token or the read could not be made.
 */
export async function verifyPostBuyDelivery(
  request: PostBuyDeliveryRequest,
): Promise<string | null> {
  let balance: bigint;
  try {
    balance = await readErc20Balance(request.client, request.tokenAddress, request.owner);
  } catch (err) {
    // SECURITY: a raw provider error can carry the RPC URL or a response body,
    // so only the bounded error CLASS is logged, and nothing is said to the
    // agent - an unread balance is not evidence of anything.
    logger.warn("evm_chains.post_buy_delivery.read_failed", {
      chain: request.chainLabel,
      token: request.tokenAddress,
      txHash: request.txHash,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
  return balance === 0n ? ZERO_DELIVERY_VERDICT : null;
}

// ── Approved-floor assessment ───────────────────────────────────────────

/**
 * Raw base units the executed output may fall below the approved floor without
 * being called short.
 *
 * MEASURED (live probes 2026-08-27): KyberSwap's `/route/build` derives the
 * calldata `minAmountOut` itself and lands one wei under the value rederived
 * from the same summary, so the guard on that lane already carries a 1-unit
 * rederivation allowance. This assessment reads the SETTLED amount against the
 * same floor and must not contradict a build the guard accepted.
 */
export const APPROVED_FLOOR_ALLOWANCE_RAW = 1n;

/** What a confirmed fill was, relative to the floor the human approved. */
export type ApprovedFloorAssessment =
  | { readonly kind: "not_assessable" }
  | { readonly kind: "met" }
  | {
      readonly kind: "materially_short";
      readonly shortfallRaw: bigint;
      readonly verdict: string;
    };

const NOT_ASSESSABLE: ApprovedFloorAssessment = { kind: "not_assessable" };
const MET: ApprovedFloorAssessment = { kind: "met" };

function parseRawAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/**
 * Compare a confirmed fill against the floor its quote was approved at.
 *
 * DETECTION ONLY. It runs after the funds have moved, it never changes a
 * settlement status, and it never fails a swap - the prevention lives at the
 * execute, which refuses to sign calldata carrying any other floor. This exists
 * because a floor can still be missed after signing: a fee-on-transfer output,
 * a router that under-delivers, or a settlement recorded by the repair sweep
 * for a transaction this process never watched. When that happens the agent
 * must be told BY NAME rather than reading a confirmed row as a good fill.
 *
 * Returns `not_assessable` whenever either side is missing or unparseable - a
 * row written before the floor was recorded proves nothing about the fill, and
 * inventing a verdict from an absent number is worse than staying silent.
 */
export function assessApprovedFloor(input: {
  readonly executedAmountOutRaw: unknown;
  readonly approvedMinOutRaw: unknown;
  readonly tokenOutSymbol: string;
}): ApprovedFloorAssessment {
  const executed = parseRawAmount(input.executedAmountOutRaw);
  const floor = parseRawAmount(input.approvedMinOutRaw);
  if (executed === null || floor === null) return NOT_ASSESSABLE;
  if (executed + APPROVED_FLOOR_ALLOWANCE_RAW >= floor) return MET;
  const shortfallRaw = floor - executed;
  return {
    kind: "materially_short",
    shortfallRaw,
    verdict:
      `Fill below the approved floor: this swap delivered ${executed.toString()} raw units of `
      + `${input.tokenOutSymbol} against the ${floor.toString()} the approved quote set as its minimum, `
      + `${shortfallRaw.toString()} raw units short. The transaction is confirmed and the funds have moved; `
      + "treat the delivered amount, not the quote, as what you hold, and check the output token for a "
      + "transfer tax before trading it again.",
  };
}
