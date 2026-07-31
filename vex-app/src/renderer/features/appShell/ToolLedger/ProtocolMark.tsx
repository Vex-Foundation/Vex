/**
 * The small round protocol mark on a tool card — a bundled venue logo when the
 * curated matrix proves one, the venue's monogram ring when it does not, and
 * the act's CATEGORY glyph when there is no venue at all.
 *
 * Transcript-side WRAPPER only: it owns the venue-string → resolution step and
 * the category-glyph fallback the feed rows do not have. The artwork itself is
 * rendered by the ONE mark renderer, `components/common/ProtocolMark.tsx`, so
 * the two surfaces cannot drift apart.
 *
 * Every provenance decision was already made by `lib/protocol-marks.ts`
 * (bundled same-origin assets only, never a borrowed brand). Decorative: the
 * card's adjacent title carries the accessible name.
 */

import type { JSX } from "react";
import { ProtocolMark as VenueMark } from "../../../components/common/ProtocolMark.js";
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

  return <VenueMark mark={mark} size={size} className={className} />;
}
