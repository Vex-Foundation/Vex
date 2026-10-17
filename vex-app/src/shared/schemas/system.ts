/**
 * Schemas for vex.system.* IPC payloads.
 */

import { z } from "zod";
import { sessionTitleSchema } from "./sessions.js";

export const osPlatformSchema = z.enum(["darwin", "win32", "linux"]);
export type OsPlatform = z.infer<typeof osPlatformSchema>;

export const osInfoSchema = z
  .object({
    platform: osPlatformSchema,
    arch: z.enum(["x64", "arm64"]),
    release: z.string(),
    distro: z.string().nullable(),
    homedir: z.string(),
    userDataDir: z.string(),
    appVersion: z.string(),
    electronVersion: z.string(),
    nodeVersion: z.string(),
  })
  .strict();
export type OsInfo = z.infer<typeof osInfoSchema>;

export const networkProbeSchema = z
  .object({
    online: z.boolean(),
    latencyMs: z.number().int().nullable(),
    probedAt: z.string().datetime(),
  })
  .strict();
export type NetworkProbe = z.infer<typeof networkProbeSchema>;

/**
 * `native`: main runs the bundled local runtime and starts it itself, so setup
 * skips the container bootstrap screens and goes straight to migrations.
 */
export const runtimeInfoSchema = z
  .object({
    native: z.boolean(),
  })
  .strict();
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

/**
 * The native runtime's start, as the "Preparing local runtime" screen shows
 * it: the database, then the embeddings model (checked, downloaded on first
 * run, verified), then the embeddings server. Setup waits for `ready` (D14).
 *
 * `seq` grows with every change, so a renderer holding a newer state than a
 * status reply that crossed it in flight keeps the newer one. Outside the
 * native runtime the status stays `idle`.
 */
export const nativeRuntimeStepSchema = z.enum(["postgres", "model", "embeddings"]);
export type NativeRuntimeStep = z.infer<typeof nativeRuntimeStepSchema>;

/**
 * `offline`: no model source could be reached; `unavailable`: a bundled binary
 * is missing; the rest are the start vocabulary the supervisors report.
 */
export const nativeRuntimeFailureKindSchema = z.enum([
  "disk_full",
  "offline",
  "foreign_listener",
  "port_collision",
  "unhealthy",
  "unavailable",
  "failed",
]);
export type NativeRuntimeFailureKind = z.infer<typeof nativeRuntimeFailureKindSchema>;

export const nativeRuntimeModelStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("checking") }).strict(),
  z
    .object({
      state: z.literal("downloading"),
      receivedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().positive(),
      /** null until a full measuring window has passed. */
      bytesPerSecond: z.number().nonnegative().nullable(),
    })
    .strict(),
  z.object({ state: z.literal("verifying") }).strict(),
]);
export type NativeRuntimeModelState = z.infer<typeof nativeRuntimeModelStateSchema>;

const seqSchema = z.number().int().nonnegative();

export const nativeRuntimeStatusSchema = z.discriminatedUnion("phase", [
  z.object({ seq: seqSchema, phase: z.literal("idle") }).strict(),
  /** `initializing`: no cluster yet, so this start creates it (first run). */
  z.object({ seq: seqSchema, phase: z.literal("postgres"), initializing: z.boolean() }).strict(),
  z.object({ seq: seqSchema, phase: z.literal("model"), model: nativeRuntimeModelStateSchema }).strict(),
  z.object({ seq: seqSchema, phase: z.literal("embeddings") }).strict(),
  z.object({ seq: seqSchema, phase: z.literal("ready") }).strict(),
  z
    .object({
      seq: seqSchema,
      phase: z.literal("failed"),
      /** The step that failed; the steps before it had finished. */
      step: nativeRuntimeStepSchema,
      kind: nativeRuntimeFailureKindSchema,
      /** The runtime's own reason, as it logged it. */
      message: z.string(),
    })
    .strict(),
]);
export type NativeRuntimeStatus = z.infer<typeof nativeRuntimeStatusSchema>;

/**
 * A directory's footprint on disk, measured by main's bounded walk.
 * `complete` is false when the walk stopped at its entry bound or met an
 * entry it could not read: `bytes` is then a lower bound, never a guess.
 */
export const runtimeDirSizeSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
export type RuntimeDirSize = z.infer<typeof runtimeDirSizeSchema>;

/**
 * vex.system.runtimeInfo - what the Settings "Local runtime" section shows
 * beside the live status: the pinned release (native-runtime.lock.json), the
 * versions the bundled binaries report, and the size of the database and the
 * embeddings model. A version is null when its binary could not say. No path
 * crosses the boundary.
 */
const versionSchema = z.string().min(1).max(64).nullable();

/**
 * Whether the previous release's data may still be on this computer, from
 * runtime-state.json: `kept` once the move into the native runtime completed
 * (`imported`: the data was copied; false after a start-fresh, when that old
 * data is its only copy) and until its removal was recorded; `none` otherwise.
 */
export const previousReleaseDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("kept"), imported: z.boolean() }).strict(),
]);
export type PreviousReleaseData = z.infer<typeof previousReleaseDataSchema>;

