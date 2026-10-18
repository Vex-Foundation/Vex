/**
 * Shared schema for the user-triggered in-app updater (M13).
 *
 * `updateStatusSchema` is the single source of truth for the renderer-visible
 * update state machine (skill `vex-user-triggered-updates` §"Update UX
 * states"). It is a discriminated union on `kind` so the UI can never drift
 * into an impossible combination, and it is the Zod schema validated at BOTH
 * boundaries: main `outputSchema` / event broadcast, and the preload
 * `subscribe` payload check.
 *
 * Redaction contract: this shape carries ONLY version strings, a coarse
 * severity, a short human summary, and bounded numeric progress. It MUST NOT
 * carry installer paths, artifact URLs, tokens, raw `UpdateInfo` metadata, or
 * release-notes HTML — those never cross the IPC boundary (skill
 * §"Non-negotiable rules" 8 + §"Renderer implementation rules").
 *
 * `currentVersion` is present on every variant: main always knows
 * `app.getVersion()`, so the UI can render "current → latest" in any state.
 */

import { z } from "zod";

export const updateSeveritySchema = z.enum(["normal", "security", "critical"]);
export type UpdateSeverity = z.infer<typeof updateSeveritySchema>;

const currentVersion = z.string().min(1);
const latestVersion = z.string().min(1);

export const updateStatusSchema = z.discriminatedUnion("kind", [
  // No update operation in progress; app is at `currentVersion`.
  z.object({ kind: z.literal("idle"), currentVersion }).strict(),
  // A check is running against the update feed.
  z.object({ kind: z.literal("checking"), currentVersion }).strict(),
  // Check completed; app is on the latest version. `checkedAt` is an ISO ts.
  z
    .object({ kind: z.literal("current"), currentVersion, checkedAt: z.string().min(1) })
    .strict(),
  // A newer version is available for the user to download.
  z
    .object({
      kind: z.literal("available"),
      currentVersion,
      latestVersion,
      releaseDate: z.string().min(1).optional(),
      severity: updateSeveritySchema,
      summary: z.string().optional(),
    })
    .strict(),
  // The user asked to update, but a safe-restart gate is blocking (e.g. a
  // local runtime/DB operation or an active mission). `reason` is user-actionable.
  // `blockedAction` records which step was blocked (download vs install) so
  // the toast's "Try again" can re-invoke that SAME action, which re-checks
  // the gate live — no polling, no auto-recovery timer. The remaining fields
  // preserve context that would otherwise be discarded: `severity` /
  // `releaseDate` / `summary` carry forward from `available` when the block
  // happened on the download step; `wasDownloaded` tells the UI whether the
  // update file is already on disk (true only when blocked on install).
  z
    .object({
      kind: z.literal("blockedByOperation"),
      currentVersion,
      latestVersion,
      reason: z.string().min(1),
      blockedAction: z.enum(["download", "install"]),
      severity: updateSeveritySchema,
      releaseDate: z.string().min(1).optional(),
      summary: z.string().optional(),
      wasDownloaded: z.boolean(),
    })
    .strict(),
  // Download in progress after explicit consent. `percent` is bounded 0..100.
  z
    .object({
      kind: z.literal("downloading"),
      currentVersion,
      latestVersion,
      percent: z.number().min(0).max(100),
      bytesPerSecond: z.number().nonnegative().optional(),
      transferred: z.number().nonnegative().optional(),
      total: z.number().nonnegative().optional(),
    })
    .strict(),
  // Download finished; awaiting the user's restart-and-install action.
  z.object({ kind: z.literal("downloaded"), currentVersion, latestVersion }).strict(),
  // Restart-and-install is underway (app is quitting to apply the update).
  z.object({ kind: z.literal("installing"), currentVersion, latestVersion }).strict(),
  // A check/download/install failed. `message` is redacted + user-safe.
  z
    .object({
      kind: z.literal("error"),
      currentVersion,
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** `startUpdateNow()` ack — the download has been accepted/started. */
export const updateStartedSchema = z.object({ started: z.literal(true) }).strict();
export type UpdateStarted = z.infer<typeof updateStartedSchema>;

/** `cancelDownload()` ack — any in-flight download was cancelled. */
export const updateCancelledSchema = z.object({ cancelled: z.literal(true) }).strict();
export type UpdateCancelled = z.infer<typeof updateCancelledSchema>;

/** `restartAndInstallNow()` ack — the app is restarting to apply the update. */
export const updateRestartingSchema = z.object({ restarting: z.literal(true) }).strict();
export type UpdateRestarting = z.infer<typeof updateRestartingSchema>;

/** `openReleaseNotes()` ack — the external release page was opened. */
export const releaseNotesOpenedSchema = z.object({ opened: z.literal(true) }).strict();
export type ReleaseNotesOpened = z.infer<typeof releaseNotesOpenedSchema>;
