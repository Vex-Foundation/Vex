/**
 * The permission as its promise (docs/design/R3-MINIMAL.md section 7): the
 * session's grant, seated in the composer's TRAILING cluster beside the
 * context label, as the words it means for the user, "Funds require approval"
 * (Restricted) or "Full access", 13 / 500 blue with its icon; the tooltip
 * explains the grant (`.vex-composer-promise`, console.css).
 *
 * DISPLAY-ONLY, and deliberately so. Permission is locked at session creation
 * and belongs to the approval boundary; the renderer names it, it never grants
 * or widens it. On the welcome no session exists yet, so the composer passes
 * the new session form's own preselect (Restricted); the form is where the
 * grant is chosen.
 *
 * Concession contract (the toolbar's shrink chain):
 *  - the icon is fixed (`shrink-0`) and never disappears;
 *  - the label truncates first (`min-w-0 truncate` inside a `min-w-0` seat);
 *  - below the row container's 460px threshold the label collapses away
 *    entirely and the icon carries the seat. The ACCESSIBLE NAME lives on the
 *    seat element, not on the label span, so collapsing the text can never
 *    remove the name.
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
 * Container width at which the label collapses to the icon. Shared with the
 * toolbar row, which declares `@container` in `SessionComposer`. Matches the
 * reference threshold (`PermissionSelect.module.css`, `max-width: 460px`).
 */
export const PERMISSION_COLLAPSE_CONTAINER_PX = 460;

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
        {/* Icons are `aria-hidden` by their own contract. */}
        <Icon size={16} className="shrink-0" />
        <span
          data-vex-permission-label
          className="min-w-0 truncate @max-[460px]:hidden"
        >
          {PERMISSION_PROMISE[permission]}
        </span>
      </span>
    </Tooltip>
  );
}
