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
  Loading,
  PILL,
  SECTION,
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

  return (
    <section data-vex-section="long-memory" className={SECTION}>
      <div>
        <h2 className="vex-eyebrow">Long-term memory</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          What the agent knows - durable lessons across all sessions. Sources,
          maturity, and statuses are shown so low-confidence entries are
          visible but labeled. The lifecycle is managed automatically by the
          agent&apos;s memory manager.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {LONG_MEMORY_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            data-active={status === f.value}
            className={`rounded-[3px] px-2 py-1 font-doto text-[11px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary ${
              status === f.value
                ? "bg-accent-wash text-accent-primary"
                : "text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title / summary / kind"
          aria-label="Search long-term memory"
          className="ml-auto min-w-[160px] flex-1 rounded-[6px] border border-line-3 bg-surface-1 px-2 py-1 text-xs text-ink-primary placeholder:text-ink-tertiary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary"
        />
      </div>

      <LongMemoryList query={query} search={search} />
    </section>
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
  const needle = search.trim().toLowerCase();
  const items =
    needle.length === 0
      ? res.data
      : res.data.filter(
          (k) =>
            k.title.toLowerCase().includes(needle) ||
            k.summary.toLowerCase().includes(needle) ||
            k.kind.toLowerCase().includes(needle),
        );
  if (items.length === 0) {
    return <Empty label="No memory entries match." />;
  }
  // Hairline-separated ledger rows — no card boxes, no gaps.
  return (
    <ul className="flex flex-col">
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
      className="border-b border-line-2 px-1 py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-xs font-medium text-ink-primary">
          {entry.title}
        </span>
        <span className={PILL}>{entry.kind}</span>
        <span className={PILL} data-vex-long-memory-status>
          {entry.status}
        </span>
        {entry.source !== null ? <span className={PILL}>{entry.source}</span> : null}
        {entry.maturityState !== null ? (
          <span className={PILL}>{entry.maturityState}</span>
        ) : null}
        {entry.confidence !== null ? (
          <span className={PILL}>conf {entry.confidence.toFixed(2)}</span>
        ) : null}
        <span
          data-vex-created
          title={entry.createdAt}
          className="ml-auto font-mono text-[10px] tabular-nums text-ink-tertiary"
        >
          {fmtDate(entry.createdAt)}
        </span>
      </div>
      {entry.summary.length > 0 ? (
        <p className="mt-1 line-clamp-2 text-xs text-ink-secondary">
          {entry.summary}
        </p>
      ) : null}
      {entry.tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {entry.tags.map((t) => (
            <span
              key={t}
              className="rounded-[3px] px-1 py-0.5 font-mono text-[10px] text-ink-tertiary"
            >
              #{t}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}
