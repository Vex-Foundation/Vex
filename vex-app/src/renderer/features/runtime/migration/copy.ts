/**
 * Every word the migration screen says. The one renderer file that names
 * Docker, because the user's data is in it; it is in the no-Docker baseline
 * and goes when that migration path is deleted.
 */

import type { RuntimeMigrationFailureReason } from "@shared/schemas/runtime-migration.js";
import type { SetupStatusTone } from "../../../components/onboarding/SetupStatusCard.js";

export const SCREEN_TITLE = "Move your data";
export const SCREEN_SUBLINE = "Vex no longer needs Docker. Your existing data can move to the database that now runs on this computer.";

export const INTRO: readonly string[] = [
  "This version of Vex runs its database on this computer, without Docker. Your sessions, memory and settings from the previous version are still in Docker.",
  "Moving them copies everything into the new database and checks every table against the original before Vex uses it. The copy in Docker is kept, untouched.",
  "Docker has to run this one time. For most installs the move takes a few minutes.",
];

/** Said by every failure that leaves the old data as it was (all of them). */
const UNTOUCHED = "Your data in Docker is untouched.";

export const RESUME_NOTE = "An earlier move stopped partway. Vex picks up after the last step it finished.";
export const LAST_FAILURE_TITLE = "The last attempt did not finish";

export const MOVE_LABEL = "Move my data";
export const TRY_AGAIN_LABEL = "Try again";
export const START_FRESH_LABEL = "Start fresh";
export const START_FRESH_OPEN_LABEL = "Start fresh instead";

export const OFFLINE = {
  word: "Docker off",
  title: "Docker is not running",
  advice:
    "Vex reads your data from Docker one last time. Start it (Docker Desktop, or the service on Linux), wait until it is running, then try again.",
} as const;

export const UNREADABLE = {
  word: "Unreadable",
  title: "Vex could not read its runtime state",
  advice:
    "Nothing was changed and nothing was started. The file is runtime-state.json in Vex's runtime folder; the logs say why it could not be read.",
} as const;

/** The typed confirmation in front of start fresh: the old data then stays only in Docker. */
export const START_FRESH_CONFIRM = {
  phrase: "start fresh",
  explain:
    "Start fresh creates an empty database. Your existing data is not moved: it stays only in Docker, and this version of Vex does not read it.",
  label: 'Type "start fresh" to confirm',
  confirm: "Start fresh without my data",
  cancel: "Cancel",
} as const;

export const MOVING_NOTE = "Keep Vex open while your data moves. If it quits, the move continues after the last finished step on the next launch.";
export const STARTING_FRESH = "Creating a new local database";

export const DONE = {
  migrated: {
    word: "Moved",
    title: "Your data is moved",
    detail: "Every table matched the original. The copy in Docker is kept until you remove it.",
  },
  fresh: {
    word: "Fresh",
    title: "A new local database is ready",
    detail: "Your earlier data stays in Docker.",
  },
  stackStillRunning: "The old database could not be stopped; you can stop it in Docker.",
  advancing: "Starting the local runtime…",
} as const;

export const CANCELLED = {
  word: "Stopped",
  title: "The move stopped",
  detail: "It continues after the last finished step.",
} as const;

/* ------------------------------ step rows ----------------------------- */

export type MigrationRowKey = "source" | "copy" | "restore" | "verify" | "finish";

export const ROW_LABEL: Record<MigrationRowKey, string> = {
  source: "Old database",
  copy: "Copy",
  restore: "New database",
  verify: "Check",
  finish: "Finish",
};

export const ROW_WAITING: Record<MigrationRowKey, string> = {
  source: "Waiting to start",
  copy: "Waiting for the old database",
  restore: "Waiting for the copy",
  verify: "Waiting for the new database",
  finish: "Waiting for the check",
};

export const ROW_READY: Record<MigrationRowKey, string> = {
  source: "Read from Docker",
  copy: "Copied and sealed on disk",
  restore: "Loaded into the database on this computer",
  verify: "Every table and vector matched",
  finish: "Vex now uses the new database",
};

export const ROW_ACTIVE = {
  preparing: { word: "preparing", detail: "Getting ready" },
  starting_source: { word: "starting", detail: "Starting the old database in Docker" },
  copying: { word: "copying" },
  restoring: { word: "loading", detail: "Loading the copy into the new database" },
  verifying: { word: "checking", detail: "Comparing every table with the original" },
  finishing: { word: "finishing", detail: "Stopping the old database" },
} as const;

/** "12.3 MB of about 45.6 MB": the copy is compressed, so it usually ends below the estimate. */
export function copyDetail(written: string, estimated: string | null): string {
  return estimated === null ? `${written} copied` : `${written} of about ${estimated}`;
}

/* ------------------------------- failures ----------------------------- */

export interface FailureCopy {
  readonly tone: SetupStatusTone;
  readonly word: string;
  readonly title: string;
  readonly advice: string | null;
}

