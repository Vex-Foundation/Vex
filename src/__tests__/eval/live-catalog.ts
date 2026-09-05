/**
 * The one source of the expected candidate count for BOTH eval lanes.
 *
 * The defect this replaces: the dense runner passed
 * `buildDiscoveryCandidates().length` as the EXPECTED count to
 * `assertDenseMeasurement`. That number is environment-dependent, so on a
 * machine without `JUPITER_API_KEY` expected and observed were both 100 and the
 * assertion certified a catalog that had silently lost 34 tools.
 *
 * The expected count must therefore come from an environment-INDEPENDENT
 * source: the live catalog itself, meaning every active manifest in an
 * advertised namespace (`liveProtocolManifests()`). Availability by env is what
 * the sentinels in `requires-env-sentinels.ts` restore; it is never what the
 * expectation is derived from.
 */

import { buildDiscoveryCandidates } from "./lexical-retrieval.js";
import { liveProtocolManifests } from "./retrieval-eval-harness.js";

/** Active manifests in advertised namespaces. Independent of process env. */
export function liveCatalogToolCount(): number {
  return liveProtocolManifests().length;
}

/**
 * The number of active advertised protocol tools every stored baseline was
 * captured against. 145 after the launchpads waves 1-2 integration (#161);
 * 147 with the two in-app launchpads tools (`launchpads.images`,
 * `launchpads.image_publish`); 149 with the Virtuals bonding-curve trade pair
 * (`virtuals__agent_trade_quote` / `_execute`), two new identities on a
 * namespace that previously advertised reads only, so this is a pure +2 and
 * every affected baseline was recaptured in the same change; 151 with the
 * pools.fun holder-rewards MUTATIONS (`pools.holder_rewards_claim`,
 * `pools.holder_rewards_distribute`), again two new identities on an existing
 * namespace, so a pure +2 and every affected baseline recaptured here; 155 with
 * the Virtuals AGENT-LAUNCH family (`virtuals.launch.preview` / `.execute` /
 * `.status` / `.cancel`) - four rather than two because the venue's launch
 * takes two transactions and only the first is Vex's, so the state between
 * them needs its own read and its own exit. Four new identities on an existing
 * namespace, a pure +4, and every affected baseline recaptured in this change.
 */
export const PINNED_LIVE_CATALOG_TOOL_COUNT = 155;

/**
 * The candidate count every dense and lexical measurement must have seen.
 *
 * Throws when the live catalog no longer matches the pinned inventory, because
 * in that case no stored baseline is comparable and a writer must not run.
 */
export function expectedCandidateCount(): number {
  const live = liveCatalogToolCount();
  if (live !== PINNED_LIVE_CATALOG_TOOL_COUNT) {
    throw new Error(
      `Live catalog has ${live} active advertised tools but this closure pins `
      + `${PINNED_LIVE_CATALOG_TOOL_COUNT} (PINNED_LIVE_CATALOG_TOOL_COUNT in `
      + "src/__tests__/eval/live-catalog.ts). Every stored baseline was captured against the "
      + "pinned inventory, so they are no longer comparable. Update the constant in the change "
      + "that moved the tool surface and recapture the affected baselines.",
    );
  }
  return live;
}

/**
 * Asserts the candidate set THIS process would score is the full catalog.
 *
 * Called by every lexical and dense target before its measurement reaches the
 * baseline writer. A shortfall means a `requiresEnv` name is still unset, so
 * the run would measure the absence of the hidden tools and record it as
 * quality.
 */
export function assertFullDiscoveryCandidates(context: string): number {
  const expected = expectedCandidateCount();
  const actual = buildDiscoveryCandidates().length;
  if (actual !== expected) {
    const missing = liveProtocolManifests()
      .filter((manifest) => manifest.requiresEnv !== undefined)
      .filter((manifest) => (process.env[manifest.requiresEnv ?? ""] ?? "").trim().length === 0)
      .map((manifest) => `${manifest.toolId} (requires ${String(manifest.requiresEnv)})`);
    throw new Error(
      `${context}: discovery would score ${actual} candidates, expected ${expected}. `
      + "The catalog is reduced in this process, so the run would measure the ABSENCE of the "
      + "hidden tools and store it as a baseline. Call applyRequiresEnvSentinels() from "
      + "requires-env-sentinels.ts before building any candidate set.\n"
      + `Tools hidden by an unset requiresEnv (${missing.length}):\n`
      + missing.map((entry) => `  ${entry}`).join("\n"),
    );
  }
  return expected;
}
