/**
 * vex.capabilities.get() — feature flags + phase tracking.
 *
 * Phase 1 shell plus landed Phase 2 slices. Feature flags flip only after
 * the corresponding typed bridge + main handler is implemented.
 */

import { app } from "electron";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  capabilitiesSchema,
  type Capabilities,
} from "@shared/schemas/capabilities.js";
import { SETUP_COMPLETE_FILE } from "../paths/config-dir.js";
import { resolveDsn } from "../telemetry/dsn.js";
import { registerHandler } from "./register-handler.js";

const inputSchema = z.object({}).strict();

async function isOnboardingComplete(): Promise<boolean> {
  try {
    await fs.access(SETUP_COMPLETE_FILE);
    return true;
  } catch {
    return false;
  }
}

export function registerCapabilitiesHandler(): () => void {
  return registerHandler({
    channel: CH.capabilities.get,
    domain: "capabilities",
    inputSchema,
    outputSchema: capabilitiesSchema,
    handle: async (): Promise<Result<Capabilities>> => {
      const onboardingComplete = await isOnboardingComplete();
      // Sentry-free DSN resolution per codex v3 hard fix #2 — keeping
      // capabilities.get() out of the SDK load path so a renderer can
      // poll for `telemetryAvailable` without ever touching @sentry/electron.
      const telemetryAvailable = resolveDsn() !== null;
      const caps: Capabilities = capabilitiesSchema.parse({
        phase: "phase1",
        appVersion: app.getVersion(),
        onboardingComplete,
        telemetryAvailable,
        features: {
          splash: true,
          systemCheck: true,
          wizard: false, // M7+
          wallets: false, // M8
          chat: true,
          missions: true,
          portfolio: false,
          memory: true, // stage 7-2a + S9: read-only memory panel
          tools: false,
        },
      });
      return ok(caps);
    },
  });
}
