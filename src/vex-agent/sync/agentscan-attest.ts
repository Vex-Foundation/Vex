/**
 * AgentScan token-ATTESTATION sweep — delivers the SAME creator signature
 * already stored for the trench.express VEX badge (`attest_signature`,
 * migration 071) to the AgentScan attestation registry, over its own keyless
 * POST. Cloned architecture from `launch-attribution.ts` — the trench sweep
 * is the template; the direct trench.express attribution lane stays
 * untouched and this is a second, independent consumer of the same proof.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * NOT THE PRIMARY PATH for anything. There is no inline post-launch call for
 * AgentScan (unlike trench attribution's handler-side POST) — every delivery
 * to AgentScan goes through this periodic sweep.
 *
 * NEVER SIGNS. The signature is produced ONCE, at launch time, by the launch
 * handler; nothing after it holds a signer. A row with no stored
 * `attest_signature` is therefore never a candidate here either — the same
 * named gap `launch-attribution.ts` documents, already counted by that
 * sweep, so it is not re-counted here.
 *
 * SAFE TO RE-RUN. The AgentScan endpoint is keyless and the claim stamps its
 * own backoff BEFORE the POST, so a crash mid-request just retries after the
 * retry window — nothing hot-loops.
 *
 * DARK BY DEFAULT. Gated on `services.agentscanApiUrl` exactly like the
 * AgentScan reporting lane (`agentscan-report.ts`, whose resolver this module
 * imports rather than duplicates): an unconfigured URL is a full no-op, no
 * claim and no HTTP.
 *
 * `invalid` outcomes are NOT marked attested — they are left to the
 * attempted-at backoff to pace retries, deliberately: a permanent 400 refusal
 * (bad signature, unsupported chain) will never turn into a 200 by itself,
 * but the schema does not distinguish "will never succeed" from "might
 * succeed later", so the row simply waits out the same window a transient
 * failure would. `retryable` outcomes are handled identically for the same
 * reason — the fixed retry window is the whole backoff policy here; a
 * server's own `Retry-After` is not separately honored (there is nowhere
 * cheaper to store a per-row override than the single attempted-at stamp the
 * claim already writes).
 *
 * NEVER TOUCHES MONEY. An attestation is a registry entry: no funds, no
 * approval, no on-chain action. A failure is logged and retried, and it can
 * never fail a launch.
 *
 * ── The state machine, and why ACCEPTED is not VERIFIED ────────────────────
 *
 * `signed` (the creator signed at launch time) -> `submitted` (the POST returned
 * 2xx and the server queued the claim) -> `verified` | `mismatch` |
 * `unverifiable` | `revoked` (the server's verify job read the receipt and
 * judged the creation proof). The lane runs BOTH arrows: the submission sweep
 * below, then `sweepVerdicts`, which reads the verdict back from the public
 * token route. Treating a 2xx as verification asserts a proof nobody checked -
 * that was the D4 defect this half of the lane exists to close.
 *
 * ── Scoped by LAUNCHPAD, never by chain ───────────────────────────────────
 *
 * The candidate set used to be pinned to chain 4663 because one venue existed on
 * one chain. The AgentScan attestation registry covers 4663 AND Base 8453, so
 * the launchpad is the selector now and every row reports its own chain.
 * `db/repos/launched-tokens.ts` (`AGENTSCAN_ATTEST_SOURCES`) owns which
 * launchpads qualify, and the answer is "those with a signature over AgentScan's
 * canonical message" - today only Trench Express. pools.fun and Virtuals sign a
 * DIFFERENT message for their own badges, so each needs its own third signature
 * from the handler that still holds the signer before it can appear here.
 */

import {
  claimAgentscanAttestCandidates,
  claimAgentscanVerifyCandidates,
  markAgentscanAttested,
  recordAgentscanVerifyStatus,
  type AgentscanAttestCandidate,
  type AgentscanAttestWireLaunchpad,
  type AgentscanVerifyCandidate,
} from "@vex-agent/db/repos/launched-tokens.js";
import type {
  AttestOutcome,
  AttestVerdictOutcome,
} from "../agentscan/attest-client.js";
import { loadConfig } from "../../config/store.js";
import { resolveAgentscanBaseUrl } from "./agentscan-report.js";
import logger from "@utils/logger.js";

/** Bounded batch per run, mirroring `LAUNCH_ATTRIBUTION_BATCH_LIMIT`. */
export const AGENTSCAN_ATTEST_BATCH_LIMIT = 25;

