/**
 * Z500 allocation-sync configuration — every number the spec pins, pinned
 * once (indexiy-ansem.md, Target Configuration).
 *
 * THE STACK ID IS A CONSTANT, NOT A PARAMETER. The spec's first acceptance
 * criterion is "the existing Stack 28440 is the only Stack affected", and the
 * strongest form of that guarantee is that no caller can pass a different id:
 * the runner reads it from here and nothing else.
 */

/** The one stack this workflow may touch: Vex Agent Index. */
export const Z500_STACK_ID = 28440;

/** Its slug, for run records and links only — identity is the numeric id. */
export const Z500_STACK_SLUG = "vex-agent-index";

/** How many tokens the target allocation holds. */
export const Z500_TARGET_TOKEN_COUNT = 10;

/** Equal weight per selected token, integer percent. 10 × 10 = 100. */
export const Z500_WEIGHT_PER_TOKEN = 10;

/**
 * How far down the Z500 ranking the eligibility scan may walk while
 * backfilling excluded tokens. Each candidate costs one Indexify request
 * (10 rps leaky bucket), so the walk is bounded; a curated universe that
 * cannot produce 10 eligible tokens in its top 50 is a no-change failure by
 * the spec's own "fewer than 10 eligible" branch.
 */
export const Z500_CANDIDATE_SCAN_CAP = 50;

/**
 * A claim within this window of the scheduled 00:00 UTC counts as
 * `scheduled`; later claims are `catch-up`. Generously above the sync tick's
 * 30s cadence and any single evaluation's runtime, comfortably below the
 * "app was down overnight" scale the catch-up label exists to name.
 */
export const Z500_SCHEDULED_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * A `running` run older than this is presumed dead and may be TAKEN OVER for
 * read-only reconciliation (never a rerun — see repo.ts). A healthy
 * evaluation completes in seconds; thirty minutes cannot race one.
 */
export const Z500_STALE_RUNNING_TAKEOVER_MS = 30 * 60 * 1000;

/** The creator note every workflow mutation stamps on the new version. */
export const Z500_CREATOR_NOTE =
  "Automated Z500 sync: top 10 Indexify-tradable tokens from the Ansem Z500 Curated universe, ranked by market cap, equal-weighted.";
