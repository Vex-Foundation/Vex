/**
 * Glass zone shell for the Hypervexing grid (design spec §13.1). Every grid
 * slot wears the SAME translucent ink over the Signal Sky, so the room reads
 * as one liquid surface: separation comes from the sky showing through the
 * grid gaps, never from borders drawn between panels.
 *
 * Owner-sanctioned glass (see the design-guard whitelist): the Hypervexing
 * workspace is a sanctioned glass surface family, deliberately scoped to this
 * single wrapper so backdrop-blur cannot leak file-by-file into the normal
 * shell. Zone components render their content only — this wrapper owns the
 * grid placement and the glass chrome.
 */

import type { JSX, ReactNode } from "react";

import { cn } from "../../../lib/utils.js";

export type HvZoneArea = "top" | "left" | "chart" | "book" | "dock" | "tabs";

export function HvZone({
  area,
  label,
  className,
  children,
}: {
  readonly area: HvZoneArea;
  /** Accessible landmark name; zones are section landmarks of the room. */
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label={label}
      style={{ gridArea: area }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--vex-line)] bg-[var(--vex-glass)] backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </section>
  );
}
