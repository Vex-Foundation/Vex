/**
 * Which provider runs Vex's local services in this process.
 *
 * Until the native runtime ships (plan D11), the compose provider stays the
 * default and the native runtime is an explicit opt-in for unpackaged builds:
 * `VEX_RUNTIME=native pnpm dev`. A packaged build ignores the variable: users
 * get the provider the release chose, never one an environment variable
 * picked. An e2e run whose door already published a database keeps that
 * database; the native runtime never displaces it.
 *
 * This is the switch that the release-N flip deletes along with the compose
 * provider (it is in the no-container ratchet's baseline for that reason).
 */

import type { RuntimeProviderId } from "./provider.js";

export type RuntimeMode = RuntimeProviderId;

const DEFAULT_MODE: RuntimeMode = "docker";

export function resolveRuntimeMode(input: {
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly connectionAlreadyPublished: boolean;
}): RuntimeMode {
  if (input.packaged || input.connectionAlreadyPublished) return DEFAULT_MODE;
  return input.env["VEX_RUNTIME"] === "native" ? "native" : DEFAULT_MODE;
}

let mode: RuntimeMode = DEFAULT_MODE;

/** Decided once at boot (index.ts), after the e2e door. */
export function setRuntimeMode(value: RuntimeMode): void {
  mode = value;
}

export function getRuntimeMode(): RuntimeMode {
  return mode;
}
