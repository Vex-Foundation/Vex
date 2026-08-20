/**
 * Memory-decisions section of the Memory panel (memory-system S10).
 *
 * The manager's append-only decision audit — one row per verdict event
 * (promote / supersede / merge / retain / reject / expire / reconcile).
 * READ-ONLY by doctrine: decisions are immutable audit rows authored by the
 * memory manager. Every value is the sanitized DTO from main — never
 * `evidence_refs` or `decision_hash`.
 */

import { useState, type JSX } from "react";
import type {
  MemoryDecisionDto,
  MemoryDecisionTypeDto,
} from "@shared/schemas/memory-inspector.js";
import { useInspectorDecisions } from "../../lib/api/memory-inspector.js";
import {
  Empty,
  ErrorState,
  Loading,
  PILL,
  SECTION,
  fmtDate,
} from "./MemoryPanelShared.js";

const DECISION_FILTERS: ReadonlyArray<{
  readonly value: MemoryDecisionTypeDto | "all";
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "promote", label: "Promote" },
  { value: "supersede", label: "Supersede" },
  { value: "merge", label: "Merge" },
  { value: "retain", label: "Retain" },
  { value: "reject", label: "Reject" },
  { value: "expire", label: "Expire" },
  { value: "reconcile", label: "Reconcile" },
];

/** Short display form of a UUID anchor (first segment). */
function shortId(uuid: string): string {
  return uuid.split("-")[0] ?? uuid;
}

export function DecisionsSection(): JSX.Element {
  const [decisionType, setDecisionType] = useState<
    MemoryDecisionTypeDto | "all"
  >("all");
  const query = useInspectorDecisions(
    decisionType === "all" ? undefined : decisionType,
  );

  return (
    <section data-vex-section="memory-decisions" className={SECTION}>
      <div>
        <h2 className="vex-eyebrow">Manager decisions</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          The memory manager&apos;s decision audit - every promote, merge,
          reject, or reconcile verdict, append-only and immutable.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {DECISION_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setDecisionType(f.value)}
            data-active={decisionType === f.value}
            className={`rounded-[3px] px-2 py-1 font-doto text-[11px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary ${
              decisionType === f.value
                ? "bg-accent-wash text-accent-primary"
                : "text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <DecisionsList query={query} />
    </section>
  );
}

function DecisionsList({
  query,
}: {
  readonly query: ReturnType<typeof useInspectorDecisions>;
}): JSX.Element {
  if (query.isLoading) return <Loading label="Loading decisions…" />;
  const res = query.data;
  if (res === undefined || !res.ok) {
    return (
      <ErrorState
        message={
          res && !res.ok ? res.error.message : "Unable to load decisions."
        }
      />
    );
  }
  if (res.data.length === 0) {
    return <Empty label="No decisions match." />;
  }
  return (
    <ul className="flex flex-col">
      {res.data.map((d) => (
        <DecisionRow key={d.id} decision={d} />
      ))}
    </ul>
  );
}

function DecisionRow({
  decision,
}: {
  readonly decision: MemoryDecisionDto;
}): JSX.Element {
  return (
    <li
      data-vex-decision-id={decision.id}
      data-decision-type={decision.decisionType}
      className="border-b border-line-2 px-1 py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={PILL} data-vex-decision-type>
          {decision.decisionType}
        </span>
        {decision.rejectReason !== null ? (
          <span className={PILL}>{decision.rejectReason}</span>
        ) : null}
        {decision.candidateId !== null ? (
          <span className={PILL} title={decision.candidateId}>
            cand {shortId(decision.candidateId)}
          </span>
        ) : null}
        {decision.promotedKnowledgeId !== null ? (
          <span className={PILL}>→ memory #{decision.promotedKnowledgeId}</span>
        ) : null}
        {decision.supersedesKnowledgeId !== null ? (
          <span className={PILL}>
            supersedes #{decision.supersedesKnowledgeId}
          </span>
        ) : null}
        {decision.mergeTargetKnowledgeId !== null ? (
          <span className={PILL}>
            merged into #{decision.mergeTargetKnowledgeId}
          </span>
        ) : null}
        <span className={PILL}>by {decision.decidedBy}</span>
        {decision.costUsd !== null ? (
          <span className={PILL}>${decision.costUsd.toFixed(4)}</span>
        ) : null}
        <span
          data-vex-decided
          title={decision.decidedAt}
          className="ml-auto font-mono text-[10px] tabular-nums text-ink-tertiary"
        >
          {fmtDate(decision.decidedAt)}
        </span>
      </div>
    </li>
  );
}
