/**
 * pools.fun launch ATTRIBUTION sweep - the retry lane for the VEX badge.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * NOT THE PRIMARY PATH. The launch handler POSTs the attestation itself the
 * moment the launch confirms (`protocols/pools/handlers/launch/execute/
 * attribute.ts`); that is where a healthy launch gets its badge. This sweep
 * exists for the window the handler cannot cover: the app was closed, the
 * network was down, or the partner answered 429/5xx.
 *
 * NEVER SIGNS, exactly like `launch-attribution.ts` and for the same reason.
 * The signature is produced ONCE, at launch time, while the launch's own
 * signing clients are open - the token address does not exist before the
 * receipt, and no sweep in this repo holds a signer. So a row with no stored
 * signature is not a candidate here: it is a NAMED GAP, counted and logged once
 * per pass. Retrying it would be a loop that can only fail, and hiding it would
 * be worse.
 *
 * TERMINAL MEANS TERMINAL. A refusal from the closed vocabulary in
 * `@tools/pools-fun/attribution-codes.ts` is recorded with
 * `markPoolsAttributionRejected` and the row leaves this lane permanently.
 * Every other non-success outcome simply leaves `attributed_at` NULL, and the
 * claim's retry window brings the row back on a later cadence. Those are the
 * only two dispositions - nothing here deletes, rewrites, or gives up quietly.
 *
 * DARK UNTIL CONFIGURED. `baseUrl()` returning null means no partner endpoint
 * is configured (or the configured one is malformed or insecure), and the sweep
 * claims NO ROWS at all. Claiming first and discovering the lane is off second
 * would stamp every candidate's retry window for nothing, pushing real
 * candidates behind a wall of no-op attempts.
 *
 * NEVER TOUCHES MONEY. Attestation is a badge on a public launchpad: no funds,
 * no approval, no on-chain action. A failure is logged and retried, and it can
 * never fail a launch.
 */

import {
  claimPoolsAttributionCandidates,
  countPoolsUnsignedAttributionGap,
  markPoolsAttributed,
  markPoolsAttributionRejected,
} from "@vex-agent/db/repos/launched-tokens.js";
import { POOLS_ATTEST_LANE_MISCONFIG_CODE } from "@tools/pools-fun/attribution-codes.js";
import type { PoolsAttributionOutcome } from "@tools/pools-fun/attribution.js";
import logger from "@utils/logger.js";

/**
 * Bounded batch per run, mirroring the trench attribution lane: the sweep does
 * serial HTTP inside the shared sync worker, and an unbounded backlog would
 * starve the balance and activity sync sharing the same drain. The remainder is
 * picked up next tick.
 */
export const POOLS_ATTRIBUTION_BATCH_LIMIT = 25;

/**
 * How long a just-attempted row stays out of the candidate set. Attestation is
 * cosmetic and the endpoint is idempotent, so the cadence is set by politeness
 * to the partner rather than by user-visible urgency.
 */
export const POOLS_ATTRIBUTION_RETRY_SECONDS = 600;

export interface PoolsAttributionDeps {
  /**
   * The configured partner base URL, already validated, or `null` when the lane
   * is off. Resolved BEFORE any row is claimed.
   */
  readonly baseUrl: () => string | null;
  /**
   * One POST that claims the badge for a token whose launcher signature we
   * already hold. It never throws for an expected failure (see
   * `@tools/pools-fun/attribution.ts`); a throw is still contained here,
   * because one bad row must not abort the batch or the shared worker.
   */
  readonly attribute: (input: {
    tokenAddress: string;
    attestSignature: string;
    txHash: string;
  }) => Promise<PoolsAttributionOutcome>;
}

export interface PoolsAttributionResult {
  readonly checked: number;
  /** Rows the partner confirmed on THIS run. */
  readonly attributed: number;
  /** Definitive refusals from the closed vocabulary. These leave the lane forever. */
  readonly rejected: number;
  /** The partner answered but settled nothing - 429, 5xx, or an unreadable answer. */
  readonly retryable: number;
  /** Ambiguous: we never learned whether the request arrived. */
  readonly transportFailed: number;
  /** Unattributed rows with NO stored signature. Never retryable by this sweep. */
  readonly unsignedGap: number;
  /** True when no endpoint is configured, so nothing was claimed. */
  readonly skipped: boolean;
}

function emptyResult(skipped: boolean): PoolsAttributionResult {
  return {
    checked: 0,
    attributed: 0,
    rejected: 0,
    retryable: 0,
    transportFailed: 0,
    unsignedGap: 0,
    skipped,
  };
}

