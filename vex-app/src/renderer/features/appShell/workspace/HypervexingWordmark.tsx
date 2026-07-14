/**
 * The Hypervexing wordmark — "Hyper" in the UI sans (600) + "vexing" in
 * Instrument Serif italic accent, baseline-aligned with no gap. Mirrors the
 * `Hyper·liquid` wordmark pattern WITHOUT their typeface: the serif italic is
 * the only decorative type in the mode, used as punctuation. Never animated at
 * rest. Shared by the top bar and the first-entry ack card.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";

export function HypervexingWordmark({
  className,
}: {
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      className={cn("inline-flex items-baseline leading-none", className)}
      // One accessible name so a screen reader reads the brand, not two runs.
      aria-label="Hypervexing"
    >
      <span aria-hidden className="font-semibold tracking-[-0.01em] text-[var(--vex-text)]">
        Hyper
      </span>
      <span
        aria-hidden
        className="font-serif italic text-[var(--vex-accent-text)]"
      >
        vexing
      </span>
    </span>
  );
}
