/**
 * WHICH PROVIDER KEYS THIS INSTALLATION ACTUALLY HAS.
 *
 * The measured failure this exists for: `.vex/protocols.md` tells an agent that
 * TwitterAccount, WebResearch and all 34 solana tools need a key, and nothing
 * tells it WHICH keys are present here, so the first call to an unconfigured
 * tool is always a wasted one (clarity review A17, t1 #16, p1 #27). The managed
 * block can answer that, because it is written by the app that owns the
 * environment.
 *
 * NAMES ONLY, NEVER VALUES. A configured key is reported as its variable NAME
 * and nothing else. The value is a secret and never reaches a file in the user's
 * repository (rule 07).
 *
 * THE READ IS INJECTED, NOT AMBIENT. `resolveStudioInstallationEnvironment`
 * reads `process.env` at render time - correct, because the render runs in the
 * privileged main process that owns the app's environment - but every renderer
 * TAKES the resolved value as a parameter. That is what keeps the installer
 * goldens byte-stable on any machine and lets a test state an environment
 * instead of mutating the process.
 *
 * IT IS INSIDE THE DRIFT HASH, deliberately. Configuring a key changes the block
 * on the next render, which is a real change an agent should see, and the change
 * log says so like any other.
 */

import { buildStudioInventory } from "../../mcp/inventory/index.js";

/** The provider keys the exported surface declares, split by what is present. */
export interface StudioInstallationEnvironment {
  /** Declared variables that are set and non-empty here, sorted. */
  readonly configuredKeys: readonly string[];
  /** Declared variables that are missing or empty here, sorted. */
  readonly missingKeys: readonly string[];
}

/** Every environment variable any exported tool declares, sorted, deduplicated. */
export function studioDeclaredEnvironmentKeys(): readonly string[] {
  return [...new Set(
    buildStudioInventory().flatMap((tool) => tool.requiresEnv ? [tool.requiresEnv] : []),
  )].sort();
}

/**
 * The environment as it stands in THIS process.
 *
 * A variable that is set to whitespace counts as missing: the tools treat it the
 * same way, and reporting it as configured would send an agent into the failure
 * this line exists to prevent.
 */
export function resolveStudioInstallationEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): StudioInstallationEnvironment {
  const declared = studioDeclaredEnvironmentKeys();
  const configuredKeys = declared.filter((name) => (env[name] ?? "").trim() !== "");
  const missing = new Set(configuredKeys);
  return {
    configuredKeys,
    missingKeys: declared.filter((name) => !missing.has(name)),
  };
}

/** Is the key this tool or namespace needs configured here? */
export function isStudioEnvironmentKeyConfigured(
  environment: StudioInstallationEnvironment,
  key: string | undefined,
): boolean {
  return key === undefined || environment.configuredKeys.includes(key);
}
