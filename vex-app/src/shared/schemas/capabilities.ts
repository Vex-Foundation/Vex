/**
 * Capabilities exposed via vex.capabilities.get() — feature flags + phase tracking.
 *
 * Renderer queries this on startup and uses it to conditionally render
 * Phase 2 placeholder UI vs active features. Phase 2 IPC methods are NOT
 * exposed in window.vex until they're implemented (avoid attack surface).
 */

import { z } from "zod";

export const phaseSchema = z.enum(["phase1", "phase2"]);
export type Phase = z.infer<typeof phaseSchema>;

export const capabilitiesSchema = z
  .object({
    phase: phaseSchema,
    appVersion: z.string(),
    onboardingComplete: z.boolean(),
    /**
     * M11: `true` iff Sentry telemetry can be enabled in this build —
     * i.e. a DSN is resolvable at runtime. Renderer hides the consent
     * checkbox when false (replaces with a "telemetry unavailable in
     * this build" notice). Phase 1 resolves DSN from
     * `process.env.VEX_SENTRY_DSN`; M14 adds a build-time-baked
     * fallback for packaged dev releases.
     */
    telemetryAvailable: z.boolean(),
    features: z
      .object({
        // Phase 1
        splash: z.boolean(),
        systemCheck: z.boolean(),
        wizard: z.boolean(),
        wallets: z.boolean(),
        // Phase 2 (always false until implemented)
        chat: z.boolean(),
        missions: z.boolean(),
        portfolio: z.boolean(),
        memory: z.boolean(),
        tools: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type Capabilities = z.infer<typeof capabilitiesSchema>;
