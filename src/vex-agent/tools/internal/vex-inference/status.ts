/**
 * `VexInferenceStatus`: one read of the user's Vex Inference account as the
 * agent needs it (balances, rate, alert, the current model's prices, recent
 * usage, whether deposits are open, the auto top-up rule).
 *
 * Read only. The account read, the gateway `/v1/models` row and the usage
 * page come from the main-process host; this handler adds the runtime's own
 * facts (the configured model and the session's reasoning effort) and owns
 * the model-visible envelope: `summary` first, every amount with its unit.
 */

import { getSessionReasoningEffort } from "@vex-agent/db/repos/session-reasoning-effort.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import {
  getVexInferenceHost,
  vexInferenceToolAvailability,
  vexInferenceUnavailableSentence,
  type VexInferenceStatusReport,
} from "./host.js";
import { checkStatusParams } from "./params.js";

function summaryOf(report: VexInferenceStatusReport): string {
  const parts: string[] = [];
  const available = report.balances.available;
  const usd = available.usdEstimate === null ? "no USD estimate (rate unavailable)" : `about $${available.usdEstimate}`;
  parts.push(`Vex Inference balance: ${available.vex} VEX available (${usd}), ${report.balances.provisional.vex} VEX provisional.`);
  parts.push(
    report.alert.belowAlert
      ? `BELOW the ${report.alert.percent}% low-balance alert (threshold ${report.alert.threshold.vex} VEX).`
      : `Above the ${report.alert.percent}% low-balance alert (threshold ${report.alert.threshold.vex} VEX).`,
  );
  parts.push(report.deposits.open ? "Deposits are open." : `Deposits are NOT open (${report.deposits.state}).`);
  parts.push(
    report.autoTopUp.state === "none"
      ? "No auto top-up rule."
      : `Auto top-up rule ${report.autoTopUp.state}${report.autoTopUp.suspendedReason === null ? "" : ` (${report.autoTopUp.suspendedReason})`}.`,
  );
  if (report.withdrawals.state === "unavailable") {
    parts.push(`Pending withdrawals could not be read (${report.withdrawals.reason}).`);
  } else if (report.withdrawals.pending.length === 0) {
    parts.push(report.withdrawals.complete ? "No pending withdrawals." : "No pending withdrawals among the newest ones read.");
  } else {
    const cooling = report.withdrawals.pending.filter((item) => item.cooling);
    // The backend's `cancellable` decides the warning, never the desktop clock: a
    // released withdrawal not yet signed can still be stopped.
    const foreign = report.withdrawals.pending.filter((item) => item.cancellable && !item.startedInThisApp);
    parts.push(
      `${report.withdrawals.pending.length} pending withdrawal(s), ${cooling.length} in the cooling period. `
        + "Only the user can cancel a cooling withdrawal, in Funding, Withdraw; you cannot cancel or start one.",
    );
    if (foreign.length > 0) {
      parts.push(`WARNING: ${foreign.length} withdrawal(s) that can still be cancelled were NOT started in this app; tell the user to check them and cancel any that were not them.`);
    }
  }
  if (report.account.paused) parts.push("The account is PAUSED by Vex Inference.");
  return parts.join(" ");
}

export async function handleVexInferenceStatus(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const availability = vexInferenceToolAvailability();
  if (!availability.available) return fail(vexInferenceUnavailableSentence(availability.reason));
  const host = getVexInferenceHost();
  if (host === null) return fail(vexInferenceUnavailableSentence("host_not_mounted"));
  const checked = checkStatusParams(params);
  if (!checked.ok) return fail(checked.message);

  const modelId = process.env.AGENT_MODEL?.trim() || null;
  let effort: string | null = null;
  try {
    effort = await getSessionReasoningEffort(context.sessionId);
  } catch {
    // The effort is display context; an unreadable one is reported as null, never guessed.
    effort = null;
  }
  const controller = new AbortController();
  const outcome = await host.readStatus(
    { modelId, effort, usageLimit: checked.value.limit, usageCursor: checked.value.cursor },
    controller.signal,
  );
  if (!outcome.ok) {
    return fail(`Vex Inference status could not be read (${outcome.refusal.kind}): ${outcome.refusal.detail}`);
  }
  const report = outcome.value;
  return ok({
    summary: summaryOf(report),
    ...report,
    effortNote: effort === null ? "No effort is stored for this session, so the model's default effort applies." : null,
  });
}
