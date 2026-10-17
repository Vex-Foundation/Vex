/**
 * One row of the review grid (docs/design/R3-MINIMAL.md section 10.3): the
 * step's name after its swatch (14.5 / 500), the status word and the detail
 * under it (12.5 muted), Edit at the right (13 / 500 blue).
 *
 * Each domain card under `cards/` renders through this so the rows cannot
 * drift apart. Status is a fill plus a word: the swatch beside the name, the
 * word starting the detail line.
 */

import type { JSX, ReactNode } from "react";
import { Swatch, type SwatchState } from "../../../../../components/ui/swatch.js";

export type SummaryStatus = "ok" | "missing" | "partial" | "warning" | "info";

/* Status by fill: set is solid, part of it the target, a consequence the
 * ink hatch, nothing set or a plain note the outline. */
const STATUS_SWATCH: Record<SummaryStatus, SwatchState> = {
  ok: "done",
  missing: "idle",
  partial: "awaiting",
  warning: "concerned",
  info: "idle",
};

export interface SummaryCardProps {
  readonly title: string;
  readonly status: SummaryStatus;
  readonly statusLabel: string;
  readonly children?: ReactNode;
  readonly onEdit?: () => void;
  readonly editDisabled?: boolean;
  readonly testId?: string;
}

export function SummaryCard({
  title,
  status,
  statusLabel,
  children,
  onEdit,
  editDisabled = false,
  testId,
}: SummaryCardProps): JSX.Element {
  // A one-line detail reads after the word ("Configured · Stored locally");
  // a richer one (a list, addresses) stands under it.
  const inline = typeof children === "string";
  return (
    <div data-vex-review-card={testId} className="vex-wz-sum__c">
      <p className="vex-wz-sum__n">
        <Swatch state={STATUS_SWATCH[status]} size={10} />
        {title}
      </p>
      <div className="vex-wz-sum__d">
        <span>
          {statusLabel}
          {inline ? ` · ${children}` : null}
        </span>
        {!inline && children ? <div className="mt-1">{children}</div> : null}
      </div>
      {onEdit ? (
        <div className="vex-wz-sum__a">
          <button
            type="button"
            className="vex-wz-link"
            onClick={onEdit}
            disabled={editDisabled}
          >
            Edit
          </button>
        </div>
      ) : null}
    </div>
  );
}
