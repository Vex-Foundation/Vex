/**
 * Coverage badge — protection honesty made first-class (design spec §4.7).
 *
 * Every Hyperliquid position wears exactly one of four states. The vocabulary
 * is owned here (CoverageLabel) so the positions register and the badge share
 * one source of truth. Colors come from the --vex-cover-* family (token-only,
 * so the guard stays green and Hypervexing mode re-tints automatically).
 *
 * Motion law: UNPROTECTED is the loudest chrome in the shell but NEVER blinks —
 * it is loud by COLOR, still by MOTION (an alarm that animates becomes
 * wallpaper). CONSOLIDATING is the only badge that loops, and only because it
 * is a verifiably in-flight state (protection being set up) — it carries the
 * shell's pulse dot, bound to that pending work like every other loop.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";

export type CoverageLabel =
  | "protected"
  | "UNPROTECTED"
  | "consolidating"
  | "stale";

interface BadgeSpec {
  /** Leading glyph — a status mark, not decoration. */
  readonly glyph: string;
  /** Label text (CSS uppercases it). */
  readonly text: string;
  /** Full-sentence aria-label so the badge reads on its own to a screen reader. */
  readonly aria: string;
  /** Token-driven color trio (text / border / fill). */
  readonly tone: string;
  /** Only CONSOLIDATING loops — it is verifiably in-flight. */
  readonly pending: boolean;
}

const BADGES: Record<CoverageLabel, BadgeSpec> = {
  protected: {
    glyph: "✓",
    text: "Protected",
    aria: "Protected — a stop loss is confirmed on this position.",
    tone: "border-[color-mix(in_oklab,var(--vex-cover-ok)_50%,transparent)] bg-[var(--vex-cover-ok-fill)] text-[var(--vex-cover-ok)]",
    pending: false,
  },
  UNPROTECTED: {
    glyph: "⚠",
    text: "Unprotected",
    aria: "Unprotected — this position has no confirmed stop loss.",
    tone: "border-[var(--vex-cover-none-border)] bg-[var(--vex-cover-none-fill)] text-[var(--vex-cover-none)]",
    pending: false,
  },
  stale: {
    glyph: "~",
    text: "Stale",
    aria: "Protection status is stale — last confirmed a few minutes ago.",
    tone: "border-[color-mix(in_oklab,var(--vex-cover-stale)_45%,transparent)] bg-[var(--vex-cover-stale-fill)] text-[var(--vex-cover-stale)]",
    pending: false,
  },
  consolidating: {
    glyph: "◌",
    text: "Consolidating",
    aria: "Consolidating — protection is being set up for this position.",
    tone: "border-[color-mix(in_oklab,var(--vex-cover-pending)_45%,transparent)] bg-[var(--vex-cover-pending-fill)] text-[var(--vex-cover-pending)]",
    pending: true,
  },
};

export function HyperliquidCoverageBadge({
  label,
}: {
  readonly label: CoverageLabel;
}): JSX.Element {
  const spec = BADGES[label];
  return (
    <span
      // A single labeled mark (not a live region — one per row would re-announce
      // on every update); the full sentence is the accessible name.
      role="img"
      aria-label={spec.aria}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-[3px] font-mono text-[10px] uppercase leading-none tracking-[0.14em]",
        spec.tone,
      )}
    >
      {spec.pending ? (
        // Verifiably in-flight → the shell's pulse dot may loop (accent ring,
        // collapsed to a still dot under prefers-reduced-motion).
        <span
          aria-hidden
          className="vex-pulse-dot h-1 w-1 shrink-0 rounded-full bg-[var(--vex-accent)] [--vex-pulse-color:var(--vex-accent)]"
        />
      ) : (
        <span aria-hidden className="shrink-0">
          {spec.glyph}
        </span>
      )}
      <span>{spec.text}</span>
    </span>
  );
}