export function failureCopy(
  reason: RuntimeMigrationFailureReason,
  bytes: { readonly required: string; readonly available: string } | null,
): FailureCopy {
  switch (reason) {
    case "source_offline":
      return { tone: "warn", word: OFFLINE.word, title: OFFLINE.title, advice: OFFLINE.advice };
    case "source_volume_missing":
      return {
        tone: "error",
        word: "Missing",
        title: "The old database is gone",
        advice: "Docker no longer has this install's database volume, so there is nothing to move. Start fresh to continue.",
      };
    case "source_unavailable":
      return {
        tone: "error",
        word: "No answer",
        title: "The old database did not start",
        advice:
          "Docker is running, but this install's old database did not come up, or another database answered in its place. Check Docker, then try again.",
      };
    case "source_empty":
      return {
        tone: "warn",
        word: "Empty",
        title: "The old database is empty",
        advice: "Setup never finished in the previous version, so there is no data to move. Start fresh to continue.",
      };
    case "disk_full":
      return {
        tone: "error",
        word: "Disk full",
        title: "Not enough disk space",
        advice:
          bytes === null
            ? "This disk filled up during the move. Free up space, then try again."
            : `Moving the data needs ${bytes.required} free on this disk; ${bytes.available} is available. Free up space, then try again.`,
      };
    case "dump_failed":
      return {
        tone: "error",
        word: "Failed",
        title: "Copying from the old database failed",
        advice: `${UNTOUCHED} Try again; the logs say what the copy reported.`,
      };
    case "dump_corrupt":
      return {
        tone: "error",
        word: "Changed",
        title: "The copy changed on disk",
        advice: "The copy no longer matches what was read, so Vex discarded it. Try again to copy it afresh.",
      };
    case "native_unavailable":
      return {
        tone: "error",
        word: "Missing",
        title: "Part of the local runtime is missing",
        advice: `This copy of Vex is missing a program it ships with, and reinstalling Vex restores it. ${UNTOUCHED}`,
      };
    case "native_start_failed":
      return {
        tone: "error",
        word: "Failed",
        title: "The new database could not start",
        advice: `${UNTOUCHED} Try again; the logs say why the database stopped.`,
      };
    case "native_cluster_busy":
      return {
        tone: "error",
        word: "Busy",
        title: "Another database server holds Vex's data folder",
        advice: "Quit any other copy of Vex, then try again.",
      };
    case "restore_failed":
      return {
        tone: "error",
        word: "Failed",
        title: "Loading your data into the new database failed",
        advice: `Vex discarded the partial copy. ${UNTOUCHED} Try again.`,
      };
    case "verify_failed":
      return {
        tone: "error",
        word: "Mismatch",
        title: "The copy did not match the original",
        advice:
          `Vex compared every table and found differences, so it discarded the copy. ${UNTOUCHED} Try again; the logs list the differences.`,
      };
    case "state_unreadable":
      return { tone: "error", word: UNREADABLE.word, title: UNREADABLE.title, advice: UNREADABLE.advice };
    case "busy":
      return {
        tone: "warn",
        word: "Busy",
        title: "Another step is already running",
        advice: "Wait a moment, then try again.",
      };
    case "not_pending":
      return { tone: "info", word: "Nothing", title: "There is no data to move", advice: null };
    case "unexpected":
      return {
        tone: "error",
        word: "Failed",
        title: "The move stopped unexpectedly",
        advice: `${UNTOUCHED} Try again; the logs say what happened.`,
      };
  }
}

export const START_FRESH_FAILED_TITLE = "Starting fresh failed";

/* ------------------- Settings: remove the old data -------------------- */

/**
 * Settings → Local runtime, once the move completed: removing what the
 * previous version left in Docker. After a start-fresh that data was never
 * imported, so the copy says plainly that removing it deletes its only copy.
 */
export const REMOVE_OLD_DATA = {
  heading: "Old Docker data",
  bodyImported:
    "Your data was moved into the database on this computer and checked against the original. The copy the previous version kept in Docker is no longer needed; removing it frees its disk space.",
  bodyNotImported:
    "This install started fresh, so its earlier data was never imported. That data is still in Docker, and it is the only copy: removing it deletes it for good.",
  open: "Remove old Docker data…",
  dialogTitle: "Remove old Docker data?",
  descriptionImported: "Deletes the previous version's database from Docker. Vex no longer uses it.",
  descriptionNotImported: "Deletes the previous version's database from Docker. It was never imported into Vex.",
  whatImported: "Deletes the copy of your data the previous version kept in Docker.",
  whatNotImported: "Deletes the only copy of your data from before this version: it was never imported.",
  kept: "Your data in the database on this computer, your wallets and the vault stay.",
  undo: "This cannot be undone. Docker has no way to bring the data back.",
  phrase: "REMOVE",
  submit: "Remove old data",
  pending: "Removing…",
  done: "The old Docker data was removed.",
} as const;

/** What a refused or failed removal means for the person who asked for it. */
export function removeOldDataProblem(
  outcome:
    | { readonly kind: "refused"; readonly reason: "not_completed" | "not_imported" | "install_changed" | "busy" }
    | { readonly kind: "failed"; readonly reason: "source_offline" | "failed"; readonly message: string },
): string {
  if (outcome.kind === "failed") {
    return outcome.reason === "source_offline"
      ? "Docker is not running, so nothing was removed. Start Docker, wait until it is running, then try again."
      : `Nothing was removed: ${outcome.message}`;
  }
  switch (outcome.reason) {
    case "not_completed":
      return "Vex keeps the old data until your data has finished moving, so nothing was removed.";
    case "not_imported":
      return "This install started fresh, so the old data is its only copy. Nothing was removed.";
    case "install_changed":
      return "The old data belongs to a different install of Vex, so it was left alone.";
    case "busy":
      return "Another step of the move is running. Try again when it finishes.";
  }
}
