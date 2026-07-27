/**
 * Shared review summary primitive (M11; landing rebrand — flat hairline
 * tile).
 *
 * Each domain card under `cards/` uses this to render the same
 * label / status / children / Edit-button layout. Pulling the layout
 * out keeps every domain card under ~70 LOC and prevents drift
 * between cards (e.g. one renders the Edit button at the top, another
 * at the bottom — confusing operator UX during finalize review).
 *
 * Landing rebrand: the tile mirrors the `WizardStepPanel` surface —
 * depth is a luminance step + hairline, never backdrop blur or inset
 * shadows — so the review screen reads as one continuous sheet.
 */

import type { JSX, ReactNode } from "react";
import { cn } from "../../../../../lib/utils.js";
import { Button } from "../../../../../components/ui/button.js";

export type SummaryStatus = "ok" | "missing" | "partial" | "warning" | "info";

/* Status is a colored WORD (design law: state = color + words, never a
 * dot) — the statusLabel itself carries the tone. */
const STATUS_WORD_COLOR: Record<SummaryStatus, string> = {
  ok: "text-[var(--color-success)]",
  missing: "text-[var(--color-danger)]",
  partial: "text-[var(--color-warning)]",
  warning: "text-[var(--color-warning)]",
  info: "text-[var(--color-text-muted)]",
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
  return (
    <div
      data-vex-review-card={testId}
      className={cn(
        // A3 boxless: hairline-separated register row, never a filled
        // tile — the statusLabel word carries the state color.
        "flex flex-col gap-2 border-b border-[var(--color-border)] pb-3",
        "last:border-0 last:pb-0",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">
          {title}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "vex-micro",
              STATUS_WORD_COLOR[status],
            )}
          >
            {statusLabel}
          </span>
          {onEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onEdit}
              disabled={editDisabled}
            >
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      {children ? (
        <div className="text-xs text-[var(--color-text-secondary)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}
