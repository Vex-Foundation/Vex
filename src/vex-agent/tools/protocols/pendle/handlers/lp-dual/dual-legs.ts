/**
 * What the two dual-LP tools share: the activity role their rows carry, their
 * tool ids, the BY-TOKEN quoted-leg read, and the exact-approval helper.
 */

import { getAddress, type Address } from "viem";

import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { ensurePendleAllowanceExact } from "@tools/pendle/erc20.js";
import type { PendleConvertResponse, PendleTokenAmount } from "@tools/pendle/types.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";

/** The activity role every dual-LP row carries (migration 053) — dual legs allowed. */
export const LP_EVENT_ROLE = "yield_lp" as const;

export const REMOVE_DUAL_TOOL_ID = "pendle.lp.removeDual";
export const ADD_KEEP_YT_TOOL_ID = "pendle.lp.addKeepYt";

/**
 * The route's quoted amount for ONE named output leg, resolved BY TOKEN.
 *
 * Never positional: the provider's `outputs` order is its own canonical order
 * and does not echo the requested one, so reading leg 2 at index 1 would compare
 * (and later report) the wrong leg's amount. Fails CLOSED — zero matches or more
 * than one are both refusals, never a guess, because "which leg is this" is not
 * a question to answer approximately on a money path.
 */
export function quotedLeg(outputs: readonly PendleTokenAmount[], token: Address, label: string): string {
  const matched = outputs.filter((o) => o.token.toLowerCase() === token.toLowerCase());
  if (matched.length !== 1) {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      `Pendle did not quote exactly one ${label} leg for this route.`,
    );
  }
  return matched[0]!.amount;
}

/** Approve EXACTLY what Convert asks for, to the pinned Router — nothing else. */
export async function approveRequired(
  response: PendleConvertResponse,
  publicClient: Parameters<typeof ensurePendleAllowanceExact>[0],
  walletClient: Parameters<typeof ensurePendleAllowanceExact>[1],
): Promise<void> {
  for (const approval of response.requiredApprovals) {
    await ensurePendleAllowanceExact(
      publicClient,
      walletClient,
      getAddress(approval.token),
      PENDLE_ROUTER,
      BigInt(approval.amount),
    );
  }
}
