/**
 * Settings "Local runtime" (plan 8.4): the bundled database and embeddings
 * server Vex runs on this computer. Shown only on the native runtime.
 *
 *   - Status: the runtime screen's three rows (database, embeddings model,
 *     embeddings server), live from main's progress event, so a restart is
 *     watched step by step here exactly as the first start was.
 *   - Versions and data size: one `runtimeInfo` read per visit (main measures
 *     the folders off its critical path), measured again after a restart.
 *   - Maintenance: Restart runtime, and the app's logs folder, where the
 *     runtime writes what it does.
 *   - Reset local data, behind a typed confirmation.
 *
 * The section owns no runtime state of its own: everything it shows is what
 * main reports, and every action is main's to refuse.
 */

import { useMemo, useState, type JSX } from "react";
import type { LocalRuntimeInfo, RuntimeRestartResult } from "@shared/schemas/system.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import { useLocalRuntimeInfo, useRestartLocalRuntime } from "../../../../lib/api/system.js";
import { StepRows } from "../../../runtime/bootstrap/StepRows.js";
import { stepRows } from "../../../runtime/bootstrap/steps.js";
import { useNativeRuntimeStatus } from "../../../runtime/bootstrap/useNativeRuntimeStatus.js";
import { LocalDataResetDialog } from "./LocalDataResetDialog.js";
import {
  DATA_LABELS,
  formatDiskSize,
  INFO_FAILED,
  INFO_LOADING,
  LOCAL_RUNTIME_DATA_HEADING,
  LOCAL_RUNTIME_LEDE,
  LOCAL_RUNTIME_MAINTENANCE_HEADING,
  LOCAL_RUNTIME_RESET_HEADING,
  LOCAL_RUNTIME_STATUS_HEADING,
  LOCAL_RUNTIME_VERSIONS_HEADING,
  RESET_BODY,
  RESET_OPEN,
  RESTART_DONE,
  RESTART_HELP,
  RESTART_LABEL,
  RESTART_PENDING,
  VERSION_LABELS,
  VERSION_UNKNOWN,
} from "./local-runtime-copy.js";

const SECTION = "border-t border-line-1 pt-5";
const BODY = "mt-2 text-[12px] leading-[18px] text-ink-secondary";

/** What the last Restart press came to, in words. */
function restartOutcome(result: RuntimeRestartResult): { readonly tone: "ok" | "error"; readonly text: string } {
  switch (result.kind) {
    case "restarted":
      return { tone: "ok", text: RESTART_DONE };
    case "failed":
    case "refused":
      return { tone: "error", text: result.message };
  }
}

