/**
 * Eval-only `requiresEnv` sentinels: the one owner of "make the catalog whole".
 *
 * Discovery hides an active tool whose `requiresEnv` name is unset
 * (`catalog.ts` `isProtocolToolAvailable`, mirrored by
 * `discovery.ts` `evaluateManifestDiscoverability`), and `loadProviderDotenv()`
 * deliberately skips managed secret keys. An eval process that does not set
 * these names measures a silently reduced catalog: today 34 of the 134 live
 * tools sit behind `JUPITER_API_KEY`, so both the "expected" and the "observed"
 * candidate count collapse to 100 together and every assertion built on them
 * passes while measuring the wrong catalog. That is exactly how
 * `baselines/lexical-solana.json` was captured with 68 rows at zero recall.
 *
 * Therefore every eval entry point calls this BEFORE it builds a single
 * candidate set.
 *
 * Safety contract, and why a sentinel value is not a credential leak:
 * - the value is a fixed non-secret marker, never a real key;
 * - discovery and the availability gate only test PRESENCE of the name;
 * - no protocol handler runs on any eval path that calls this (the lexical
 *   lane scores manifests, the dense lane embeds and ranks them, the probe
 *   reads), so nothing here can reach a provider;
 * - a name already set in the environment is never overwritten, so a real
 *   local key keeps working.
 *
 * This module is eval-only. Nothing under `src/vex-agent/` or `src/tools/`
 * imports it, and it must never be imported by product code.
 */

import { PROTOCOL_TOOLS } from "../../vex-agent/tools/protocols/catalog.js";
import type { ProtocolToolManifest } from "../../vex-agent/tools/protocols/types.js";

/** Opt-in flag kept for the probe CLI, whose full mode also touches a database. */
export const SENTINEL_ENV_FLAG = "VEX_EVAL_REQUIRES_ENV_SENTINELS";

/** Non-secret marker. Presence is all the availability gate reads. */
export const SENTINEL_VALUE = "vex-eval-sentinel-not-a-credential";

/**
 * Sets the sentinel for every unset `requiresEnv` name of an ACTIVE manifest.
 *
 * Active rather than active-and-advertised on purpose: the gate is per manifest
 * and an unadvertised namespace contributes no candidates either way, so the
 * wider set costs nothing and cannot leave a name unset.
 *
 * @returns every name this call set, in catalog order, with no duplicates. The
 *   list is complete and never shortened: an operator reading a probe run needs
 *   to see which names were synthesised, not a sample.
 */
export function applyRequiresEnvSentinels(
  manifests: readonly ProtocolToolManifest[] = PROTOCOL_TOOLS,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  for (const manifest of manifests) {
    if (manifest.lifecycle !== "active") continue;
    const name = manifest.requiresEnv;
    if (name === undefined) continue;
    if ((env[name] ?? "").trim().length > 0) continue;
    env[name] = SENTINEL_VALUE;
    if (!applied.includes(name)) applied.push(name);
  }
  return applied;
}

/** One-line provenance for a run log, so a capture records what it synthesised. */
export function describeAppliedSentinels(applied: readonly string[]): string {
  return `eval requiresEnv sentinels set for ${applied.length} name(s): ${applied.join(", ") || "none"}`;
}
