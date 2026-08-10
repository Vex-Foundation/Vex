/**
 * Exposes the packaged app's version to the in-process engine.
 *
 * `buildProductionAgentscanReporterDeps`
 * (`src/vex-agent/sync/agentscan-report.ts`) reads `process.env.VEX_APP_VERSION`
 * for the AgentScan register call's optional `appVersion` field. The engine
 * has no Electron API of its own, so main is the only place that can supply
 * it — via env, before the sync worker's executor can dynamically import
 * that code.
 */

import { app } from "electron";

const VEX_APP_VERSION_ENV_KEY = "VEX_APP_VERSION";

/**
 * Sets `VEX_APP_VERSION` from `app.getVersion()` unless already set to a
 * non-empty value — a developer override always wins.
 */
export function exposeAppVersionToEngine(): void {
  const existing = process.env[VEX_APP_VERSION_ENV_KEY];
  if (existing !== undefined && existing !== "") return;
  process.env[VEX_APP_VERSION_ENV_KEY] = app.getVersion();
}
