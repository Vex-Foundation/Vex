/**
 * Session-memory section of the Memory panel (7-2a).
 *
 * The active session's memories — theme + outstanding work as COUNTS +
 * importance/confidence — gated on an active session. Read-only; every value
 * is the sanitized DTO from main (never raw outstanding-item text/embeddings).
 */

import type { JSX } from "react";
import type { MemoryStatsDto, SessionMemoryDto } from "@shared/schemas/memory.js";
import { useMemoryStats, useSessionMemories } from "../../lib/api/memory.js";
import {
  Empty,
  ErrorState,
  Loading,
  PILL,
  SECTION,
  SectionHead,
  fmtDate,
} from "./MemoryPanelShared.js";

export function MemorySection({
  sessionId,
}: {
  readonly sessionId: string | null;
}): JSX.Element {
  const statsQuery = useMemoryStats(sessionId);
  const listQuery = useSessionMemories(sessionId);

  return (
    <section data-vex-section="memory" className={SECTION}>
      <SectionHead
        title="Session memory"
        lead="What the agent remembers from this session (read-only). Outstanding work is shown as counts."
      />
      {sessionId === null || sessionId.length === 0 ? (
        <Empty label="Open a session to view its memory." />
      ) : (
        <>
          <MemoryStatsRow query={statsQuery} />
          <MemoryList query={listQuery} />
        </>
      )}
    </section>
  );
}

function MemoryStatsRow({
  query,
}: {
  readonly query: ReturnType<typeof useMemoryStats>;
}): JSX.Element | null {
  if (query.isLoading) return <Loading label="Loading memory stats…" />;
  const res = query.data;
  if (res === undefined || !res.ok) return null; // list below surfaces errors
  const stats: MemoryStatsDto | null = res.data;
  if (stats === null) return null;
  return (
    <div data-vex-memory-stats className="vex-mem-sec__counts">
      <span className={PILL} data-figure>
        {stats.activeCount} memories
      </span>
      <span className={PILL} data-figure>
        gen {stats.compactCount}
      </span>
      <span className={PILL} data-figure>
        {stats.unresolvedOutstandingCount} open items
      </span>
      {stats.recentThemes.slice(0, 5).map((t) => (
        <span key={t} className={PILL}>
          {t}
        </span>
      ))}
    </div>
  );
}

function MemoryList({
  query,
}: {
  readonly query: ReturnType<typeof useSessionMemories>;
}): JSX.Element {
  if (query.isLoading) return <Loading label="Loading memories…" />;
  const res = query.data;
  if (res === undefined || !res.ok) {
    return (
      <ErrorState
        message={res && !res.ok ? res.error.message : "Unable to load memory."}
      />
    );
  }
  if (res.data === null) {
    return <Empty label="This session has no memory yet." />;
  }
  if (res.data.length === 0) {
    return <Empty label="No memories recorded for this session yet." />;
  }
  // Hairline-separated ledger rows, no card boxes, no gaps.
  return (
    <ul className="vex-mem-list">
      {res.data.map((m) => (
        <MemoryRow key={m.id} memory={m} />
      ))}
    </ul>
  );
}

function MemoryRow({ memory }: { readonly memory: SessionMemoryDto }): JSX.Element {
  return (
    <li data-vex-memory-id={memory.id} className="vex-mem-row">
      <span className="vex-mem-row__t">{memory.theme}</span>
      <span className="vex-mem-row__m">
        <span className={PILL}>{memory.status}</span>
        <span className={PILL} data-figure>
          gen {memory.checkpointGeneration}
        </span>
        {memory.importance !== null ? (
          <span className={PILL} data-figure>
            imp {memory.importance}
          </span>
        ) : null}
        {memory.confidence !== null ? (
          <span className={PILL} data-figure>
            conf {memory.confidence.toFixed(2)}
          </span>
        ) : null}
        <span className={PILL} data-figure>
          {memory.outstandingOpenCount} open / {memory.outstandingResolvedCount}{" "}
          done
        </span>
      </span>
      <span data-vex-created title={memory.createdAt} className="vex-mem-row__r">
        {fmtDate(memory.createdAt)}
      </span>
    </li>
  );
}
