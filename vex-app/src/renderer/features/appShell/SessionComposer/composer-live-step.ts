/**
 * THE LIVE STEP ON THE RUN STRIP. The transcript holds the newest user turn
 * at the top while the reply streams (`useTranscriptScroll`), so a long reply
 * runs past the fold and takes the turn's live row (`TurnIsland`) with it.
 * The strip above the composer is always in view, so while a run is live it
 * repeats what that row says ("Calling DexScreener · Gainers", "Thinking",
 * "Writing") with the same clock, behind the moving dots.
 *
 * One derivation, the live row's own (`resolveTurnIslandView`), so the strip
 * and the row can never disagree. A pending decision stops the dots (the
 * live row's freeze: trust is stillness). Between rounds, when no preview is
 * live, the band keeps its own word ("Running") and the dots keep moving,
 * because the run still is.
 */

import type { StreamPreview } from "../../../stores/streamStore.js";
import { resolveTurnIslandView } from "../TurnIsland/islandTurnState.js";

export interface ComposerLiveStep {
  /** The live row's word, or null to keep the band's own word. */
  readonly label: string | null;
  /** Which part of the wait this is ("Waiting for the model"), or null. */
  readonly detail: string | null;
  /** The live row's clock start, or null when the row shows no clock. */
  readonly startedAtMs: number | null;
  /** A decision waits on the reader: the target fill, nothing moves. */
  readonly awaiting: boolean;
}

export const AWAITING_LABEL = "Waiting for approval";

export function resolveComposerLiveStep(
  /** The band names a live run (an agent running, a mission running). */
  running: boolean,
  preview: StreamPreview | null,
  awaitingApproval: boolean,
  leaseHeld: boolean,
): ComposerLiveStep | null {
  if (!running) return null;
  if (preview === null) {
    return {
      label: awaitingApproval ? AWAITING_LABEL : null,
      detail: null,
      startedAtMs: null,
      awaiting: awaitingApproval,
    };
  }
  const view = resolveTurnIslandView(preview, awaitingApproval, leaseHeld);
  // A settled or failed preview is not live work: the band's own word stays.
  if (view.state === "settled" || view.state === "error") {
    return { label: null, detail: null, startedAtMs: null, awaiting: false };
  }
  return {
    label: view.label,
    // Only the working wait carries a scope worth repeating; the writing
    // row's "Reasoned" stamp stays on the row.
    detail: view.state === "working" ? (view.detail ?? null) : null,
    startedAtMs: view.showElapsed ? preview.startedAtMs : null,
    awaiting: view.state === "awaiting",
  };
}