/** How long a just-attempted row stays out of the candidate set — politeness cadence, like the trench sweep's. */
export const AGENTSCAN_ATTEST_RETRY_SECONDS = 600;

/**
 * How long a just-checked SUBMITTED row waits before its verdict is asked for
 * again. Longer than the submission cadence on purpose: the server's verify job
 * runs on its own backoff schedule and a token needs confirmations before it can
 * be judged at all, so a faster poll would only add requests to an answer that
 * has not changed.
 */
export const AGENTSCAN_VERIFY_RETRY_SECONDS = 1_800;

export interface AgentscanAttestDeps {
  /**
   * The ONLY dependency: one POST that claims the AgentScan attestation for a
   * token whose creator signature is already stored. Never throws for an
   * expected failure (see `agentscan/attest-client.ts`); a throw is still
   * contained here, because one bad row must not abort the batch or the
   * shared sync worker.
   */
  readonly attest: (input: {
    chainId: number;
    launchpad: AgentscanAttestWireLaunchpad;
    tokenAddress: string;
    attestSignature: string;
    txHash: string;
  }) => Promise<AttestOutcome>;
  /**
   * Read one submitted attestation's verdict back from the server's public token
   * route. Separate from `attest` because it is a separate authority: the POST
   * says only that the claim was accepted into the verify queue, and this is the
   * only place the server states whether the creation proof actually held.
   */
  readonly readVerdict: (input: {
    chainId: number;
    tokenAddress: string;
  }) => Promise<AttestVerdictOutcome>;
}

export interface AgentscanAttestResult {
  /** `true` when the URL is unconfigured — a full no-op, nothing else below was touched. */
  readonly skipped: boolean;
  readonly checked: number;
  /** Rows AgentScan confirmed on THIS run. */
  readonly attested: number;
  /** Definitive AgentScan refusals — read the request and said no (permanent for the row). */
  readonly invalid: number;
  /** 429/5xx/network — ambiguous or transient; the row waits out its attempt stamp. */
  readonly retryable: number;
  /** Submitted rows whose verdict was asked for on THIS run. */
  readonly verdictsChecked: number;
  /** Rows the server settled on this run: verified, mismatch, unverifiable or revoked. */
  readonly verdictsSettled: number;
}

const SKIPPED: AgentscanAttestResult = {
  skipped: true,
  checked: 0,
  attested: 0,
  invalid: 0,
  retryable: 0,
  verdictsChecked: 0,
  verdictsSettled: 0,
};

export async function runAgentscanAttest(deps: AgentscanAttestDeps): Promise<AgentscanAttestResult> {
  const baseUrl = resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl);
  if (baseUrl === null) return SKIPPED;

  const candidates = await claimAgentscanAttestCandidates({
    limit: AGENTSCAN_ATTEST_BATCH_LIMIT,
    retryAfterSeconds: AGENTSCAN_ATTEST_RETRY_SECONDS,
  });

  if (candidates.length === AGENTSCAN_ATTEST_BATCH_LIMIT) {
    // The batch was FULL, so there may be more waiting. Said at `info`: it is
    // a backlog observation, not an incident.
    logger.info("agentscan.attest.batch_full", { limit: AGENTSCAN_ATTEST_BATCH_LIMIT });
  }

  let attested = 0;
  let invalid = 0;
  let retryable = 0;

  for (const candidate of candidates) {
    const outcome = await attestOne(deps, candidate);
    if (outcome.kind === "accepted") {
      const landed = await markAgentscanAttested(candidate.id, outcome.verifyStatus);
      if (landed) attested++;
      else logger.info("agentscan.attest.duplicate_cas_miss", { id: candidate.id });
      continue;
    }
    if (outcome.kind === "invalid") {
      invalid++;
      // AgentScan's OWN words, sanitized at the client boundary — the same
      // discipline the trench attribution sweep applies (owner decree
      // 2026-08-02): a generic "attestation failed" would make a bad
      // signature indistinguishable from a network blip.
      logger.warn("agentscan.attest.invalid", { id: candidate.id, detail: outcome.detail });
      continue;
    }
    retryable++;
    logger.warn("agentscan.attest.retryable", {
      id: candidate.id,
      status: outcome.status,
      detail: outcome.detail,
    });
  }

  const verdicts = await sweepVerdicts(deps);

  return {
    skipped: false,
    checked: candidates.length,
    attested,
    invalid,
    retryable,
    ...verdicts,
  };
}

