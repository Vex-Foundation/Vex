/**
 * THE CENTRED "VEXING…" SCENE, as the transcript mounts it.
 *
 * Move-only extraction from `SessionTranscript.tsx` when the polish wave pushed
 * that file toward the 550-line limit. Behaviour is unchanged: the same
 * predicate, the same element, the same position.
 *
 * WHERE THIS MUST RENDER, and why it is a component rather than a branch inside
 * the row list: it is a SIBLING of the scroller, never a descendant. Inside the
 * scrolled content it would add height to `scrollHeight` and corrupt the
 * anchor-spacer and "↓ latest" measurements the scroll model depends on. As an
 * absolutely-positioned sibling it changes no layout at all.
 *
 * The decision itself stays split in two on purpose: `turnPreview.ts` owns the
 * transcript-evidence latch (has this send's viewport-safe live user anchor
 * landed, and has anything answered it yet), and `showsCentredScene` owns the
 * conditions visible in the preview — including the awaiting-signature freeze.
 */

import type { JSX } from "react";
import type { StreamPreview } from "../../../stores/streamStore.js";
import { showsCentredScene } from "../TurnIsland/islandTurnState.js";
import { VexingWorking } from "../VexingWorking/index.js";

export function VexingOverlay({
  preview,
  centredSceneEligible,
  awaitingApproval,
}: {
  readonly preview: StreamPreview | null;
  /** The transcript-evidence latch (`turnPreview.ts`). */
  readonly centredSceneEligible: boolean;
  readonly awaitingApproval: boolean;
}): JSX.Element | null {
  if (preview === null) return null;
  if (!showsCentredScene(preview, centredSceneEligible, awaitingApproval)) {
    return null;
  }
  return <VexingWorking startedAtMs={preview.startedAtMs} />;
}

/**
 * Whether the centred scene owns the column — the island reads this to stand
 * its `working` pill down so the same fact is never stated twice. Exported
 * beside the component so both answers come from ONE predicate call site.
 */
export function isCentredSceneUp(
  preview: StreamPreview | null,
  centredSceneEligible: boolean,
  awaitingApproval: boolean,
): boolean {
  return (
    preview !== null &&
    showsCentredScene(preview, centredSceneEligible, awaitingApproval)
  );
}
