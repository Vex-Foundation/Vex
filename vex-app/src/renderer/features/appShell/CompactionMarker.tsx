/**
 * CompactionMarker - static inline timeline marker for a committed Track-1
 * compaction (stage 8-4). The engine writes a `compaction_committed` row; this
 * renders it as the quiet rule on both sides of a 12 muted label with its blue
 * line icon (`.vex-marker`, docs/design/R3-MINIMAL.md section 6), so the
 * conversation shows where a compaction landed.
 *
 * It is NOT a live progress indicator — the live compaction state lives in
 * the SessionRuntimeBar chip (stage 7-1). A persisted row has no reliable
 * "in flight" state, so the marker is deliberately static (no dotmatrix).
 */

import type { JSX } from "react";
import { LineArchive } from "../../components/icons/line/index.js";

export function CompactionMarker({
  content,
}: {
  readonly content: string;
}): JSX.Element {
  const label =
    content.length > 0 ? content : "Conversation compacted into memory";
  return (
    <div
      data-vex-message-role="system"
      data-vex-marker="compaction"
      className="vex-marker"
    >
      <span aria-hidden className="vex-marker__rule" />
      <span className="vex-marker__label">
        <span className="vex-marker__icon">
          <LineArchive size={14} />
        </span>
        <span>{label}</span>
      </span>
      <span aria-hidden className="vex-marker__rule" />
    </div>
  );
}
