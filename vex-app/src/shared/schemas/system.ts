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
