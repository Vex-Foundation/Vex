/**
 * Which pending approval cards belong on the Lighter desk, read off the
 * renderer-safe preview main attaches to every approval.
 */

import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";

/** Lighter execute tools whose cards the desk shows in place of the ticket. */
const DESK_CARD_TOOL_IDS: ReadonlySet<string> = new Set([
  "lighter.order.create",
  "lighter.order.cancel",
  "lighter.position.close",
  "lighter.position.protect",
]);

const CLOSE_TOOL_ID = "lighter.position.close";

/** The execute tool id behind a card, or null when the card carries no Lighter preview. */
function lighterToolId(summary: ApprovalSummaryDto): string | null {
  const preview = summary.preview;
  if (!preview) return null;
  if (preview.namespace === "lighter") return `lighter.${preview.toolName}`;
  const toolId = preview.criticalArgs.toolId;
  return typeof toolId === "string" ? toolId : null;
}

export function isLighterOrderApproval(summary: ApprovalSummaryDto): boolean {
  if (summary.origin !== "desk") return false;
  const toolId = lighterToolId(summary);
  return toolId !== null && DESK_CARD_TOOL_IDS.has(toolId);
}

/** A market close raised from the desk's positions table. */
export function isDeskCloseApproval(summary: ApprovalSummaryDto): boolean {
  return summary.origin === "desk" && lighterToolId(summary) === CLOSE_TOOL_ID;
}
