/**
 * VEX LOADER: the quiet loading line (docs/design/R3-MINIMAL.md sections 11
 * and 12). A word and a quiet line, never a skeleton of fake numbers and
 * never a spinner: a 2px track in the quiet rule with one blue segment that
 * steps along it. The pattern lives in `ui-primitives/marks.css`. The visible
 * word belongs to the caller (a swatch and a word beside the line); this
 * primitive announces its label once and draws the line.
 *
 * Motion contract: the segment loops ONLY while mounted, and consumers mount
 * it only for real in-flight work, never decoratively. `prefers-reduced-motion`
 * and `data-still` rest it in place via CSS; no JS branch is needed.
 *
 * `size` is the line's length in px (120 by default, the R3 loading line) and
 * `stroke` its thickness (2 by default). The V10 centre slot is gone: a line
 * has no centre, and no caller filled it.
 *
 * A11y: `role="status"` + visually-hidden label announce the work once; the
 * line itself is decorative.
 */

import type { CSSProperties, JSX } from "react";
import { cn } from "../../lib/utils.js";

export type VexLoaderTone = "ink" | "paper";

export interface VexLoaderProps {
  /** Length of the line in px. */
  readonly size?: number;
  /** Ink family: `ink` = the theme's accent on the shell canvas (default);
   * `paper` = paper on the dark pre-shell plate. Every `tone="paper"` call
   * site is a pre-shell surface. */
  readonly tone?: VexLoaderTone;
  /** Announced once via role="status"; never rendered visually. */
  readonly label: string;
  /** Thickness of the line in px (defaults to 2 via CSS). */
  readonly stroke?: number;
  readonly className?: string;
}

/** The R3 loading line's length. */
const LINE_LENGTH_PX = 120;

export function VexLoader({
  size = LINE_LENGTH_PX,
  tone = "ink",
  label,
  stroke,
  className,
}: VexLoaderProps): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-vex-loader={tone}
      className={cn(
        "vex-loader",
        tone === "paper" ? "vex-loader--paper" : "vex-loader--ink",
        className,
      )}
      style={
        {
          width: size,
          ...(stroke !== undefined
            ? { "--vex-loader-stroke": `${stroke}px` }
            : {}),
          // Custom-property inline style: a CSSOM property write, CSP-safe
          // (MOTION-POLICY.md).
        } as CSSProperties
      }
    >
      <span className="sr-only">{label}</span>
      {/* Empty, so assistive technology has nothing to read in it. */}
      <i className="vex-loader__segment" />
    </div>
  );
}