export const localRuntimeInfoSchema = z
  .object({
    release: z.string().min(1).max(128),
    versions: z
      .object({
        postgres: versionSchema,
        pgvector: versionSchema,
        llamaCpp: versionSchema,
      })
      .strict(),
    sizes: z
      .object({
        database: runtimeDirSizeSchema,
        model: runtimeDirSizeSchema,
      })
      .strict(),
    previousReleaseData: previousReleaseDataSchema,
  })
  .strict();
export type LocalRuntimeInfo = z.infer<typeof localRuntimeInfoSchema>;

/**
 * Why main refused to restart or reset the native runtime. `busy`: a start, a
 * restart, a reset or a data/schema migration is running; `migration_pending`:
 * runtime-state.json records an unfinished migration, which owns the cluster;
 * `state_unreadable`: that file does not parse; `path_unsafe`: the data
 * directory is not where it must be (inside the runtime directory, a real
 * directory); `still_running`: a postmaster still holds the data directory.
 */
export const localRuntimeRefusalSchema = z.enum([
  "not_native",
  "busy",
  "migration_pending",
  "state_unreadable",
  "path_unsafe",
  "still_running",
]);
export type LocalRuntimeRefusal = z.infer<typeof localRuntimeRefusalSchema>;

const refusedSchema = z
  .object({
    kind: z.literal("refused"),
    reason: localRuntimeRefusalSchema,
    message: z.string(),
  })
  .strict();

/**
 * vex.system.runtimeRestart - stop both servers and start them again. The
 * progress event shows the start; the answer carries how it ended.
 */
export const runtimeRestartResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restarted"), status: nativeRuntimeStatusSchema }).strict(),
  z
    .object({ kind: z.literal("failed"), message: z.string(), status: nativeRuntimeStatusSchema })
    .strict(),
  refusedSchema,
]);
export type RuntimeRestartResult = z.infer<typeof runtimeRestartResultSchema>;

/**
 * The phrase the user types to confirm "Reset local data". Main checks it as
 * well, so a renderer that skipped its own confirmation cannot reset.
 */
export const LOCAL_DATA_RESET_PHRASE = "RESET";

export const runtimeResetInputSchema = z
  .object({ confirmation: z.literal(LOCAL_DATA_RESET_PHRASE) })
  .strict();
export type RuntimeResetInput = z.infer<typeof runtimeResetInputSchema>;

/**
 * vex.system.runtimeReset - delete the local database (wallets, the vault, the
 * config and the embeddings model are kept). On `reset` Vex relaunches into
 * setup, which creates a new cluster.
 */
export const runtimeResetResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reset"),
      deletedBytes: z.number().int().nonnegative(),
      relaunching: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal("failed"), message: z.string() }).strict(),
  refusedSchema,
]);
export type RuntimeResetResult = z.infer<typeof runtimeResetResultSchema>;

export const healthReportSchema = z
  .object({
    os: osInfoSchema,
    network: networkProbeSchema,
    translocated: z.boolean(),
    setupComplete: z.boolean(),
    /** Computed at probe time, for splash status display. */
    overall: z.enum(["ok", "degraded", "not_ready"]),
  })
  .strict();
export type HealthReport = z.infer<typeof healthReportSchema>;

/**
 * vex.system.notifyTurnComplete - OS-native turn-complete notification (A34).
 * The renderer supplies only the session title (validated by the SAME schema
 * that bounds session names everywhere); main decides whether to show it by
 * checking window focus ITSELF - the renderer's opinion about focus is never
 * part of the contract.
 */
export const notifyTurnCompleteInputSchema = z
  .object({ sessionTitle: sessionTitleSchema })
  .strict();
export type NotifyTurnCompleteInput = z.infer<typeof notifyTurnCompleteInputSchema>;

/** `shown` is honest feedback: false = focused window or unsupported OS. */
export const notifyTurnCompleteResultSchema = z
  .object({ shown: z.boolean() })
  .strict();
export type NotifyTurnCompleteResult = z.infer<typeof notifyTurnCompleteResultSchema>;

/**
 * vex.system.setTitleBarOverlay - recolour the native title bar overlay
 * (Windows and Linux) when the resolved theme changes. The renderer names only
 * the theme id; the colours are main-owned constants, so no colour string ever
 * crosses the boundary. `applied` is false on macOS (traffic lights have no
 * overlay) and on a native-frame window.
 */
export const titleBarThemeSchema = z.enum(["chronos", "celeris"]);
export type TitleBarTheme = z.infer<typeof titleBarThemeSchema>;

export const setTitleBarOverlayInputSchema = z
  .object({ theme: titleBarThemeSchema })
  .strict();
export type SetTitleBarOverlayInput = z.infer<typeof setTitleBarOverlayInputSchema>;

export const setTitleBarOverlayResultSchema = z
  .object({ applied: z.boolean() })
  .strict();
export type SetTitleBarOverlayResult = z.infer<typeof setTitleBarOverlayResultSchema>;
