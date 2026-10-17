/**
 * The migration screen's rows, derived from main's progress events alone:
 * the steps run in order, so every row before the current one has finished
 * and every row after it waits. A resumed move skips the steps an earlier
 * attempt finished, and those rows read as finished too. Pure, so the copy
 * is pinned by tests without rendering.
 */

import type { RuntimeMigrationPhase, RuntimeMigrationProgress } from "@shared/schemas/runtime-migration.js";

import type { StepRowView } from "../bootstrap/StepRows.js";
import {
  copyDetail,
  ROW_ACTIVE,
  ROW_LABEL,
  ROW_READY,
  ROW_WAITING,
  type MigrationRowKey,
} from "./copy.js";

const ORDER: readonly MigrationRowKey[] = ["source", "copy", "restore", "verify", "finish"];

const ROW_OF: Record<RuntimeMigrationPhase, MigrationRowKey> = {
  preparing: "source",
  starting_source: "source",
  dumping: "copy",
  restoring: "restore",
  verifying: "verify",
  finishing: "finish",
};

/** Bytes for people: MB below a gigabyte, GB above. */
export function formatBytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Where the rows stand: a move in flight, one that ended at a step, or done. */
export type RowsAt =
  | { readonly kind: "waiting" }
  | { readonly kind: "active"; readonly progress: RuntimeMigrationProgress }
  | { readonly kind: "failed"; readonly phase: RuntimeMigrationPhase | null }
  | { readonly kind: "done" };

function activeRow(progress: RuntimeMigrationProgress): StepRowView {
  const step = ROW_OF[progress.phase];
  const base = { step, label: ROW_LABEL[step], status: "active" as const, download: null };
  switch (progress.phase) {
    case "dumping":
      return {
        ...base,
        word: ROW_ACTIVE.copying.word,
        detail: copyDetail(
          formatBytes(progress.bytesWritten),
          progress.estimatedBytes > 0 ? formatBytes(progress.estimatedBytes) : null,
        ),
      };
    case "preparing":
    case "starting_source":
    case "restoring":
    case "verifying":
    case "finishing":
      return { ...base, ...ROW_ACTIVE[progress.phase] };
  }
}

function rowsWith(index: number, current: StepRowView | null): StepRowView[] {
  return ORDER.map((step, i): StepRowView => {
    if (i === index && current !== null) return current;
    return i < index
      ? { step, label: ROW_LABEL[step], status: "ready", word: "done", detail: ROW_READY[step], download: null }
      : { step, label: ROW_LABEL[step], status: "waiting", word: "waiting", detail: ROW_WAITING[step], download: null };
  });
}

export function migrationRows(at: RowsAt): StepRowView[] {
  switch (at.kind) {
    case "waiting":
      return rowsWith(-1, null);
    case "done":
      return rowsWith(ORDER.length, null);
    case "active": {
      const row = activeRow(at.progress);
      return rowsWith(ORDER.indexOf(row.step as MigrationRowKey), row);
    }
    case "failed": {
      const step = at.phase === null ? "source" : ROW_OF[at.phase];
      return rowsWith(ORDER.indexOf(step), {
        step,
        label: ROW_LABEL[step],
        status: "failed",
        word: "failed",
        detail: "Stopped",
        download: null,
      });
    }
  }
}
