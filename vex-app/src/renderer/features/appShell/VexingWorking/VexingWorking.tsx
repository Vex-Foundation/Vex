/**
 * "VEXING…" — the centred working scene, composed.
 *
 * The particle mark, the caption beneath it, and the SAME turn-scoped elapsed
 * counter the island has always shown. It replaces the word "Working" with the
 * app's own signature gesture (owner brief §7), and it is mounted only in the
 * one window where a centred surface can occupy the chat column without
 * covering anything the reader is reading — see `showsCentredScene` in
 * `TurnIsland/islandTurnState.ts` for the exact latch.
 *
 * Positioned ABSOLUTE over the transcript frame and OUTSIDE the scroller, so it
 * contributes nothing to `scrollHeight` and the anchor-spacer / "↓ latest"
 * measurements are untouched. `pointer-events-none` keeps the conversation
 * beneath it fully interactive.
 *
 * The caption wears `.vex-preview-shimmer`, the same "Vex is present" mark the
 * island's status word and the VEX speaker caption use — so it speaks one
 * dialect, and it stills for free under reduced motion. Announcement is NOT
 * duplicated here: `TurnIsland`'s sr-only `role="status"` already says "Vex is
 * responding", and saying it twice would be worse than not saying it.
 */

import type { JSX } from "react";
import { ElapsedCounter } from "../TurnIsland/ElapsedCounter.js";
import { VexingScene } from "./VexingScene.js";

/** The caption, kept beside its shimmer twin so both read the same glyphs. */
const VEXING_CAPTION = "vexing…";

export function VexingWorking({
  startedAtMs,
}: {
  /** The TURN's start — the same clock the island's counter runs on. */
  readonly startedAtMs: number;
}): JSX.Element {
  return (
    <div
      data-vex-vexing-working
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
    >
      <div className="flex flex-col items-center gap-3">
        <VexingScene className="h-40" />
        <span className="flex items-baseline gap-2">
          <span
            className="vex-preview-shimmer font-serif text-[13px] italic text-[var(--vex-text-2)]"
            data-shimmer-text={VEXING_CAPTION}
          >
            {VEXING_CAPTION}
          </span>
          <ElapsedCounter startedAtMs={startedAtMs} />
        </span>
      </div>
    </div>
  );
}
