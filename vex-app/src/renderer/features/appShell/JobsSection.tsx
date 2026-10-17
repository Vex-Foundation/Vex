/**
 * Memory-jobs section of the Memory panel (memory-system S10).
 *
 * The manager's durable work queue — status counters plus the most recent
 * jobs with derived item progress. READ-ONLY by doctrine: retries and resets
 * are owned by the memory manager's supervisor, never the renderer. Every
 * value is the sanitized DTO from main — never worker-lock columns or the
 * untrusted `last_error` text.
 */

import type { JSX } from "react";
import type {
  MemoryJobDto,
  MemoryJobsSummaryDto,
} from "@shared/schemas/memory-inspector.js";
import { useJobsSummary } from "../../lib/api/memory-inspector.js";
import {
  Empty,
  ErrorState,
  Loading,
  PILL,
  SECTION,
  SectionHead,
  fmtDate,
} from "./MemoryPanelShared.js";

const STATUS_COUNTERS: ReadonlyArray<{
  readonly key: keyof MemoryJobsSummaryDto["countsByStatus"];
  readonly label: string;
}> = [
  { key: "pending", label: "pending" },
  { key: "running", label: "running" },
  { key: "completed", label: "completed" },
  { key: "failed", label: "failed" },
  { key: "permanently_failed", label: "perm-failed" },
  { key: "retired", label: "retired" },
];

export function JobsSection(): JSX.Element {
  const query = useJobsSummary();

  return (
    <section data-vex-section="memory-jobs" className={SECTION}>
      <SectionHead
        title="Memory jobs"
        lead="The memory manager's work queue - consolidation sweeps. Retries are handled automatically by the manager. Reconcile jobs from earlier versions are counted as retired."
      />

      <JobsBody query={query} />
    </section>
  );
}

function JobsBody({
  query,
}: {
  readonly query: ReturnType<typeof useJobsSummary>;
}): JSX.Element {
  if (query.isLoading) return <Loading label="Loading jobs…" />;
  const res = query.data;
  if (res === undefined || !res.ok) {
    return (
      <ErrorState
        message={res && !res.ok ? res.error.message : "Unable to load jobs."}
      />
    );
  }
  return (
    <>
      <div data-vex-jobs-counts className="vex-mem-sec__counts">
        {STATUS_COUNTERS.map((s) => (
          <span key={s.key} className={PILL} data-vex-jobs-count={s.key} data-figure>
            {s.label} {res.data.countsByStatus[s.key]}
          </span>
        ))}
      </div>
      {res.data.recentJobs.length === 0 ? (
        <Empty label="No memory jobs yet." />
      ) : (
        <ul className="vex-mem-list">
          {res.data.recentJobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </>
  );
}

function JobRow({ job }: { readonly job: MemoryJobDto }): JSX.Element {
  return (
    <li
      data-vex-job-id={job.id}
      data-status={job.status}
      className="vex-mem-row"
      data-untitled=""
    >
      <span className="vex-mem-row__m">
        <span className={PILL} data-figure>
          #{job.id}
        </span>
        <span className={PILL}>{job.jobKind}</span>
        <span className={PILL} data-vex-job-status>
          {job.status}
        </span>
        <span className={PILL} data-figure>
          attempts {job.attemptCount}/{job.maxAttempts}
        </span>
        <span className={PILL} data-figure>
          items {job.itemsDone} done / {job.itemsFailed} failed /{" "}
          {job.itemsTotal} total
        </span>
        {job.wakePending ? (
          <span className={PILL} data-vex-job-wake-pending>
            wake pending
          </span>
        ) : null}
      </span>
      <span
        data-vex-created
        title={job.completedAt ?? job.startedAt ?? job.createdAt}
        className="vex-mem-row__r"
      >
        {fmtDate(job.completedAt ?? job.startedAt ?? job.createdAt)}
      </span>
    </li>
  );
}
