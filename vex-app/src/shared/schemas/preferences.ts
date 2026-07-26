/**
 * User preferences persisted to ${userData}/preferences.json (atomic write).
 * Read by main on app start, mutated only via vex.settings.* IPC.
 *
 * Telemetry default: OFF (opt-in only per plan §L). Sentry SDK NEVER initializes
 * before user explicit consent.
 */

import { z } from "zod";

export const preferencesSchema = z
  .object({
    /** Schema version for forward-compat migrations. */
    version: z.literal(1),

    /** Telemetry / Sentry consent. Default OFF. */
    telemetry: z
      .object({
        enabled: z.boolean(),
        consentedAt: z.string().datetime().nullable(),
      })
      .strict(),

    /** Window state restoration. */
    window: z
      .object({
        width: z.number().int().min(640).max(8192),
        height: z.number().int().min(480).max(8192),
        x: z.number().int().nullable(),
        y: z.number().int().nullable(),
        maximized: z.boolean(),
      })
      .strict(),

    /**
     * Updater preferences. Ambient auto-CHECK runs on app start + window focus,
     * throttled by `lastCheckedAt` (no periodic poll). Auto-DOWNLOAD is never
     * enabled — download + restart stay explicit user actions.
     */
    updater: z
      .object({
        lastCheckedAt: z.string().datetime().nullable(),
      })
      .strict(),

    /** UI preferences (theme override is in renderer Zustand; this is for system-level). */
    ui: z
      .object({
        reducedMotion: z.enum(["auto", "always", "never"]),
      })
      .strict(),
  })
  .strict();

export type Preferences = z.infer<typeof preferencesSchema>;

export const defaultPreferences: Preferences = {
  version: 1,
  telemetry: { enabled: false, consentedAt: null },
  window: { width: 1280, height: 800, x: null, y: null, maximized: false },
  updater: { lastCheckedAt: null },
  ui: { reducedMotion: "auto" },
};
