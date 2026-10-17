/**
 * VxToken: the flat vx product mark, the vx in a blue disc
 * (docs/design/R3-MINIMAL.md section 3). It sits beside Vex's messages and in
 * the title bar chip; the hologram's coin is a different asset.
 *
 * Drawn as one SVG so the disc is a circle while every box keeps radius 0:
 * a 100 unit disc with the `VexMark` path set 60 units wide at its centre.
 * The disc is the action fill (the same blue in both rooms); its 3 unit edge
 * is the accent line, which is that same blue on paper (so the disc reads
 * flat) and periwinkle at night (so it holds on night paper). Colours come
 * from `.vex-vx-token` in `ui-primitives/marks.css`.
 */

import type { JSX } from "react";
import { VexMark } from "../common/VexMark.js";
import { cn } from "../../lib/utils.js";

export interface VxTokenProps {
  /** Disc diameter in px. */
  readonly size?: number;
  /**
   * Accessible name. Omit it beside a visible word (the token is then
   * decorative and hidden from assistive technology).
   */
  readonly label?: string;
  readonly className?: string;
}

export function VxToken({ size = 24, label, className }: VxTokenProps): JSX.Element {
  const named = label !== undefined && label !== "";
  return (
    <span className={cn("vex-vx-token", className)} data-vex-vx-token="">
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role={named ? "img" : undefined}
        aria-label={named ? label : undefined}
        aria-hidden={named ? undefined : true}
        focusable="false"
      >
        <circle className="vex-vx-token__disc" cx="50" cy="50" r="48.5" strokeWidth="3" />
        <g transform="translate(20 26)" className="vex-vx-token__mark">
          <VexMark size={48} />
        </g>
      </svg>
    </span>
  );
}
