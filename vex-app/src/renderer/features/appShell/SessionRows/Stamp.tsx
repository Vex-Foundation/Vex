/** NOTARY exception stamp — metadata appears ONLY when it deviates from
 * the default (silence-by-default law). The mark is the LEDGER TICK: the
 * same vertical bar the selection beam wears (`.vex-select-beam::before`),
 * shrunk to stamp scale — an entry marked in the ledger, not a generic
 * bordered chip. Label sits in the sans small-caps register (`.vex-micro`;
 * mono uppercase is retired shell-wide) over a whisper tint of the tone —
 * no hairline border: the tick carries the tone, the tint carries the box.
 * On the selection beam (`.vex-select-beam`) the accent/amber inks sink
 * into the gradient, so `onBeam` flips tick + label to the beam's contrast
 * ink (white on cobalt, ink on a light accent beam) via
 * `--vex-accent-contrast`. */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";

export function Stamp({
  tone,
  onBeam = false,
  children,
}: {
  readonly tone: "accent" | "warn";
  /** Host row is painted with the cobalt selection beam. */
  readonly onBeam?: boolean;
  readonly children: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "vex-micro inline-flex items-center gap-1.5 rounded-[3px] py-[3px] pl-1.5 pr-2 font-medium leading-none",
        onBeam
          ? "bg-[color-mix(in_oklab,var(--vex-accent-contrast)_16%,transparent)] text-[var(--vex-accent-contrast)]"
          : tone === "accent"
            ? "bg-[var(--vex-accent-fill-8)] text-[var(--vex-accent-text)]"
            : "bg-[color-mix(in_oklab,var(--color-warning)_9%,transparent)] text-warning",
      )}
    >
      {/* The ledger tick — bg-current so it always shares the label's ink. */}
      <span
        aria-hidden
        className="h-2 w-[2px] shrink-0 rounded-full bg-current"
      />
      {children}
    </span>
  );
}
