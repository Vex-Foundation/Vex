/**
 * Compaction-history section of the Memory panel (7-2a) + retry
 * (8-5).
 *
 * The active session's compaction-generation timeline — when older messages
 * were compacted into memory — gated on an active session. A
 * `permanently_failed` generation gets a Retry button that re-enqueues it
 * (the one user-initiated compaction action); the button is disabled while its
 * retry is in flight, and a failed retry surfaces an inline error.
 */

import { useCallback, type JSX } from "react";
import type { CompactionHistoryItem } from "@shared/schemas/compaction.js";
import {
  useCompactionHistory,
  useRetryCompaction,
} from "../../lib/api/compaction.js";
import {
  Empty,
  ErrorState,
  Loading,
  PILL,
  SECTION,
  fmtDate,
} from "./MemoryPanelShared.js";

export function CompactionHistorySection({
  sessionId,
}: {
  readonly sessionId: string | null;
}): JSX.Element {
  const query = useCompactionHistory(sessionId);
  const retry = useRetryCompaction();

  const onRetry = useCallback(
    (generation: number): void => {
      if (sessionId === null || sessionId.length === 0) return;
      retry.mutate({ sessionId, checkpointGeneration: generation });
    },
    [retry, sessionId],
  );

  // A failed retry resolves with `ok:false` (mapped error); `isError` covers a
  // thrown transport failure.
  const retryError =
    retry.data && !retry.data.ok
      ? retry.data.error.message
      : retry.isError
        ? "Unable to retry compaction."
        : null;
  const pendingGeneration =
    retry.isPending && retry.variables !== undefined
      ? retry.variables.checkpointGeneration
      : null;

  return (
    <section data-vex-section="compaction-history" className={SECTION}>
      <div>
        <h2 className="vex-eyebrow">Compaction history</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          When this session&apos;s older messages were compacted into memory.
        </p>
      </div>
      {retryError !== null ? <ErrorState message={retryError} /> : null}
      {sessionId === null || sessionId.length === 0 ? (
        <Empty label="Open a session to view its compaction history." />
      ) : (
        <CompactionHistoryList
          query={query}
          onRetry={onRetry}
          pendingGeneration={pendingGeneration}
        />
      )}
    </section>
  );
}

function CompactionHistoryList({
  query,
  onRetry,
  pendingGeneration,
}: {
  readonly query: ReturnType<typeof useCompactionHistory>;
  readonly onRetry: (generation: number) => void;
  readonly pendingGeneration: number | null;
}): JSX.Element {
  if (query.isLoading) return <Loading label="Loading compaction history…" />;
  const res = query.data;
  if (res === undefined || !res.ok) {
    return (
      <ErrorState
        message={
          res && !res.ok ? res.error.message : "Unable to load compaction history."
        }
      />
    );
  }
  if (res.data === null) {
    return <Empty label="No compaction history for this session." />;
  }
  if (res.data.length === 0) {
    return <Empty label="No compactions have run for this session yet." />;
  }
  // Hairline-separated ledger rows — no card boxes, no gaps.
  return (
    <ul className="flex flex-col">
      {res.data.map((h) => (
        <CompactionRow
          key={h.checkpointGeneration}
          item={h}
          onRetry={onRetry}
          pending={pendingGeneration === h.checkpointGeneration}
        />
      ))}
    </ul>
  );
}

function CompactionRow({
  item,
  onRetry,
  pending,
}: {
  readonly item: CompactionHistoryItem;
  readonly onRetry: (generation: number) => void;
  readonly pending: boolean;
}): JSX.Element {
  const range =
    item.sourceStartMessageId !== null && item.sourceEndMessageId !== null
      ? `#${item.sourceStartMessageId}–#${item.sourceEndMessageId}`
      : item.sourceEndMessageId !== null
        ? `…#${item.sourceEndMessageId}`
        : "-";
  return (
    <li
      data-vex-compaction-generation={item.checkpointGeneration}
      data-status={item.status}
      className="flex flex-wrap items-center gap-2 border-b border-line-2 px-1 py-2 text-xs text-ink-secondary last:border-b-0"
    >
      <span className={PILL}>gen {item.checkpointGeneration}</span>
      <span className={PILL}>{item.status}</span>
      <span className={PILL}>msgs {range}</span>
      <span className={PILL}>{item.chunksInserted} chunks</span>
      {item.status === "permanently_failed" ? (
        // The one user action in the panel — a quiet accent key, not a fill.
        <button
          type="button"
          onClick={() => onRetry(item.checkpointGeneration)}
          disabled={pending}
          aria-label={`Retry compaction generation ${item.checkpointGeneration}`}
          className="rounded-[3px] border border-accent-primary px-1.5 py-0.5 font-doto text-[11px] uppercase tracking-[0.14em] text-accent-primary transition-colors hover:border-accent-primary hover:bg-accent-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:border-line-3 disabled:text-ink-tertiary"
        >
          {pending ? "Retrying…" : "Retry"}
        </button>
      ) : null}
      <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-tertiary">
        {fmtDate(item.completedAt ?? item.createdAt)}
      </span>
    </li>
  );
}
