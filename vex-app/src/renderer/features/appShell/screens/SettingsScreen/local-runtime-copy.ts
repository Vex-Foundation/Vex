/**
 * Copy for Settings' "Local runtime" section (plan 8.4): the bundled database
 * and embeddings server Vex runs on this computer. Pure, so the words are
 * pinned by tests without rendering.
 */

import type { RuntimeDirSize } from "@shared/schemas/system.js";

export const LOCAL_RUNTIME_SECTION_NAME = "Local runtime";
export const LOCAL_RUNTIME_SECTION_HINT =
  "The database and embeddings server running on this computer";

export const LOCAL_RUNTIME_LEDE =
  "Vex keeps its database and its embeddings model on this computer and runs them itself.";

export const LOCAL_RUNTIME_STATUS_HEADING = "Status";
export const LOCAL_RUNTIME_VERSIONS_HEADING = "Versions";
export const LOCAL_RUNTIME_DATA_HEADING = "On this computer";
export const LOCAL_RUNTIME_MAINTENANCE_HEADING = "Maintenance";
export const LOCAL_RUNTIME_RESET_HEADING = "Reset local data";

export const VERSION_LABELS = {
  release: "Runtime release",
  postgres: "Postgres",
  pgvector: "pgvector",
  llamaCpp: "llama.cpp",
} as const;

export const DATA_LABELS = {
  database: "Database",
  model: "Embeddings model",
} as const;

/** A version the binary could not report. */
export const VERSION_UNKNOWN = "Unknown";
export const INFO_LOADING = "Reading…";
export const INFO_FAILED = "Could not read the runtime's details.";

export const RESTART_LABEL = "Restart runtime";
export const RESTART_PENDING = "Restarting…";
export const RESTART_HELP =
  "Stops the database and the embeddings server and starts them again. Anything the agent is doing pauses until they are back.";
export const RESTART_DONE = "The local runtime restarted.";

export const RESET_BODY =
  "Deletes the local database: sessions, messages, memory and history. Your wallets, the vault, your settings and the embeddings model stay. Vex then restarts and sets up a new, empty database.";
export const RESET_OPEN = "Reset local data…";

export const RESET_DIALOG_TITLE = "Reset local data?";
export const RESET_DIALOG_DESCRIPTION =
  "The local database on this computer is deleted and a new one is created when Vex restarts.";
export const RESET_CONSEQUENCE_WHAT = "Deletes every session, message, memory and history entry Vex has stored.";
export const RESET_CONSEQUENCE_KEPT =
  "Keeps your wallets, the vault, your settings and the embeddings model.";
export const RESET_CONSEQUENCE_UNDO = "This cannot be undone. Vex has no way to bring the data back.";
export const RESET_CONFIRM_LABEL = "Confirmation";
export const RESET_CONFIRM_MISMATCH = "That does not match yet.";
export const RESET_CANCEL = "Cancel";
export const RESET_SUBMIT = "Reset and restart";
export const RESET_PENDING = "Resetting…";
export const RESET_RELAUNCHING = "Local data deleted. Vex is restarting…";

export function resetConfirmPrompt(phrase: string): string {
  return `Type ${phrase} to confirm`;
}

/** Decimal units, like the runtime screen's download ("333.6 MB"). */
export function formatDiskSize(size: RuntimeDirSize): string {
  const value =
    size.bytes >= 1_000_000_000
      ? `${(size.bytes / 1_000_000_000).toFixed(2)} GB`
      : `${(size.bytes / 1_000_000).toFixed(1)} MB`;
  // A walk that stopped at its bound measured part of the folder.
  return size.complete ? value : `at least ${value}`;
}
