/**
 * "Awaiting signature" stamp-link (S5). Rendered next to a tool act (or its
 * group header) whose `toolCallId` matches a PENDING approval. Clicking jumps
 * to the matching `ApprovalCard` (`[data-approval-id]`) and focuses it —
 * a sibling of the disclosure button, never nested inside it (nested buttons
 * are invalid HTML and break both contracts' aria semantics).
 *
 * The stamp is quiet by design (reference d4): the target swatch and the
 * caps word in the blue on a blue outline, no fill, no pulse - the card
 * itself is the place that asks for the pen. Status by fill: the target is
 * the same mark the card's own header and the island's awaiting row carry.
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
      aria-label="Awaiting signature - go to approval"
      onClick={(event) => jumpToApproval(approvalId, event.currentTarget)}
      className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="inline-flex h-[22px] items-center gap-[7px] px-2 font-mono text-[11px] uppercase leading-none tracking-chip text-accent-primary outline outline-1 -outline-offset-1 outline-accent-primary">
        <Swatch state="warning" size={9} />
        Awaiting signature
      </span>
    </button>
  );
}
