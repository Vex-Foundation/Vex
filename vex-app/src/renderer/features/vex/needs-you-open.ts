/**
 * OPEN WHAT A NEEDS YOU ROW NAMES, NEVER DECIDE IT (docs/design/H3-DESKTOP.md
 * section 1.5: "Review opening its card"). Every Needs you key reads this:
 * the console's row and the page strip's decision, as R3's sidebar list did.
 *
 *   - an approval in the chat already open scrolls its card into view;
 *   - one raised elsewhere opens its session (mode first, then the selection,
 *     then the page closed, as the approvals inbox always has);
 *   - an approval with no session (a Studio project's) opens the Needs you
 *     page, where its card is;
 *   - a mission opens its session;
 *   - a withdrawal this app did not start opens the funding page.
 *
 * Nothing here approves anything: the REAL FUNDS decision stays in the card's
 * own two-step confirm.
 */

import { prefersReducedMotion } from "../../lib/motion/reduced-motion.js";
import { useUiStore } from "../../stores/uiStore.js";
import type { NeedsYouItem } from "./needs-you.js";

export function openNeedsYouItem(item: NeedsYouItem): void {
  const ui = useUiStore.getState();
  if (item.kind === "withdrawal") {
    ui.setShellRoute({ kind: "vexCloudFunding", origin: null });
    return;
  }
  if (item.sessionId === null) {
    ui.setShellRoute({ kind: "needsYou", origin: null });
    return;
  }
  const alreadyOpen = ui.runtimeMode !== "studio" && ui.activeSessionId === item.sessionId;
  if (!alreadyOpen) {
    ui.setRuntimeMode("agent");
    ui.setActiveSessionId(item.sessionId);
  }
  ui.setShellRoute({ kind: "none" });
  if (item.approvalId !== null) revealApprovalCard(item.approvalId);
}

/** Scroll the approval card into view once the session has painted it. */
function revealApprovalCard(approvalId: string): void {
  requestAnimationFrame(() => {
    const card = Array.from(document.querySelectorAll<HTMLElement>("[data-approval-id]")).find(
      (node) => node.dataset["approvalId"] === approvalId,
    );
    if (card === undefined || typeof card.scrollIntoView !== "function") return;
    card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
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
