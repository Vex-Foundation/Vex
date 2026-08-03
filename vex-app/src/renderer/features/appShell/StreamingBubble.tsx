/**
 * THE IN-FLIGHT TURN — a thin mount point.
 *
 * Two responsibilities only, both about the ANSWER:
 *  1. mount the `TurnIsland` (which owns every live-state presentation:
 *     Working → Thinking → Calling → Writing, the elapsed counter, the
 *     awaiting-signature freeze, the sr-only announcements, the error branch);
 *  2. stream the answer markdown BELOW it, in the same gutter grammar as a
 *     persisted assistant row (relative pl-9).
 *
 * The `useMemo` on `preview.text` is load-bearing and must not be inlined: a
 * reasoning flush re-renders this component, and without the memo the ANSWER
 * subtree would be rebuilt on every reasoning delta. The island's live
 * reasoning is memoized for the mirror-image reason, and both bodies parse
 * through the same memoized `MarkdownContent`.
 *
 * When the canonical message DTO lands, `useStreamPreviewSync` clears the
 * whole preview and the persisted row takes over seamlessly — the island's
 * closing "Reasoned" stamp is the same grammar as the persisted
 * `ReasonedBlock` (`reasoning-stamp.ts`).
 */

import { useMemo, type JSX } from "react";
import type { StreamPreview } from "../../stores/streamStore.js";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { TurnIsland } from "./TurnIsland/index.js";

export function StreamingBubble({
  preview,
  awaitingApproval = false,
}: {
  readonly preview: StreamPreview;
  /** Pending approval in the active session — freezes the island (S5). */
  readonly awaitingApproval?: boolean;
}): JSX.Element {
  const streaming = preview.phase === "streaming";

  // Memoized on the answer text: a reasoning flush must not rebuild the
  // markdown answer body.
  const answerBody = useMemo(
    () =>
      preview.text.length > 0 ? (
        // Resolves in once beneath the island — clarity "earned" by the
        // thinking. One-shot on first mount; text deltas reuse the same node
        // so it never re-triggers. The reading register (Instrument Sans
        // 15px/1.65) arrives with `.vex-chat-prose` inside MarkdownContent, so
        // the live answer and the persisted row it becomes are set identically.
        <div className="vex-answer-resolve break-words text-foreground">
          <MarkdownContent text={preview.text} />
        </div>
      ) : null,
    [preview.text],
  );

  return (
    <div
      data-vex-area="stream-preview"
      data-vex-message-role="assistant"
      data-vex-stream-phase={preview.phase}
      aria-busy={streaming}
      className="relative flex flex-col gap-2 pl-9"
    >
      <TurnIsland preview={preview} awaitingApproval={awaitingApproval} />
      {/* The raw provider text never renders on the error path. */}
      {preview.phase === "error" ? null : answerBody}
    </div>
  );
}
