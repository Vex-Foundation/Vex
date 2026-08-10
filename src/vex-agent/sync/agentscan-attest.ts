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
 */

import {
  claimAgentscanAttestCandidates,
  markAgentscanAttested,
  type AgentscanAttestCandidate,
} from "@vex-agent/db/repos/launched-tokens.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import type { AttestOutcome } from "../agentscan/attest-client.js";
import { loadConfig } from "../../config/store.js";
import { resolveAgentscanBaseUrl } from "./agentscan-report.js";
import logger from "@utils/logger.js";

/** Bounded batch per run, mirroring `LAUNCH_ATTRIBUTION_BATCH_LIMIT`. */
export const AGENTSCAN_ATTEST_BATCH_LIMIT = 25;

/** How long a just-attempted row stays out of the candidate set — politeness cadence, like the trench sweep's. */
export const AGENTSCAN_ATTEST_RETRY_SECONDS = 600;

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
    tokenAddress: string;
    attestSignature: string;
    txHash: string;
  }) => Promise<AttestOutcome>;
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
}

const SKIPPED: AgentscanAttestResult = { skipped: true, checked: 0, attested: 0, invalid: 0, retryable: 0 };

export async function runAgentscanAttest(deps: AgentscanAttestDeps): Promise<AgentscanAttestResult> {
  const baseUrl = resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl);
  if (baseUrl === null) return SKIPPED;

  const candidates = await claimAgentscanAttestCandidates({
    chainId: TRENCH_CHAIN_ID,
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
      const landed = await markAgentscanAttested(candidate.id);
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

  return { skipped: false, checked: candidates.length, attested, invalid, retryable };
}

/** A throw from the dependency is folded into `retryable` and contained: one bad row never aborts the batch. */
async function attestOne(
  deps: AgentscanAttestDeps,
  candidate: AgentscanAttestCandidate,
): Promise<AttestOutcome> {
  try {
    return await deps.attest({
      chainId: candidate.chainId,
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
  };
}