/**
 * THE SECOND HALF OF THE LANE: acceptance is not verification.
 *
 * A 2xx on the POST means the server queued the claim. Whether the creation
 * proof holds is decided later by its verify job and published on the public
 * token route, so the local state machine is `signed -> submitted ->
 * verified | mismatch | unverifiable | revoked` and this sweep is what moves the
 * last arrow. Before it existed, `agentscan_attested_at` was read as "verified",
 * which is a claim about a proof nobody had checked.
 *
 * Runs in the SAME tick as the submission sweep and after it, so a row submitted
 * a moment ago is already in the candidate set with a NULL verdict; it costs one
 * GET per row per half hour, bounded by the same batch limit.
 */
async function sweepVerdicts(
  deps: AgentscanAttestDeps,
): Promise<{ verdictsChecked: number; verdictsSettled: number }> {
  const candidates = await claimAgentscanVerifyCandidates({
    limit: AGENTSCAN_ATTEST_BATCH_LIMIT,
    retryAfterSeconds: AGENTSCAN_VERIFY_RETRY_SECONDS,
  });
  let settled = 0;
  for (const candidate of candidates) {
    const outcome = await readVerdictOne(deps, candidate);
    if (outcome.kind === "verdict") {
      const stored = await recordAgentscanVerifyStatus({ id: candidate.id, status: outcome.status });
      // `unverified` is a real answer and is stored, but it settles nothing:
      // the row stays in the candidate set until the server judges it.
      if (stored && outcome.status !== "unverified") settled++;
      continue;
    }
    if (outcome.kind === "absent") {
      // The server holds no candidate for this token yet. Not an error and not a
      // verdict; the row keeps its stamp and asks again next window.
      continue;
    }
    if (outcome.kind === "invalid") {
      logger.warn("agentscan.attest.verdict_invalid", { id: candidate.id, detail: outcome.detail });
      continue;
    }
    logger.warn("agentscan.attest.verdict_retryable", {
      id: candidate.id,
      status: outcome.status,
      detail: outcome.detail,
    });
  }
  return { verdictsChecked: candidates.length, verdictsSettled: settled };
}

/** A throw from the dependency is contained exactly as `attestOne` contains its own. */
async function readVerdictOne(
  deps: AgentscanAttestDeps,
  candidate: AgentscanVerifyCandidate,
): Promise<AttestVerdictOutcome> {
  try {
    return await deps.readVerdict({
      chainId: candidate.chainId,
      tokenAddress: candidate.tokenAddress,
    });
  } catch (err) {
    return {
      kind: "retryable",
      status: null,
      retryAfterSeconds: null,
      detail: err instanceof Error ? err.name : "unknown error",
    };
  }
}

/** A throw from the dependency is folded into `retryable` and contained: one bad row never aborts the batch. */
async function attestOne(
  deps: AgentscanAttestDeps,
  candidate: AgentscanAttestCandidate,
): Promise<AttestOutcome> {
  try {
    return await deps.attest({
      chainId: candidate.chainId,
      launchpad: candidate.launchpad,
      tokenAddress: candidate.tokenAddress,
      attestSignature: candidate.attestSignature,
      txHash: candidate.createTxHash,
    });
  } catch (err) {
    return {
      kind: "retryable",
      status: null,
      retryAfterSeconds: null,
      detail: err instanceof Error ? err.name : "unknown error",
    };
  }
}

/** The production wiring: one keyless POST per candidate, no signer anywhere. */
export function buildProductionAgentscanAttestDeps(): AgentscanAttestDeps {
  return {
    attest: async (input) => {
      const baseUrl = resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl);
      if (baseUrl === null) {
        // The lane's own gate already refuses to claim when disabled; a null
        // resolution here means the config flipped mid-sweep. Reported as
        // retryable so the row simply waits out its attempt stamp rather than
        // being marked as a permanent refusal it never received.
        return {
          kind: "retryable",
          status: null,
          retryAfterSeconds: null,
          detail: "agentscan disabled mid-sweep",
        };
      }
      const { postTokenAttestation } = await import("../agentscan/attest-client.js");
      return postTokenAttestation(baseUrl, input);
    },
    readVerdict: async (input) => {
      const baseUrl = resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl);
      if (baseUrl === null) {
        return {
          kind: "retryable",
          status: null,
          retryAfterSeconds: null,
          detail: "agentscan disabled mid-sweep",
        };
      }
      const { fetchTokenAttestationVerdict } = await import("../agentscan/attest-client.js");
      return fetchTokenAttestationVerdict(baseUrl, input);
    },
  };
}
