/**
 * Agent Scan — activity view: history feed from proj_activity.
 *
 * `bridges`/`lp_history`/`non_trading_history` views retired (Agent Scan plan
 * v3 §1.9/§4.7 — the agent reads history through `transactions` /
 * `activity`, filtered by `productType`).
 */

import type { ToolResult } from "../../types.js";
import { ok } from "../types.js";

export async function inspectActivity(addresses: string[], namespace?: string, productType?: string, limit = 20): Promise<ToolResult> {
  const { getActivities } = await import("@vex-agent/db/repos/activity.js");
  const activities = await getActivities({ addresses, namespace, productType, limit });

  return ok({
    view: "activity",
    count: activities.length,
    activities: activities.map(a => ({
      namespace: a.namespace,
      type: a.activityType,
      product: a.productType,
      side: a.tradeSide,
      chain: a.chain,
      input: a.inputToken ? `${a.inputAmount} ${a.inputToken}` : null,
      output: a.outputToken ? `${a.outputAmount} ${a.outputToken}` : null,
      inputValueUsd: a.inputValueUsd != null ? Number(a.inputValueUsd) : null,
      outputValueUsd: a.outputValueUsd != null ? Number(a.outputValueUsd) : null,
      valuationSource: a.valuationSource,
      captureStatus: a.captureStatus,
      createdAt: a.createdAt,
    })),
  });
}
