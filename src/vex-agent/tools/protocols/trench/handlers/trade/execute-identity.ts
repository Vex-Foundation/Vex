/**
 * The `trench.trade_execute` run's fixed identity, plus the two recording
 * helpers every stage of it shares.
 *
 * Extracted so the entry point, the staged loop, the confirmed-swap finalizer
 * and the failure paths all name the SAME tool id, protocol and chain slug -
 * those strings are written into `agent_activity` rows and read back by the
 * feed, so a drifted copy would silently split one venue's history in two.
 */

import type { Address } from "viem";

import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { abortPlannedEvents } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import { trenchFailureDetail } from "../failure.js";

export const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;
export const ETH_DECIMALS = 18;
export const PROTOCOL = "trench";
export const CHAIN_SLUG = "robinhood";
export const TOOL_ID = "trench.trade_execute";

/** The ONE scrub boundary for provider/chain error text reaching a ToolResult. */
export function safeDetail(err: unknown): string {
  return trenchFailureDetail(TOOL_ID, err);
}

/** Best-effort abort of every planned event from `fromIndex` on. Never throws. */
export async function abortRemaining(
  executionId: number,
  fromIndex: number,
  reason: string,
): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("trench.trade_execute.abort_failed", { executionId, fromIndex, error: safeDetail(err) });
  }
}
