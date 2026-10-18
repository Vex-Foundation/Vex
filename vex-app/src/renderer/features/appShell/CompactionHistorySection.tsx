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
import { Button } from "../../components/ui/button.js";
import {
  Empty,
  ErrorState,
  Loading,
  PILL,
  SECTION,
  SectionHead,
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
      <SectionHead
        title="Compaction history"
        lead="When this session's older messages were compacted into memory."
      />
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
  // Hairline-separated ledger rows, no card boxes, no gaps.
  return (
    <ul className="vex-mem-list">
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
      className="vex-mem-row"
      data-untitled=""
    >
      <span className="vex-mem-row__m">
        <span className={PILL} data-figure>
          gen {item.checkpointGeneration}
        </span>
        <span className={PILL}>{item.status}</span>
        <span className={PILL} data-figure>
          msgs {range}
        </span>
        <span className={PILL} data-figure>
          {item.chunksInserted} chunks
        </span>
        {item.status === "permanently_failed" ? (
          // The one user action in the panel: a small quiet key, not a fill.
          <Button
            size="sm"
            variant="quiet"
            onClick={() => onRetry(item.checkpointGeneration)}
            disabled={pending}
            aria-label={`Retry compaction generation ${item.checkpointGeneration}`}
          >
            {pending ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
      </span>
      <span className="vex-mem-row__r">{fmtDate(item.completedAt ?? item.createdAt)}</span>
    </li>
  );
}
