/**
 * VEX LOADER: the brand loader for the boot and setup flow, drawn as the
 * ongoing swatch at size (docs/design/V10-SPREAD.md section 1): a square
 * outline filled with a dot screen that steps through four positions. The
 * pattern lives in `ui-primitives/marks.css`. The center is a `children` slot
 * (no baked-in feature artwork) so this shared primitive never imports from
 * `features/`; inline sizes leave it empty.
 *
 * Motion contract: the screen steps ONLY while mounted, and consumers mount
 * it only for real in-flight work (probes, the runtime start, migrate), never
 * decoratively. `prefers-reduced-motion` and `data-still` freeze it to one
 * still frame via CSS; no JS branch is needed.
 *
 * A11y: `role="status"` + visually-hidden label announce the work once; the
 * pattern itself is decorative (`aria-hidden` on the slot).
 */

import type { CSSProperties, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type VexLoaderTone = "ink" | "paper";

export interface VexLoaderProps {
  /** Outer edge in px. */
  readonly size?: number;
  /** Ink family: `ink` = the theme's accent on the shell canvas (default);
   * `paper` = paper on the dark pre-shell plate. Every `tone="paper"` call
   * site is a pre-shell surface. */
  readonly tone?: VexLoaderTone;
  /** Announced once via role="status"; never rendered visually. */
  readonly label: string;
  /** Outline width in px (defaults to 1 via CSS). */
  readonly stroke?: number;
  /** Optional center content (e.g. a brand mark at hero sizes). */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function VexLoader({
  size = 40,
  tone = "ink",
  label,
  stroke,
  children,
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
          height: size,
          ...(stroke !== undefined
            ? { "--vex-loader-stroke": `${stroke}px` }
            : {}),
          // Custom-property inline style — the repo's DotMatrix idiom
          // (see dotm-square-3.tsx); CSSOM property writes, CSP-safe.
        } as CSSProperties
      }
    >
      <span className="sr-only">{label}</span>
      {children !== undefined && children !== null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-[14%] select-none"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
