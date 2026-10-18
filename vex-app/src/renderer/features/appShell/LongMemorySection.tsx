/**
 * Long-term memory section of the Memory panel (memory-system S9 rewire).
 *
 * The GLOBAL long-term memory store (all sources/statuses, visibly labeled)
 * with a status filter + client-side text search. READ-ONLY by design: the
 * lifecycle (promotion, supersede, invalidation, archival, expiry) is owned
 * by the agent's memory manager, so there are no mutation affordances here.
 * Every value is the sanitized DTO from main — never raw narrative bodies or
 * embeddings.
 */

import { useState, type JSX } from "react";
import type {
  LongMemoryEntryDto,
  LongMemoryStatusDto,
} from "@shared/schemas/long-memory.js";
import { useLongMemoryList } from "../../lib/api/long-memory.js";
import {
  Empty,
  ErrorState,
  FilterKeys,
  Loading,
  PILL,
  SECTION,
  SectionHead,
  fmtDate,
} from "./MemoryPanelShared.js";

const LONG_MEMORY_FILTERS: ReadonlyArray<{
  readonly value: LongMemoryStatusDto | "all";
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "invalidated", label: "Invalidated" },
  { value: "superseded", label: "Superseded" },
];

export function LongMemorySection(): JSX.Element {
  const [status, setStatus] = useState<LongMemoryStatusDto | "all">("all");
  const [search, setSearch] = useState("");
  const query = useLongMemoryList(status === "all" ? undefined : status);

  const res = query.data;
  const needle = search.trim().toLowerCase();
  const shown =
    res !== undefined && res.ok ? filterEntries(res.data, needle) : null;

  return (
    <section data-vex-section="long-memory" className={SECTION}>
      <SectionHead
        title="Long-term memory"
        count={
          shown === null
            ? undefined
            : `${shown.length} ${shown.length === 1 ? "entry" : "entries"}`
        }
        lead="What the agent knows - durable lessons across all sessions. Sources, maturity, and statuses are shown so low-confidence entries are visible but labeled. The lifecycle is managed automatically by the agent's memory manager."
      />

      <div className="vex-mem-tool">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title / summary / kind"
          aria-label="Search long-term memory"
          className="vex-mem-field"
        />
        <FilterKeys
          label="Filter long-term memory by status"
          options={LONG_MEMORY_FILTERS}
          value={status}
          onChange={setStatus}
        />
      </div>

      <LongMemoryList query={query} search={search} />
    </section>
  );
}

/** The entries whose title, summary or kind holds the search text. */
function filterEntries(
  entries: readonly LongMemoryEntryDto[],
  needle: string,
): readonly LongMemoryEntryDto[] {
  if (needle.length === 0) return entries;
  return entries.filter(
    (k) =>
      k.title.toLowerCase().includes(needle) ||
      k.summary.toLowerCase().includes(needle) ||
      k.kind.toLowerCase().includes(needle),
  );
}

function LongMemoryList({
  query,
  search,
}: {
  readonly query: ReturnType<typeof useLongMemoryList>;
  readonly search: string;
}): JSX.Element {
  if (query.isLoading) return <Loading label="Loading memory…" />;
  const res = query.data;
  if (res === undefined || !res.ok) {
    return (
      <ErrorState
        message={res && !res.ok ? res.error.message : "Unable to load memory."}
      />
    );
  }
  const items = filterEntries(res.data, search.trim().toLowerCase());
  if (items.length === 0) {
    return <Empty label="No memory entries match." />;
  }
  // Hairline-separated ledger rows, no card boxes, no gaps.
  return (
    <ul className="vex-mem-list">
      {items.map((k) => (
        <LongMemoryRow key={k.id} entry={k} />
      ))}
    </ul>
  );
}

function LongMemoryRow({
  entry,
}: {
  readonly entry: LongMemoryEntryDto;
}): JSX.Element {
  return (
    <li
      data-vex-long-memory-id={entry.id}
      data-status={entry.status}
      className="vex-mem-row"
    >
      <span className="vex-mem-row__t">{entry.title}</span>
      <span className="vex-mem-row__m">
        <span className={PILL}>{entry.kind}</span>
        <span className={PILL} data-vex-long-memory-status>
          {entry.status}
        </span>
        {entry.source !== null ? <span className={PILL}>{entry.source}</span> : null}
        {entry.maturityState !== null ? (
          <span className={PILL}>{entry.maturityState}</span>
        ) : null}
        {entry.confidence !== null ? (
          <span className={PILL} data-figure>
            conf {entry.confidence.toFixed(2)}
          </span>
        ) : null}
        {entry.tags.map((t) => (
          <span key={t} className={PILL}>
            #{t}
          </span>
        ))}
        {entry.summary.length > 0 ? <span>{entry.summary}</span> : null}
      </span>
      <span data-vex-created title={entry.createdAt} className="vex-mem-row__r">
        {fmtDate(entry.createdAt)}
      </span>
    </li>
  );
}
