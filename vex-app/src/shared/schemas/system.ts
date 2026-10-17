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

const byteCountSchema = z.number().int().nonnegative();

/**
 * System Check's facts for the native runtime. Read-only: nothing is started.
 *
 * - `bundle`: the bundled Postgres and embeddings server are present and
 *   executable for this OS and arch, where main would run them from.
 * - `disk`: the volume that holds the runtime directory, and what the
 *   embeddings model still needs from it. `unreadable` when `statfs` failed.
 * - `memory`: `os.totalmem()` / `os.freemem()`.
 *
 * The verdicts over these facts are `shared/local-runtime-requirements.ts`.
 */
export const localRuntimeCheckSchema = z
  .object({
    bundle: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("present"),
          platform: osPlatformSchema,
          arch: z.enum(["x64", "arm64"]),
        })
        .strict(),
      z.object({ kind: z.literal("missing"), detail: z.string() }).strict(),
    ]),
    disk: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("measured"),
          freeBytes: byteCountSchema,
          totalBytes: byteCountSchema,
          modelVerified: z.boolean(),
          modelBytesToWrite: byteCountSchema,
        })
        .strict(),
      z.object({ kind: z.literal("unreadable"), message: z.string() }).strict(),
    ]),
    memory: z
      .object({
        totalBytes: byteCountSchema,
        freeBytes: byteCountSchema,
      })
      .strict(),
  })
  .strict();
export type LocalRuntimeCheck = z.infer<typeof localRuntimeCheckSchema>;

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
