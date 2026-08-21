/**
 * Access-mode seat - the session's permission grant, seated in the composer's
 * TRAILING cluster beside the context meter (owner QA round 3, item 1).
 *
 * DISPLAY-ONLY, and deliberately so. Permission is locked at session creation
 * and belongs to the approval boundary; the renderer names it, it never grants
 * or widens it. The deepseek `PermissionSelect` is evidence for GEOMETRY only
 * (28px seat, glyph + truncating label, container collapse) - not authority
 * for Vex's authorization model.
 *
 * Concession contract (the toolbar's shrink chain):
 *  - the glyph is fixed (`shrink-0`) and never disappears;
 *  - the label truncates first (`min-w-0 truncate` inside a `min-w-0` pill);
 *  - below the row container's 460px threshold the label collapses away
 *    entirely and the glyph carries the seat. The ACCESSIBLE NAME lives on the
 *    seat element, not on the label span, so collapsing the text can never
 *    remove the name.
 */

import type { JSX } from "react";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import {
  IconKey,
  IconLock,
  type GlyphProps,
} from "../../../components/icons/index.js";
import { Pill } from "../../../components/ui/pill.js";
import { Tooltip } from "../../../components/ui/tooltip.js";

/**
 * Container width at which the label collapses to the glyph. Shared with the
 * toolbar row, which declares `@container` in `SessionComposer`. Matches the
 * reference threshold (`PermissionSelect.module.css`, `max-width: 460px`).
 */
export const PERMISSION_COLLAPSE_CONTAINER_PX = 460;

const PERMISSION_LABEL: Readonly<Record<SessionPermission, string>> = {
  restricted: "Restricted",
  full: "Full access",
};

const PERMISSION_GLYPH: Readonly<
  Record<SessionPermission, (props: GlyphProps) => JSX.Element>
> = {
  restricted: IconLock,
  full: IconKey,
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
  const label = PERMISSION_LABEL[permission];
  const Glyph = PERMISSION_GLYPH[permission];
  return (
    <Tooltip label={PERMISSION_TOOLTIP[permission]} side="top" delayMs={300}>
      <span
        data-vex-area="composer-permission-chip"
        data-permission={permission}
        // The name rides the SEAT, not the label span: the label is allowed to
        // disappear under container pressure, the name is not.
        aria-label={`Access mode: ${label}`}
        className="inline-flex min-w-0 shrink-0"
        // The tooltip needs a hoverable, focusable box; the seat itself stays
        // static - permission is locked at creation and never toggles here.
        tabIndex={0}
      >
        <Pill variant={permission === "full" ? "accent" : "neutral"}>
          {/* Glyphs are `aria-hidden` by their own contract. */}
          <Glyph size={13} className="shrink-0" />
          <span
            data-vex-permission-label
            className="min-w-0 truncate @max-[460px]:hidden"
          >
            {label}
          </span>
        </Pill>
      </span>
    </Tooltip>
  );
}
