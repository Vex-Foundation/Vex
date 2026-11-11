/**
 * VEX LOADER: the loading hatch (docs/design/H3-DESKTOP.md sections 5.6 and
 * 5.9; VEX Cloud's `.vx-stripes`, "the stepping hatch beside a loading word,
 * the loader gate's cell"). A 14 square of 135 degree strokes that blinks on
 * two steps once every 1200ms: never a spinner, never a sweep, never a
 * skeleton of fake numbers. It replaces R3's quiet loading line (the 2px
 * track and its stepping blue segment). The visible word belongs to the
 * caller; this primitive announces its label once and draws the hatch.
 *
 * Motion contract: the hatch loops ONLY while mounted, and consumers mount it
 * only for real in-flight work (probes, the runtime start, migrate), never
 * decoratively. Reduced motion and `data-still` hold it still in CSS
 * (`ui-primitives/marks.css`); no JS branch is needed.
 *
 * `tone`: `ink` (default) draws the hatch in ink 2 on the shell; `paper` in
 * ink on the dark pre-shell plate. `size` and `stroke` were the R3 line's
 * length and thickness; a hatch is always 14, so they are accepted for the
 * call sites that still pass them and draw nothing.
 *
 * A11y: `role="status"` + visually-hidden label announce the work once; the
 * hatch itself is decorative.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";
import { LoadingHatch } from "./cover.js";

export type VexLoaderTone = "ink" | "paper";

export interface VexLoaderProps {
  /** @deprecated The R3 line's length: a hatch is always 14. Accepted, unused. */
  readonly size?: number;
  /** Ink family: `ink` = ink 2 on the shell (default); `paper` = ink on the
   * dark pre-shell plate. Every `tone="paper"` call site is a pre-shell
   * surface. */
  readonly tone?: VexLoaderTone;
  /** Announced once via role="status"; never rendered visually. */
  readonly label: string;
  /** @deprecated The R3 line's thickness. Accepted, unused. */
  readonly stroke?: number;
  readonly className?: string;
}

export function VexLoader({ tone = "ink", label, className }: VexLoaderProps): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-vex-loader={tone}
      className={cn(
        "vex-loader-hatch",
        tone === "paper" ? "vex-loader-hatch--paper" : "vex-loader-hatch--ink",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      <LoadingHatch />
    </div>
  );
}