export async function attributePoolsLaunches(
  deps: PoolsAttributionDeps,
): Promise<PoolsAttributionResult> {
  if (deps.baseUrl() === null) return emptyResult(true);

  const candidates = await claimPoolsAttributionCandidates({
    limit: POOLS_ATTRIBUTION_BATCH_LIMIT,
    retryWindowSeconds: POOLS_ATTRIBUTION_RETRY_SECONDS,
  });

  if (candidates.length === POOLS_ATTRIBUTION_BATCH_LIMIT) {
    // The batch was FULL, so there may be more waiting. Said at `info`: it is a
    // backlog observation, not an incident.
    logger.info("pools.attribution.batch_full", { limit: POOLS_ATTRIBUTION_BATCH_LIMIT });
  }

  let attributed = 0;
  let rejected = 0;
  let retryable = 0;
  let transportFailed = 0;

  for (const candidate of candidates) {
    // PER-ROW CONTAINMENT: everything a single candidate can do - including a
    // repository write failing - stays inside this iteration.
    try {
      const outcome = await attributeOne(deps, candidate);

      if (outcome.kind === "attributed") {
        const landed = await markPoolsAttributed({ id: candidate.id });
        if (landed) attributed++;
        else logger.info("pools.attribution.duplicate_cas_miss", { id: candidate.id });
        continue;
      }

      if (outcome.kind === "rejected") {
        rejected++;
        const landed = await markPoolsAttributionRejected({
          id: candidate.id,
          code: outcome.code,
        });
        // The validated CODE and the HTTP status, and nothing else. The
        // partner's free text is never consumed or retained (rule 09): an
        // untrusted string must not be what an operator reads as the cause.
        logger.warn("pools.attribution.rejected", {
          id: candidate.id,
          status: outcome.status,
          code: outcome.code,
          recorded: landed,
        });
        continue;
      }

      if (outcome.kind === "retryable") {
        retryable++;
        if (outcome.code === POOLS_ATTEST_LANE_MISCONFIG_CODE) {
          // The LANE is misconfigured, not this row - every candidate in this
          // batch will get the same answer. Loud, because a lane that retries
          // forever with only info-level breadcrumbs is a lane nobody fixes.
          logger.warn("pools.attribution.lane_misconfig", {
            id: candidate.id,
            status: outcome.status,
            code: outcome.code,
          });
          continue;
        }
        logger.info("pools.attribution.retryable", {
          id: candidate.id,
          status: outcome.status,
          code: outcome.code,
        });
        continue;
      }

      transportFailed++;
      logger.warn("pools.attribution.transport_failed", {
        id: candidate.id,
        detail: outcome.detail,
      });
    } catch (err) {
      // A repository write threw. The row keeps `attributed_at` NULL and comes
      // back after the retry window; counted as retryable so the run's totals
      // still add up to what was checked.
      retryable++;
      logger.warn("pools.attribution.row_failed", {
        id: candidate.id,
        error: err instanceof Error ? err.name : "unknown error",
      });
    }
  }

  const unsignedGap = await countPoolsUnsignedAttributionGap();
  if (unsignedGap > 0) {
    // ONCE per pass, and named for what it is. These tokens launched while the
    // lane was disabled, or their signature could not be produced; nothing
    // after the handler holds a signer, so no sweep will ever attribute them.
    logger.info("pools.attribution.unsigned_gap", {
      count: unsignedGap,
      hint: "these pools.fun launches have no stored launcher signature, so the badge cannot be claimed "
        + "for them; only the launch handler can sign, and it no longer holds their signing clients.",
    });
  }

  return {
    checked: candidates.length,
    attributed,
    rejected,
    retryable,
    transportFailed,
    unsignedGap,
    skipped: false,
  };
}

/** A throw from the HTTP dependency is contained: one bad row never aborts the batch. */
async function attributeOne(
  deps: PoolsAttributionDeps,
  candidate: { tokenAddress: string; attestSignature: string; createTxHash: string },
): Promise<PoolsAttributionOutcome> {
  try {
    return await deps.attribute({
      tokenAddress: candidate.tokenAddress,
      attestSignature: candidate.attestSignature,
      txHash: candidate.createTxHash,
    });
  } catch (err) {
    return {
      kind: "transport_failed",
      detail: err instanceof Error ? err.name : "unknown error",
    };
  }
}
