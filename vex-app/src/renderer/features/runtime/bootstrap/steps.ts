/**
 * The runtime screen's three rows, derived from main's `NativeRuntimeStatus`
 * alone: the steps run in order, so every step before the current one has
 * finished and every step after it waits. Pure, so the copy is pinned by
 * tests without rendering.
 */

import type {
  NativeRuntimeModelState,
  NativeRuntimeStatus,
  NativeRuntimeStep,
} from "@shared/schemas/system.js";

export type StepStatus = "waiting" | "active" | "ready" | "failed";

export interface StepDownload {
  readonly percent: number;
  /** "120.4 MB of 333.6 MB". */
  readonly bytes: string;
  /** "8.2 MB/s", or null until main has measured a window. */
  readonly speed: string | null;
}

export interface StepRow {
  readonly step: NativeRuntimeStep;
  readonly label: string;
  readonly status: StepStatus;
  /** The mono word at the row's end. */
  readonly word: string;
  readonly detail: string;
  /** Present while the model downloads. */
  readonly download: StepDownload | null;
}

const ORDER: readonly NativeRuntimeStep[] = ["postgres", "model", "embeddings"];

const LABEL: Record<NativeRuntimeStep, string> = {
  postgres: "Database",
  model: "Embeddings model",
  embeddings: "Embeddings server",
};

const READY_DETAIL: Record<NativeRuntimeStep, string> = {
  postgres: "Postgres is running on this computer",
  model: "On disk and verified",
  embeddings: "Answering on this computer",
};

const WAITING_DETAIL: Record<NativeRuntimeStep, string> = {
  postgres: "Waiting to start",
  model: "Waiting for the database",
  embeddings: "Waiting for the model",
};

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function download(model: Extract<NativeRuntimeModelState, { state: "downloading" }>): StepDownload {
  return {
    percent: Math.floor((model.receivedBytes / model.totalBytes) * 100),
    bytes: `${formatMegabytes(model.receivedBytes)} of ${formatMegabytes(model.totalBytes)}`,
    speed: model.bytesPerSecond === null ? null : `${formatMegabytes(model.bytesPerSecond)}/s`,
  };
}

type InFlight = Extract<NativeRuntimeStatus, { phase: "postgres" | "model" | "embeddings" }>;

function active(step: NativeRuntimeStep, word: string, detail: string, progress: StepDownload | null = null): StepRow {
  return { step, label: LABEL[step], status: "active", word, detail, download: progress };
}

function activeRow(status: InFlight): StepRow {
  switch (status.phase) {
    case "postgres":
      return status.initializing
        ? active("postgres", "creating", "Creating the local database (first run)")
        : active("postgres", "starting", "Starting the local database");
    case "model": {
      if (status.model.state === "checking") return active("model", "checking", "Checking the model on disk");
      if (status.model.state === "verifying") return active("model", "verifying", "Verifying the model file");
      const progress = download(status.model);
      const detail = progress.speed === null ? progress.bytes : `${progress.bytes} · ${progress.speed}`;
      return active("model", `${String(progress.percent)}%`, detail, progress);
    }
    case "embeddings":
      return active("embeddings", "starting", "Loading the model");
  }
}

/** The rows with `index` current: earlier steps ready, later ones waiting. */
function rowsAt(index: number, current: StepRow | null): StepRow[] {
  return ORDER.map((step, i): StepRow => {
    if (i === index && current !== null) return current;
    return i < index
      ? { step, label: LABEL[step], status: "ready", word: "ready", detail: READY_DETAIL[step], download: null }
      : { step, label: LABEL[step], status: "waiting", word: "waiting", detail: WAITING_DETAIL[step], download: null };
  });
}

export function stepRows(status: NativeRuntimeStatus | null): StepRow[] {
  if (status === null || status.phase === "idle") return rowsAt(-1, null);
  if (status.phase === "ready") return rowsAt(ORDER.length, null);
  if (status.phase === "failed") {
    const step = status.step;
    return rowsAt(ORDER.indexOf(step), {
      step,
      label: LABEL[step],
      status: "failed",
      word: "failed",
      detail: "Stopped",
      download: null,
    });
  }
  const row = activeRow(status);
  return rowsAt(ORDER.indexOf(row.step), row);
}

/**
 * Whether the setup gate should hand off to the runtime screen rather than
 * wait: a failure the user must act on, or a model download or re-hash long
 * enough to deserve its progress. The other phases take about a second.
 */
export function needsRuntimeScreen(status: NativeRuntimeStatus): boolean {
  return status.phase === "failed" || (status.phase === "model" && status.model.state !== "checking");
}
