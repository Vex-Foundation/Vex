/**
 * Memory-candidates section of the Memory panel (memory-system S10).
 *
 * The memory manager's candidate buffer — what the agent has PROPOSED for
 * long-term memory, before/after the manager's decision. READ-ONLY by
 * doctrine: the lifecycle (consolidate, promote, reject, expire) is owned by
 * the agent's memory manager, so there are no mutation affordances here.
 * Every value is the sanitized DTO from main — never `content_md`, source or
 * evidence refs, or embeddings.
 */

import { useState, type JSX } from "react";
import type {
  MemoryCandidateDto,
  MemoryCandidateStatusDto,
} from "@shared/schemas/memory-inspector.js";
import { useInspectorCandidates } from "../../lib/api/memory-inspector.js";
import {
  Empty,
  ErrorState,
  Loading,
  PILL,
  SECTION,
  fmtDate,
} from "./MemoryPanelShared.js";

const CANDIDATE_FILTERS: ReadonlyArray<{
  readonly value: MemoryCandidateStatusDto | "all";
  readonly label: string;
}> = [
  { value: "pending", label: "Pending" },
  { value: "promoted", label: "Promoted" },
  { value: "superseded", label: "Superseded" },
  { value: "merged", label: "Merged" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "retained", label: "Retained" },
  { value: "all", label: "All" },
];

export function CandidatesSection(): JSX.Element {
  // Default to the manager's inbox — the pending buffer is the interesting view.
  const [status, setStatus] = useState<MemoryCandidateStatusDto | "all">(
    "pending",
  );
  const query = useInspectorCandidates(status === "all" ? undefined : status);

  return (
    <section data-vex-section="memory-candidates" className={SECTION}>
      <div>
        <h2 className="vex-eyebrow">Memory candidates</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          What the agent proposed for long-term memory. The memory manager
          decides each candidate&apos;s fate automatically - this view is
          inspection only.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CANDIDATE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            data-active={status === f.value}
            className={`rounded-[3px] px-2 py-1 vex-micro-label uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary ${
              status === f.value
                ? "bg-accent-wash text-accent-primary"
                : "text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <CandidatesList query={query} />
    </section>
  );
}

function CandidatesList({
  query,
}: {
  readonly query: ReturnType<typeof useInspectorCandidates>;
}): JSX.Element {
  if (query.isLoading) return <Loading label="Loading candidates…" />;
  const res = query.data;
  if (res === undefined || !res.ok) {
    return (
      <ErrorState
        message={
          res && !res.ok ? res.error.message : "Unable to load candidates."
        }
      />
    );
  }
  if (res.data.length === 0) {
    return <Empty label="No candidates match." />;
  }
  return (
    <ul className="flex flex-col">
      {res.data.map((c) => (
        <CandidateRow key={c.id} candidate={c} />
      ))}
    </ul>
  );
}

function CandidateRow({
  candidate,
}: {
  readonly candidate: MemoryCandidateDto;
}): JSX.Element {
  return (
    <li
      data-vex-candidate-id={candidate.id}
      data-status={candidate.status}
      className="border-b border-line-2 px-1 py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-xs font-medium text-ink-primary">
          {candidate.title}
        </span>
        <span className={PILL}>{candidate.kind}</span>
        <span className={PILL} data-vex-candidate-status>
          {candidate.status}
        </span>
        {candidate.source !== null ? (
          <span className={PILL}>{candidate.source}</span>
        ) : null}
        <span className={PILL}>evidence {candidate.evidenceStrength}</span>
        {candidate.promotedKnowledgeId !== null ? (
          <span className={PILL}>→ memory #{candidate.promotedKnowledgeId}</span>
        ) : null}
        <span
          data-vex-recorded
          title={candidate.recordedAt}
          className="ml-auto font-mono text-[10px] tabular-nums text-ink-tertiary"
        >
          {fmtDate(candidate.recordedAt)}
        </span>
      </div>
      {candidate.summary.length > 0 ? (
        <p className="mt-1 line-clamp-2 text-xs text-ink-secondary">
          {candidate.summary}
        </p>
      ) : null}
    </li>
  );
}
