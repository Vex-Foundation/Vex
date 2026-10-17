/**
 * The native runtime's System Check rows, derived from main's facts
 * (`vex:system:localRuntimeCheck`) and the shared verdicts
 * (`shared/local-runtime-requirements.ts`). Pure: no IO, no React.
 *
 * Only the disk can hold setup back: a first run that cannot fit the
 * embeddings model fails its row and disables Continue. A missing bundle
 * fails its row but lets Continue through, because the runtime screen that
 * follows names the missing piece and offers Retry and the logs.
 */

import type { Result } from "@shared/ipc/result.js";
import {
  diskVerdict,
  MEMORY_WARN_TOTAL_BYTES,
  memoryVerdict,
} from "@shared/local-runtime-requirements.js";
import type { LocalRuntimeCheck } from "@shared/schemas/system.js";
import type { StepStatus } from "../StepRow.js";
import { formatPlatform } from "./format.js";

export interface RowView {
  readonly status: StepStatus;
  readonly detail: string | null;
  readonly badgeLabel?: string;
}

export interface LocalRuntimeView {
  readonly bundle: RowView;
  readonly disk: RowView;
  readonly memory: RowView;
  /** The disk cannot take the first run: Continue stays disabled. */
  readonly blocksContinue: boolean;
}

/** Disk sizes in decimal units, as Finder, Explorer and `df -H` print them. */
export function formatDiskBytes(bytes: number): string {
  if (bytes >= 100e9) return `${String(Math.round(bytes / 1e9))} GB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${String(Math.round(bytes / 1e6))} MB`;
  return `${String(Math.max(0, Math.round(bytes / 1e3)))} KB`;
}

/** Memory in the binary units every OS labels "GB" (a 16 GB machine is 16 GiB). */
export function formatMemoryBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 10 ? `${String(Math.round(gib))} GB` : `${gib.toFixed(1)} GB`;
}

const LOADING: RowView = { status: "loading", detail: null };

export function localRuntimeView(query: {
  readonly isPending: boolean;
  readonly data: Result<LocalRuntimeCheck> | undefined;
}): LocalRuntimeView {
  if (query.isPending || query.data === undefined) {
    return { bundle: LOADING, disk: LOADING, memory: LOADING, blocksContinue: false };
  }
  if (!query.data.ok) {
    const unchecked: RowView = { status: "fail", detail: "Vex could not check this. The logs say why." };
    return { bundle: unchecked, disk: unchecked, memory: unchecked, blocksContinue: false };
  }
  const { bundle, disk, memory } = query.data.data;
  const diskRow = diskView(disk);
  return {
    bundle:
      bundle.kind === "present"
        ? {
            status: "ok",
            badgeLabel: "READY",
            detail: `Database and embeddings server · ${formatPlatform(bundle.platform, null)} ${bundle.arch}`,
          }
        : { status: "fail", badgeLabel: "MISSING", detail: bundle.detail },
    disk: diskRow.row,
    memory: memoryView(memory),
    blocksContinue: diskRow.blocks,
  };
}

function diskView(disk: LocalRuntimeCheck["disk"]): { readonly row: RowView; readonly blocks: boolean } {
  if (disk.kind === "unreadable") return { row: { status: "warn", detail: disk.message }, blocks: false };
  const free = formatDiskBytes(disk.freeBytes);
  const total = formatDiskBytes(disk.totalBytes);
  const verdict = diskVerdict(disk);
  switch (verdict.level) {
    case "block":
      return {
        row: {
          status: "fail",
          badgeLabel: "NO SPACE",
          // The row truncates: what is free, then what the embeddings model
          // and the database need, and nothing the row would cut off.
          detail: `${free} free · setup needs ${formatDiskBytes(verdict.requiredBytes)}`,
        },
        blocks: true,
      };
    case "warn": {
      const share =
        verdict.reason === "low_fraction" && disk.totalBytes > 0
          ? ` (${String(Math.floor((disk.freeBytes / disk.totalBytes) * 100))}%)`
          : "";
      return { row: { status: "warn", badgeLabel: "LOW", detail: `${free} free of ${total}${share} · running low` }, blocks: false };
    }
    case "ok":
      return { row: { status: "ok", detail: `${free} free of ${total}` }, blocks: false };
  }
}

function memoryView(memory: LocalRuntimeCheck["memory"]): RowView {
  const total = formatMemoryBytes(memory.totalBytes);
  // Free memory is advisory only: the OS counts its file cache as used.
  const free = `${formatMemoryBytes(memory.freeBytes)} free`;
  if (memoryVerdict(memory.totalBytes) === "warn") {
    return {
      status: "warn",
      badgeLabel: "LOW",
      // The LOW word says it may run slowly; the row keeps room for the numbers.
      detail: `${total} · under ${String(MEMORY_WARN_TOTAL_BYTES / 1e9)} GB · ${free}`,
    };
  }
  return { status: "ok", detail: `${total} · ${free}` };
}
