/**
 * VEX LOADER — the brand loader for the Chronos Gate setup flow
 * (owner decree 2026-07-21: the DotMatrix grid is retired from setup
 * surfaces; boot work is announced by this ring instead).
 *
 * Anatomy: a hairline circle whose border carries ONE traveling cobalt
 * (or paper) arc — the exact masked conic-band technique of the console
 * and pending rings (`global-css/setup-gate.css`), at loader tempo
 * (1.4s/rev). The center is a slot: at hero sizes the caller mounts the
 * particle `VexSigil` inside so the VEX logo literally draws itself
 * while the ring spins; at inline sizes the slot stays empty.
 *
 * The center is a `children` slot (not a baked-in sigil import) so this
 * shared ui primitive never imports from `features/` — import direction
 * stays one-way (features → components), and ring-only consumers pay
 * zero canvas cost.
 *
 * Motion contract: the ring loops ONLY while mounted, and consumers
 * mount it only for real in-flight work (probes, compose, migrate) —
 * never decoratively. `prefers-reduced-motion` freezes the arc to a
 * static 270° band via CSS; no JS branch needed.
 *
 * A11y: `role="status"` + visually-hidden label announce the work once;
 * the spinning band itself is decorative (`aria-hidden` on the slot).
 */

import type { CSSProperties, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type VexLoaderTone = "ink" | "paper";

export interface VexLoaderProps {
  /** Outer diameter in px (the ring hugs this box). */
  readonly size?: number;
  /** Arc color family: `ink` = cobalt arc on the shell canvas (default);
   * `paper` = the pre-shell plate's arc. Historically a paper arc on the
   * solid-cobalt plate — hence the name — but since the INK REDESIGN the
   * plate is ink-navy and the tone resolves to the accent's lighter mix
   * (`global-css/setup-gate.css`). Every `tone="paper"` call site is a
   * pre-shell surface. */
  readonly tone?: VexLoaderTone;
  /** Announced once via role="status"; never rendered visually. */
  readonly label: string;
  /** Ring stroke width in px (defaults to 2 via CSS). */
  readonly stroke?: number;
  /** Optional center content (e.g. `<VexSigil />` at hero sizes). */
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
