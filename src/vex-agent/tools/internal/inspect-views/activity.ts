/**
 * Agent Scan — activity view: history feed from proj_activity.
 *
 * `bridges`/`lp_history`/`non_trading_history` views retired (Agent Scan plan
 * v3 §1.9/§4.7 — the agent reads history through `transactions` /
 * `activity`, filtered by `productType`).
 *
 * ── UNIT CONVENTIONS OF `input_amount` / `output_amount` (audit 2026-07-30) ──
 *
 * The column holds whatever the writing tool put in its capture. Traced end to
 * end: `sync/activity-populator.ts` copies `_tradeCapture.inputAmount` /
 * `.outputAmount` through VERBATIM — there is no unit normalisation anywhere on
 * the path — and only two entry points reach it:
 *
 *   1. `executeProtocolTool` → `runtime/capture.ts` → `capture-pipeline.ts`,
 *      stamping `namespace` from the tool's own manifest; and
 *   2. `sync/synthetic-capture.ts` (`prediction-settlement-sync.ts`), which
 *      sets NO amount fields at all — those rows are NULL on both legs.
 *
 * Of every live `_tradeCapture` producer, only the Pendle handlers
 * (`pendle/handlers/pt.ts`, `yt.ts`, `py.ts`) write these fields, and they
 * write RAW BASE UNITS deliberately: the spot lot projector `BigInt()`s them,
 * so a human decimal would corrupt `proj_pnl_lots`. Those rows all carry
 * `namespace = "pendle"` (`protocols/catalog.ts`), which is the discriminator
 * used below. Pendle's `lp.ts` captures carry no amount fields.
 *
 * The internal wallet-send capture (`internal/wallet/send-execute-evm.ts`,
 * `send-execute-solana.ts`) uses a HUMAN `intent.amount`, but `wallet_send_*`
 * dispatches through `dispatcher/internal-loaders.ts`, which runs no capture
 * pipeline — so it does not reach this table today. Legacy rows written under
 * an earlier dispatch shape may still hold human values, which is why only the
 * PROVABLY-raw rows are labelled and nothing here claims any row is human.
 *
 * Render-side only, by design: the real fix is human sibling columns on
 * `proj_activity`, and a schema change is an owner decision (rules/00 Hard
 * Stop), so this view states the unit instead of converting it.
 */

import type { ToolResult } from "../../types.js";
import { ok } from "../types.js";

/**
 * Namespaces whose `proj_activity` amounts are proven RAW base units. Kept as
 * an explicit set rather than a guess: a namespace is added here only once its
 * writers have been read.
 */
const RAW_BASE_UNIT_NAMESPACES = new Set(["pendle"]);

/**
 * One leg's agent-facing amount. Raw-unit rows say so, in the same doctrine as
 * dexscreener's `TOKEN_DECIMALS_RESOLVER_NOTE` (`dexscreener/list-core/
 * provenance.ts`): an amount whose decimals are unknown must never be quoted
 * as a quantity — `"1047061"` is 1.05 at 6 decimals and 0.00105 at 9.
 */
function formatLeg(amount: string | null, token: string | null, namespace: string): string | null {
  if (!token) return null;
  return RAW_BASE_UNIT_NAMESPACES.has(namespace)
    ? `${amount} ${token} (raw base units — resolve decimals before quoting)`
    : `${amount} ${token}`;
}

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
      input: formatLeg(a.inputAmount, a.inputToken, a.namespace),
      output: formatLeg(a.outputAmount, a.outputToken, a.namespace),
      inputValueUsd: a.inputValueUsd != null ? Number(a.inputValueUsd) : null,
      outputValueUsd: a.outputValueUsd != null ? Number(a.outputValueUsd) : null,
      valuationSource: a.valuationSource,
      captureStatus: a.captureStatus,
      createdAt: a.createdAt,
    })),
  });
}
