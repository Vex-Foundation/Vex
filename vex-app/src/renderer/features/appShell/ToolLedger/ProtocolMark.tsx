/**
 * The small round protocol mark on a tool card — a bundled venue logo when the
 * curated matrix proves one, the venue's monogram ring when it does not, and
 * the act's CATEGORY glyph when there is no venue at all.
 *
 * Purely presentational; every provenance decision was already made by
 * `lib/protocol-marks.ts` (bundled same-origin assets only, never a borrowed
 * brand). Decorative: the card's adjacent title carries the accessible name.
 */

import type { JSX } from "react";
import { VexIcon, type IconGlyph } from "../../../components/icons/index.js";
import { resolveProtocolMark } from "../../../lib/protocol-marks.js";
import { cn } from "../../../lib/utils.js";

export function ProtocolMark({
  protocol,
  fallbackGlyph,
  size = 16,
  className,
}: {
  readonly protocol: string | null;
  /** Category glyph shown when no venue is proven. */
  readonly fallbackGlyph: IconGlyph;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  const mark = resolveProtocolMark(protocol);

  if (mark === null) {
    return (
      <VexIcon
        icon={fallbackGlyph}
        size={size}
        aria-hidden
        className={cn("shrink-0 text-[var(--vex-text-3)]", className)}
      />
    );
  }

  if (mark.kind === "local") {
    return (
      <img
        src={mark.src}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        data-vex-protocol-mark={mark.label}
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      data-vex-protocol-mark={mark.label}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--vex-line-strong)] font-mono uppercase leading-none text-[var(--vex-text-3)]",
        className,
      )}
    >
      {mark.initial}
    </span>
  );
}
