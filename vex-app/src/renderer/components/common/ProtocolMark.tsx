/**
 * Protocol mark — the small round venue logo beside an activity row's badge.
 *
 * The rendering half of `lib/protocol-marks.ts` (the resolver owns which
 * venue is allowed which artwork), mirroring how `TokenMark` in this folder
 * renders a `resolveTokenMark` resolution. Bundled assets only — no remote
 * logo fetching, ever.
 *
 * The mark is decorative but NOT anonymous: the resolved venue label rides
 * the `title` so a hover names the protocol, while the row's own text stays
 * the accessible content.
 */

import type { JSX } from "react";
import type { ProtocolMarkResolution } from "../../lib/protocol-marks.js";
import { cn } from "../../lib/utils.js";

export function ProtocolMark({
  mark,
  size = 14,
  className,
}: {
  readonly mark: ProtocolMarkResolution | null;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element | null {
  if (mark === null) return null;

  if (mark.kind === "local") {
    return (
      <img
        src={mark.src}
        alt=""
        aria-hidden
        title={mark.label}
        width={size}
        height={size}
        draggable={false}
        className={cn("block shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={mark.label}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--vex-line-strong)] font-mono uppercase leading-none text-[var(--vex-text-3)]",
        className,
      )}
    >
      {mark.initial}
    </span>
  );
}
