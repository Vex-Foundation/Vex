/**
 * "Waiting for approval" link (S5). Rendered next to a step (or its fold)
 * whose `toolCallId` matches a PENDING approval. Clicking jumps to the
 * matching `ApprovalCard` (`[data-approval-id]`) and focuses it - a sibling of
 * the disclosure button, never nested inside it (nested buttons are invalid
 * HTML and break both contracts' aria semantics).
 *
 * Quiet by design (docs/design/R3-MINIMAL.md section 6): the word in the blue
 * at 13 / 500 with the target fill, no frame, no pulse - the card itself is
 * the place that asks for the decision. The target is the same fill the card,
 * the live row and the Vex sidebar carry for this state.
 */

import type { JSX } from "react";
import { Swatch } from "../../../components/ui/swatch.js";

/**
 * Escape an approval id for the attribute selector. `CSS.escape` is the
 * platform answer but jsdom (the test env) does not define `CSS`; the
 * fallback escapes the only two characters that can break out of a
 * double-quoted attribute string.
 */
function escapeForSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Scroll to + focus the approval card. The card carries `tabIndex={-1}` so
 * programmatic focus lands on the region itself (screen readers announce it).
 * jsdom implements neither `scrollIntoView` nor `matchMedia`; both are
 * feature-checked so the link degrades to focus-only instead of throwing.
 *
 * A3: the same approval can also render in the global header inbox panel
 * (outside the session panel). Scope the lookup to the stamp's own session
 * panel so a ledger stamp-click always focuses the INLINE card, never the
 * header-panel copy (which precedes it in document order). Fall back to the
 * document only when there is no enclosing panel (defensive / isolated mounts).
 */
function jumpToApproval(approvalId: string, trigger: HTMLElement): void {
  const scope: ParentNode =
    trigger.closest<HTMLElement>('[data-vex-area="session-panel"]') ?? document;
  const card = scope.querySelector<HTMLElement>(
    `[data-approval-id="${escapeForSelector(approvalId)}"]`,
  );
  if (card === null) return;
  if (typeof card.scrollIntoView === "function") {
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }
  card.focus({ preventScroll: true });
}

export function ApprovalLinkStamp({
  approvalId,
}: {
  readonly approvalId: string;
}): JSX.Element {
  return (
    <button
      type="button"
      data-vex-approval-link={approvalId}
      aria-label="Waiting for approval: go to the approval"
      onClick={(event) => jumpToApproval(approvalId, event.currentTarget)}
      className="vex-step-await"
    >
      <Swatch state="awaiting" size={10} />
      Waiting for approval
    </button>
  );
}
