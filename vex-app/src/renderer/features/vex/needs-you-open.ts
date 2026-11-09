/**
 * OPEN WHAT A NEEDS YOU ROW NAMES, NEVER DECIDE IT (docs/design/H3-DESKTOP.md
 * section 1.5: "Review opening its card"). Every Needs you key reads this:
 * the console's row and the page strip's decision, as R3's sidebar list did.
 *
 *   - an approval in the chat already open scrolls its card into view and
 *     focuses it;
 *   - one raised elsewhere opens its session (mode first, then the selection,
 *     then the page closed, as the approvals inbox always has);
 *   - an approval with no session (a Studio project's) opens the Needs you
 *     page on its own card (`approvalId`), whose Reject takes the focus, as
 *     R3's header control did;
 *   - a mission opens its session;
 *   - a withdrawal this app did not start opens the funding page.
 *
 * Nothing here approves anything: the REAL FUNDS decision stays in the card's
 * own two-step confirm.
 */

import { useUiStore } from "../../stores/uiStore.js";
import { revealApprovalCard } from "../appShell/ApprovalCard/reveal-approval-card.js";
import type { NeedsYouItem } from "./needs-you.js";

export function openNeedsYouItem(item: NeedsYouItem): void {
  const ui = useUiStore.getState();
  if (item.kind === "withdrawal") {
    ui.setShellRoute({ kind: "vexCloudFunding", origin: null });
    return;
  }
  if (item.sessionId === null) {
    ui.setShellRoute({ kind: "needsYou", origin: null, approvalId: item.approvalId });
    return;
  }
  const alreadyOpen = ui.runtimeMode !== "studio" && ui.activeSessionId === item.sessionId;
  if (!alreadyOpen) {
    ui.setRuntimeMode("agent");
    ui.setActiveSessionId(item.sessionId);
  }
  ui.setShellRoute({ kind: "none" });
  // Review takes you to the card: scrolled into view and focused, once the
  // chat has painted it (`ApprovalCard/reveal-approval-card.ts`, row S6b-07).
  if (item.approvalId !== null) revealApprovalCard(item.approvalId);
}

/**
 * Whether an item's card is in the transcript beside the console: an approval
 * raised in the chat open in the agent shell. Its key points down at it.
 */
export function needsYouItemIsHere(
  item: NeedsYouItem,
  where: { readonly runtimeMode: string; readonly activeSessionId: string | null },
): boolean {
  return (
    item.kind === "approval" && where.runtimeMode !== "studio" && item.sessionId === where.activeSessionId
  );
}
