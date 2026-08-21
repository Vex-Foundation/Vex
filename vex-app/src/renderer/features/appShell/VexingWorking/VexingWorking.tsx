/**
 * "VEXING…" — the centred working mark, quieted (tokens v2): the pixel-chase
 * StateDot beside the shimmered caption and the turn-scoped elapsed counter.
 * The particle scene is retired; the dot chase and the turn shimmer are the
 * brand's working signature now, and both still themselves under reduced
 * motion.
 *
 * Mounted only in the one window where a centred surface can occupy the chat
 * column without covering anything the reader is reading — see
 * `showsCentredScene` in `TurnIsland/islandTurnState.ts` for the exact latch.
 *
 * GEOMETRY, and why it is a zero-height sticky slot rather than an absolute
 * overlay. The scene must centre itself in the VIEWPORT while contributing
 * nothing to `scrollHeight` - otherwise it moves the very floor the follow
 * model measures against. A `height: 0` sticky box pinned to the scrollport's
 * top satisfies both in either mounting mode (transcript-owns-overflow when
 * mounted alone, shell-owns-overflow inside the resident panel): it travels
 * with the scroll, its overflowing child is exactly one viewport tall
 * (`--vex-conversation-viewport`, republished by the scroll model's
 * ResizeObserver), and a zero-height box adds no scroll range. The former
 * `absolute inset-0` version centred on the TRANSCRIPT's box, which is the
 * whole conversation once the shell owns the scrollport.
 * `pointer-events: none` keeps the conversation beneath it fully interactive.
 * Announcement is NOT duplicated here: `TurnIsland`'s sr-only `role="status"`
 * already says "Vex is responding".
 */

import type { JSX } from "react";
import { StateDot } from "../../../components/ui/state-dot.js";
import { ElapsedCounter } from "../TurnIsland/ElapsedCounter.js";

const VEXING_CAPTION = "vexing…";

export function VexingWorking({
  startedAtMs,
}: {
  /** The TURN's start — the same clock the island's counter runs on. */
  readonly startedAtMs: number;
}): JSX.Element {
  return (
    <div data-vex-vexing-working aria-hidden data-vex-viewport-slot="">
      <div data-vex-viewport-scene="">
        <div className="flex items-center gap-2.5">
          <StateDot state="ongoing" size={12} />
          <span className="vex-turn-shimmer text-[13px] italic">
            {VEXING_CAPTION}
          </span>
          <span className="vex-turn-clock flex items-center">
            <ElapsedCounter startedAtMs={startedAtMs} />
          </span>
        </div>
      </div>
    </div>
  );
}
