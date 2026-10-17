/**
 * ErrorCallout: the ink callout for a failure (docs/design/R3-MINIMAL.md
 * sections 6 and 12). Never red: a 1.5px ink frame with an 8px hatch band on
 * its left edge, the error swatch beside the title ("This turn failed"), then
 * the cause line, the hint, any keys, and a muted code trailer. Dismiss sits
 * at the right of the title row when the owner offers it.
 *
 * `state="concerned"` takes the ink hatch for a condition that clears on its
 * own (too many attempts, offline). `compact` is the form and unlock alert:
 * tighter padding, the hint in 13 muted.
 *
 * It is NOT a live region by default: announcement belongs to whoever raised
 * the failure (a model's live region, a `role` the owner passes), so a
 * callout that mounts below the fold is never announced twice.
 *
 * Styles: `.vex-callout` in `ui-primitives/indicators.css`.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Swatch } from "./swatch.js";

export interface ErrorCalloutProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** What failed, in a sentence: "This turn failed". */
  readonly title: ReactNode;
  /** The fill beside the title. */
  readonly state?: "error" | "concerned";
  /** The cause line. */
  readonly cause?: ReactNode;
  /** What to do, or what happens next. */
  readonly hint?: ReactNode;
  /** Keys under the text (Retry, Open logs folder). */
  readonly actions?: ReactNode;
  /** The technical trailer, set as a figure ("rate_limit_exceeded · HTTP 429"). */
  readonly code?: string;
  /** Offers Dismiss at the right of the title row. */
  readonly onDismiss?: () => void;
  /** Accessible name for Dismiss when the visible word needs context. */
  readonly dismissLabel?: string;
  /** The form and unlock alert register. */
  readonly compact?: boolean;
}

export function ErrorCallout({
  title,
  state = "error",
  cause,
  hint,
  actions,
  code,
  onDismiss,
  dismissLabel,
  compact = false,
  className,
  ...rest
}: ErrorCalloutProps): JSX.Element {
  return (
    <div
      className={cn("vex-callout", className)}
      data-vex-callout={state}
      data-compact={compact ? "" : undefined}
      {...rest}
    >
      <div className="vex-callout__title">
        <Swatch state={state} size={10} />
        <span className="min-w-0 flex-1">{title}</span>
        {onDismiss === undefined ? null : (
          <button
            type="button"
            className="vex-callout__dismiss"
            aria-label={dismissLabel}
            onClick={onDismiss}
          >
            Dismiss
          </button>
        )}
      </div>
      {cause === undefined || cause === null ? null : (
        <div className="vex-callout__cause">{cause}</div>
      )}
      {hint === undefined || hint === null ? null : (
        <div className="vex-callout__hint">{hint}</div>
      )}
      {actions === undefined || actions === null ? null : (
        <div className="vex-callout__actions">{actions}</div>
      )}
      {code === undefined || code === "" ? null : (
        <div className="vex-callout__code">{code}</div>
      )}
    </div>
  );
}
