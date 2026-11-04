/**
 * THE DECISION ROW'S SEAT (docs/design/H3-DESKTOP.md sections 1.8 and 4.3).
 *
 * While a card waits in a chat, H3 draws the card's decision row in the
 * shell's bottom row under the chat: Reject, a middle cell, the approve key,
 * with the reason field over them where the composer's strip was. The
 * composer gives way to it. On desktop the chat's bottom-row cell is the
 * composer seat (`SessionPanel`, `[data-vex-composer-seat]`), so the seat
 * holds one empty element, the dock, and hands it down through this context;
 * the card in the chat (`ApprovalsRegion`) renders its decision footer into
 * it with a portal.
 *
 * WHY A PORTAL AND NOT A SECOND SET OF KEYS. Every piece of the decision
 * lives in `ApprovalCard`: the armed key and its 4 second reset, the
 * click lock, the in-flight words, the reason the person typed, the first
 * focus on Reject. A portal renders the SAME `ApprovalDecisionActions` with
 * the SAME props and handlers somewhere else in the document, so the decision
 * cannot drift from the card's; React events still travel the component tree.
 * Only where the keys are drawn changes.
 *
 * No dock (the Needs you page, the global panel, the Lighter desk's dialog,
 * the desk chat's embedded panel, a test that renders the card alone) means
 * the footer stays inside the card exactly as before.
 */

import { createContext, useContext } from "react";

/** The chat's decision-row seat, or `null` where the card keeps its own footer. */
export const ApprovalDockContext = createContext<HTMLElement | null>(null);

export const ApprovalDockProvider = ApprovalDockContext.Provider;

/** The dock element this chat offers its waiting card, if any. */
export function useApprovalDock(): HTMLElement | null {
  return useContext(ApprovalDockContext);
}
