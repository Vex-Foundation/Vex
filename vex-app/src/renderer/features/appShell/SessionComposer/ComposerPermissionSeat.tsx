/**
 * The permission as its promise (docs/design/H3-DESKTOP.md section 1.8 and
 * Appendix A.5): the status strip's second cell, the session's grant as the
 * words it means for the user, FUNDS REQUIRE APPROVAL in Restricted and FULL
 * ACCESS in Full access, sans 13 caps; the tooltip explains the grant
 * (`.vex-composer-promise`, console.css). The words are written in sentence
 * case and set in caps by the sheet.
 *
 * DISPLAY-ONLY, and deliberately so. Permission is locked at session creation
 * and belongs to the approval boundary; the renderer names it, it never grants
 * or widens it. On the welcome no session exists yet, so the composer passes
 * the new session form's own preselect (Restricted); the form is where the
 * grant is chosen.
 *
 * Concession contract (the strip's shrink chain): H3 draws the words alone,
 * so while the strip has room the seat is its words and no icon; below the
 * strip container's 600px threshold (the chat with the chats column open at 1024) the words
 * collapse away and the grant's icon carries the seat, fixed (`shrink-0`).
 * The words truncate before that (`min-w-0 truncate` inside a `min-w-0`
 * seat). The ACCESSIBLE NAME lives on the seat element, not on the label
 * span, so collapsing the text can never remove the name.
 */

import type { JSX } from "react";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import {
  LineLock,
  LineShield,
  type LineIconProps,
} from "../../../components/icons/line/index.js";
import { Tooltip } from "../../../components/ui/tooltip.js";

/**
 * Strip width at which the words collapse to the icon. Shared with the status
 * strip, which declares `@container` in `SessionComposer`: under 600 the four
 * cells (the model and its effort, the promise, the state, the context) no
 * longer hold the promise's 22 caps beside the rest.
 */
export const PERMISSION_COLLAPSE_CONTAINER_PX = 600;

/** The grant's name, for the accessible name (unchanged since V10). */
const PERMISSION_NAME: Readonly<Record<SessionPermission, string>> = {
  restricted: "Restricted",
  full: "Full access",
};

/** The grant as its promise, the words the seat shows. */
const PERMISSION_PROMISE: Readonly<Record<SessionPermission, string>> = {
  restricted: "Funds require approval",
  full: "Full access",
};

const PERMISSION_ICON: Readonly<
  Record<SessionPermission, (props: LineIconProps) => JSX.Element>
> = {
  restricted: LineLock,
  full: LineShield,
};

const PERMISSION_TOOLTIP: Readonly<Record<SessionPermission, string>> = {
  restricted: "Restricted: every mutating transaction requires your approval.",
  full: "Full access: auto-executes approved tools without prompting per call.",
};

export function ComposerPermissionSeat({
  permission,
}: {
  readonly permission: SessionPermission | null;
}): JSX.Element | null {
  if (permission === null) return null;
  const Icon = PERMISSION_ICON[permission];
  return (
    <Tooltip label={PERMISSION_TOOLTIP[permission]} side="top" delayMs={300}>
      <span
        data-vex-area="composer-permission-chip"
        data-permission={permission}
        // The name rides the SEAT, not the label span: the label is allowed to
        // disappear under container pressure, the name is not.
        aria-label={`Access mode: ${PERMISSION_NAME[permission]}`}
        className="vex-composer-promise min-w-0 shrink-0"
        // The tooltip needs a hoverable, focusable box; the seat itself stays
        // static - permission is locked at creation and never toggles here.
        tabIndex={0}
      >
        {/* Icons are `aria-hidden` by their own contract. Only when the
            words have collapsed. */}
        <Icon size={16} className="hidden shrink-0 @max-[600px]:block" />
        <span
          data-vex-permission-label
          className="min-w-0 truncate @max-[600px]:hidden"
        >
          {PERMISSION_PROMISE[permission]}
        </span>
      </span>
    </Tooltip>
  );
}
