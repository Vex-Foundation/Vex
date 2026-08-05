/**
 * Trench launch ATTRIBUTION sweep — the retry lane for the VEX badge.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * NOT THE PRIMARY PATH. The launch handler POSTs the attribution itself the
 * moment the create confirms (`launch/execute/attribute.ts`); that is where a
 * healthy launch gets its badge. This sweep exists for the window the handler
 * cannot cover: the app was closed, the network was down, or the launchpad
 * answered with a refusal or a 5xx.
 *
 * NEVER SIGNS, exactly like `launch-identity-repair.ts` and for the same
 * reason. The signature is produced ONCE, at launch time, while the launch's
 * own signing clients are open — the token address does not exist before the
 * receipt, and no sweep in this repo holds a signer. So a row with no stored
 * signature is not a candidate here: it is a NAMED GAP, counted and logged once
 * per pass. Retrying it would be a loop that can only fail, and hiding it would
 * be worse.
 *
 * SAFE TO RE-RUN. The upstream endpoint is idempotent (a repeat attribution, or
 * a backfill days later, is a no-op), `markAttributed` is a CAS on
 * `attributed_at IS NULL`, and the claim stamps every row it serves so a
 * permanently-refused row moves to the back of the queue instead of pinning the
 * window shut.
 *
 * NEVER TOUCHES MONEY. Attribution is a badge on a public launchpad: no funds,
 * no approval, no on-chain action. A failure is logged and retried, and it can
 * never fail a launch.
 */

import {
  claimAttributionCandidates,
  countUnsignedAttributionGap,
  markAttributed,
} from "@vex-agent/db/repos/launched-tokens.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import type { AttributionOutcome } from "@tools/trench-express/attribution.js";
import logger from "@utils/logger.js";

/**
 * Bounded batch per run, mirroring `LAUNCH_REPAIR_BATCH_LIMIT`: the sweep does
 * serial HTTP inside the shared sync worker, and an unbounded backlog would
 * starve the balance and activity sync sharing the same drain. The remainder is
 * picked up next tick.
 */
export const LAUNCH_ATTRIBUTION_BATCH_LIMIT = 25;

/**
 * How long a just-attempted row stays out of the candidate set. Attribution is
 * cosmetic and the endpoint is idempotent, so the cadence is set by politeness
 * to the provider rather than by user-visible urgency.
 */
export const LAUNCH_ATTRIBUTION_RETRY_SECONDS = 600;

export interface LaunchAttributionDeps {
  /**
   * The ONLY dependency: one POST that claims the badge for a token whose
   * creator signature we already hold. It never throws for an expected failure
   * (see `tools/trench-express/attribution.ts`); a throw is still contained
   * here, because one bad row must not abort the batch or the shared worker.
   */
  readonly attribute: (input: {
    tokenAddress: string;
    attestSignature: string;
  }) => Promise<AttributionOutcome>;
}

export interface LaunchAttributionResult {
  readonly checked: number;
  /** Rows the launchpad confirmed on THIS run. */
  readonly attributed: number;
  /** Definitive provider refusals — read the request and said no. */
  readonly rejected: number;
  /** Ambiguous: we never learned whether the request arrived. */
  readonly transportFailed: number;
  /** Unattributed rows with NO stored signature. Never retryable by this sweep. */
  readonly unsignedGap: number;
}

export async function attributeLaunchedTokens(
  deps: LaunchAttributionDeps,
): Promise<LaunchAttributionResult> {
  const candidates = await claimAttributionCandidates({
    chainId: TRENCH_CHAIN_ID,
    limit: LAUNCH_ATTRIBUTION_BATCH_LIMIT,
    retryAfterSeconds: LAUNCH_ATTRIBUTION_RETRY_SECONDS,
  });

  if (candidates.length === LAUNCH_ATTRIBUTION_BATCH_LIMIT) {
    // The batch was FULL, so there may be more waiting. Said at `info`: it is a
    // backlog observation, not an incident.
    logger.info("trench.launch_attribution.batch_full", {
      limit: LAUNCH_ATTRIBUTION_BATCH_LIMIT,
    });
  }

  let attributed = 0;
  let rejected = 0;
  let transportFailed = 0;

  for (const candidate of candidates) {
    const outcome = await attributeOne(deps, candidate.tokenAddress, candidate.attestSignature);
    if (outcome.kind === "attributed") {
      const landed = await markAttributed(candidate.id);
      if (landed) attributed++;
      else logger.info("trench.launch_attribution.duplicate_cas_miss", { id: candidate.id });
      continue;
    }
    if (outcome.kind === "rejected") {
      rejected++;
      // The provider's OWN words, sanitized at the client boundary. A generic
      // "attribution failed" here is what makes a diagnosable refusal — a
      // signature from the wrong wallet, say — indistinguishable from a network
      // blip for as long as anyone cares to look (owner decree 2026-08-02).
      logger.warn("trench.launch_attribution.rejected", {
        id: candidate.id,
        status: outcome.status,
        detail: outcome.detail,
      });
      continue;
    }
    transportFailed++;
    logger.warn("trench.launch_attribution.transport_failed", {
      id: candidate.id,
      detail: outcome.detail,
    });
  }

  const unsignedGap = await countUnsignedAttributionGap(TRENCH_CHAIN_ID);
  if (unsignedGap > 0) {
    // ONCE per pass, and named for what it is. These tokens launched before the
    // signing step existed, or the signature could not be produced; nothing
    // after the handler holds a signer, so no sweep will ever attribute them.
    logger.info("trench.launch_attribution.unsigned_gap", {
      count: unsignedGap,
      hint: "these launched tokens have no stored creator signature, so the badge cannot be claimed "
        + "for them; only the launch handler can sign, and it no longer holds their signing clients.",
    });
  }

  return { checked: candidates.length, attributed, rejected, transportFailed, unsignedGap };
}

/** A throw from the dependency is contained: one bad row never aborts the batch. */
async function attributeOne(
  deps: LaunchAttributionDeps,
  tokenAddress: string,
  attestSignature: string,
): Promise<AttributionOutcome> {
  try {
    return await deps.attribute({ tokenAddress, attestSignature });
  } catch (err) {
    return {
      kind: "transport_failed",
      detail: err instanceof Error ? err.name : "unknown error",
    };
  }
}

/** The production wiring: one keyless POST per candidate, no signer anywhere. */
export function buildProductionLaunchAttributionDeps(): LaunchAttributionDeps {
  return {
    attribute: async (input) => {
      const { attributeLaunchedToken } = await import("@tools/trench-express/attribution.js");
      return attributeLaunchedToken(input);
    },
  };
}
