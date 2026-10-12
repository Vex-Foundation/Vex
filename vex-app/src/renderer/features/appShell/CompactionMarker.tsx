/**
 * CompactionMarker — static inline timeline marker for a committed Track-1
 * compaction (stage 8-4, S3 ledger-interruption grammar). The engine writes a
 * `compaction_committed` row; this renders it as a centered hairline rule with
 * a mono microtype label so the chat register shows where a compaction landed.
 *
 * It is NOT a live progress indicator — the live compaction state lives in
 * the SessionRuntimeBar chip (stage 7-1). A persisted row has no reliable
 * "in flight" state, so the marker is deliberately static (no dotmatrix).
 */

import type { JSX } from "react";
import { IconArchive } from "../../components/icons/index.js";

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
      className="flex items-center gap-3"
    >
      <span aria-hidden className="h-px flex-1 bg-rule-quiet" />
      <span className="flex min-w-0 items-center gap-2 text-ink-secondary">
        <span className="inline-flex text-accent-primary">
          <IconArchive size={12} />
        </span>
        <span className="break-words font-mono text-[11px] uppercase tracking-status">
          {label}
        </span>
      </span>
      <span aria-hidden className="h-px flex-1 bg-rule-quiet" />
    </div>
  );
}
