/**
 * The three steps of the native runtime's start as quiet hairline rows, the
 * service-row grammar of the setup screens: an inline VexLoader while a step
 * works, then a colored status word once it settles. The model row carries
 * the download as bytes, speed and percent over the progress line. The
 * migration screen draws its steps with the same rows.
 *
 * `data-step` / `data-status` on each row are the test and e2e contract.
 */

import type { JSX } from "react";

import { VexLoader } from "../../../components/ui/vex-loader.js";
import { cn } from "../../../lib/utils.js";
import type { StepRow, StepStatus } from "./steps.js";

const statusInk: Record<StepStatus, string> = {
  waiting: "text-ink-tertiary",
  active: "text-ink-secondary",
  ready: "text-[var(--color-success)]",
  failed: "text-[var(--color-danger)]",
};

/**
 * A row as drawn. The runtime screen's `StepRow` is one; the migration screen
 * draws its own steps through the same grammar.
 */
export interface StepRowView extends Omit<StepRow, "step"> {
  readonly step: string;
}

export function StepRows({ rows }: { readonly rows: readonly StepRowView[] }): JSX.Element {
  return (
    <ul className="flex w-full flex-col">
      {rows.map((row) => (
        <li
          key={row.step}
          className="flex flex-col gap-2.5 border-t border-[var(--color-border)] py-4 first:border-t-0"
          data-step={row.step}
          data-status={row.status}
        >
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-ink-primary">
                {row.label}
              </span>
              <span className="truncate font-mono text-xs tabular-nums text-ink-tertiary">
                {row.detail}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              {row.status === "active" ? (
                <VexLoader size={16} stroke={2} label={`${row.label} ${row.word}`} />
              ) : null}
              <span className={cn("vex-micro tabular-nums", statusInk[row.status])}>
                {row.word}
              </span>
            </span>
          </div>
          {row.download !== null ? (
            <div
              className="h-0.5 w-full overflow-hidden bg-gate-rail"
              role="progressbar"
              aria-label="Embeddings model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.download.percent}
            >
              <div
                className="h-full bg-[var(--color-accent-primary)] transition-[width] duration-150 ease-out"
                style={{ width: `${String(row.download.percent)}%` }}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