function FactList({
  rows,
  label,
}: {
  readonly rows: ReadonlyArray<{ readonly key: string; readonly name: string; readonly value: string }>;
  readonly label: string;
}): JSX.Element {
  return (
    <dl className="mt-3 flex flex-col" aria-label={label}>
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex items-baseline justify-between gap-4 border-t border-[var(--color-border)] py-2.5 first:border-t-0"
          data-vex-local-runtime-fact={row.key}
        >
          <dt className="text-sm text-ink-primary">{row.name}</dt>
          <dd className="font-mono text-xs tabular-nums text-ink-secondary">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function versionRows(info: LocalRuntimeInfo) {
  return [
    { key: "release", name: VERSION_LABELS.release, value: info.release },
    { key: "postgres", name: VERSION_LABELS.postgres, value: info.versions.postgres ?? VERSION_UNKNOWN },
    { key: "pgvector", name: VERSION_LABELS.pgvector, value: info.versions.pgvector ?? VERSION_UNKNOWN },
    { key: "llamaCpp", name: VERSION_LABELS.llamaCpp, value: info.versions.llamaCpp ?? VERSION_UNKNOWN },
  ];
}

function sizeRows(info: LocalRuntimeInfo) {
  return [
    { key: "database", name: DATA_LABELS.database, value: formatDiskSize(info.sizes.database) },
    { key: "model", name: DATA_LABELS.model, value: formatDiskSize(info.sizes.model) },
  ];
}

export function LocalRuntimeSection(): JSX.Element {
  const { status } = useNativeRuntimeStatus();
  const rows = useMemo(() => stepRows(status), [status]);
  const infoQuery = useLocalRuntimeInfo();
  const info = infoQuery.data?.ok === true ? infoQuery.data.data : null;
  const infoFailed = infoQuery.isError || infoQuery.data?.ok === false;
  const restart = useRestartLocalRuntime();
  const [outcome, setOutcome] = useState<ReturnType<typeof restartOutcome> | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const phase = status?.phase ?? null;
  // A start is on its way (boot, Retry, or this restart): pressing again would
  // only be refused.
  const starting = phase === "postgres" || phase === "model" || phase === "embeddings";
  const restartDisabled = restart.isPending || starting || phase === null;

  const onRestart = async (): Promise<void> => {
    setOutcome(null);
    try {
      const result = await restart.mutateAsync();
      setOutcome(result.ok ? restartOutcome(result.data) : { tone: "error", text: result.error.message });
    } catch (cause) {
      setOutcome({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <div className="flex w-full flex-col gap-5" data-vex-local-runtime="" data-vex-local-runtime-phase={phase ?? "unknown"}>
      {/* The screen's chapter title already names the section. */}
      <p className="vex-step-lede max-w-[56ch] text-sm leading-relaxed text-ink-secondary">{LOCAL_RUNTIME_LEDE}</p>

      <section aria-label={LOCAL_RUNTIME_STATUS_HEADING} className={SECTION} data-vex-local-runtime-status="">
        <h2 className="vex-ov-label">{LOCAL_RUNTIME_STATUS_HEADING}</h2>
        <div className="mt-1">
          <StepRows rows={rows} />
        </div>
        {status?.phase === "failed" ? (
          <p role="alert" className="mt-1 text-[12px] leading-[18px] text-danger">
            {status.message}
          </p>
        ) : null}
      </section>

      <section aria-label={LOCAL_RUNTIME_VERSIONS_HEADING} className={SECTION}>
        <h2 className="vex-ov-label">{LOCAL_RUNTIME_VERSIONS_HEADING}</h2>
        {info !== null ? (
          <FactList label={LOCAL_RUNTIME_VERSIONS_HEADING} rows={versionRows(info)} />
        ) : (
          <p className={BODY}>{infoFailed ? INFO_FAILED : INFO_LOADING}</p>
        )}
      </section>

      <section aria-label={LOCAL_RUNTIME_DATA_HEADING} className={SECTION}>
        <h2 className="vex-ov-label">{LOCAL_RUNTIME_DATA_HEADING}</h2>
        {info !== null ? (
          <FactList label={LOCAL_RUNTIME_DATA_HEADING} rows={sizeRows(info)} />
        ) : (
          <p className={BODY}>{infoFailed ? INFO_FAILED : INFO_LOADING}</p>
        )}
      </section>

      <section aria-label={LOCAL_RUNTIME_MAINTENANCE_HEADING} className={SECTION}>
        <h2 className="vex-ov-label">{LOCAL_RUNTIME_MAINTENANCE_HEADING}</h2>
        <p className={BODY}>{RESTART_HELP}</p>
        <div className="mt-3 flex items-center gap-4">
          <button
            type="button"
            className="vex-sbtn"
            disabled={restartDisabled}
            onClick={() => void onRestart()}
            data-vex-local-runtime-restart=""
          >
            {restart.isPending ? RESTART_PENDING : RESTART_LABEL}
          </button>
          <OpenLogsLink className="self-center" />
        </div>
        {outcome !== null ? (
          <p
            role={outcome.tone === "error" ? "alert" : "status"}
            className={
              outcome.tone === "error"
                ? "mt-2 text-[12px] leading-[18px] text-danger"
                : "mt-2 text-[12px] leading-[18px] text-ink-secondary"
            }
            data-vex-local-runtime-restart-outcome={outcome.tone}
          >
            {outcome.text}
          </p>
        ) : null}
      </section>

      {/*
        SLOT(remove-old-data): the "Remove old ... data" row for an install
        migrated from the previous release's database volume goes HERE, as its
        own section between Maintenance and Reset. Its IPC (`removeOldData`
        on the migration branch, with its own typed confirmation) is wired
        once both branches have merged; nothing calls it from this section yet.
      */}

      <section aria-label={LOCAL_RUNTIME_RESET_HEADING} className={SECTION} data-vex-local-runtime-reset="">
        <h2 className="vex-ov-label">{LOCAL_RUNTIME_RESET_HEADING}</h2>
        <p className={BODY}>{RESET_BODY}</p>
        <div className="mt-3">
          <button
            type="button"
            className="vex-sbtn"
            onClick={() => setResetOpen(true)}
            disabled={restart.isPending}
            data-vex-local-runtime-reset-open=""
          >
            {RESET_OPEN}
          </button>
        </div>
      </section>

      <LocalDataResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </div>
  );
}
