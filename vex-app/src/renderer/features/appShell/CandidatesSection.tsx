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
  FilterKeys,
  Loading,
  PILL,
  SECTION,
  SectionHead,
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
      <SectionHead
        title="Memory candidates"
        lead="What the agent proposed for long-term memory. The memory manager decides each candidate's fate automatically - this view is inspection only."
      />

      <div className="vex-mem-tool">
        <FilterKeys
          label="Filter memory candidates by status"
          options={CANDIDATE_FILTERS}
          value={status}
          onChange={setStatus}
        />
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
    <ul className="vex-mem-list">
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
      className="vex-mem-row"
    >
      <span className="vex-mem-row__t">{candidate.title}</span>
      <span className="vex-mem-row__m">
        <span className={PILL}>{candidate.kind}</span>
        <span className={PILL} data-vex-candidate-status>
          {candidate.status}
        </span>
        {candidate.source !== null ? (
          <span className={PILL}>{candidate.source}</span>
        ) : null}
        <span className={PILL}>evidence {candidate.evidenceStrength}</span>
        {candidate.promotedKnowledgeId !== null ? (
          <span className={PILL} data-figure>
            → memory #{candidate.promotedKnowledgeId}
          </span>
        ) : null}
        {candidate.summary.length > 0 ? <span>{candidate.summary}</span> : null}
      </span>
      <span data-vex-recorded title={candidate.recordedAt} className="vex-mem-row__r">
        {fmtDate(candidate.recordedAt)}
      </span>
    </li>
  );
}
