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

/**
 * This closure's pinned inventory: 136 active advertised tools.
 *
 * S3.5 (2026-08-24): 145 to 136. The 12 public-API DexScreener tools were
 * retired whole and alias-free (owner decision D-DS2) and three tools landed
 * on identities that retirement freed, so the surface shrank by nine. Every
 * lexical baseline below was recaptured in the same change.
 *
 * 136 before stage S4, which added the four DexScreener deep-dive tools
 * (`pair.details`, `candles`, `trades`, `top.traders`). All four are new
 * identities, so this is a pure +4 and every affected baseline was recaptured
 * in the same change.
 *
 * 142 -> 143 (PR-C4): `virtuals.creator_fees`, the agent creator's trading-fee
 * status read. A new identity, so a pure +1; the virtuals lexical and dense
 * baselines were recaptured in the same change.
 *
 * A deliberate ratchet, not a duplicate of the catalog. It fails when the tool
 * surface changes without anyone noticing, which is the event that invalidates
 * every stored baseline in `baselines/`.
 *
 * To update: change this number in the same change that adds or removes tools,
 * and recapture the affected baselines with the lane's `--update` command. Do
 * not silence the test by deriving the number from the catalog.
 */
export const PINNED_LIVE_CATALOG_TOOL_COUNT = 143;

/** Active manifests in advertised namespaces. Independent of process env. */
export function liveCatalogToolCount(): number {
  return liveProtocolManifests().length;
}

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
