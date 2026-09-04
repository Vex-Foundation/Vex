/**
 * What a FRESH reporting tick does, for the integration suites.
 *
 * The lane reads `agentHash`, `ingestToken` and `registration_generation` in one
 * `getReportingState()` and carries that generation into the incremental
 * enqueue, the claim and every terminal write. A test that wants ordinary
 * (non-stale) behavior has to do the same, so these two helpers read the state
 * and then work at the generation it returned, and THROW when the repo refuses.
 * A staleness that crept in by accident therefore fails the test loudly instead
 * of passing as an empty result.
 *
 * Tests that are ABOUT staleness pass their own held generation to the repo
 * directly - that is the point of the fence, and it must stay visible in them.
 */
import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";

type ReportingRepo = typeof import("@vex-agent/db/repos/agentscan-reporting.js");

async function reportingRepo(): Promise<ReportingRepo> {
  return import("@vex-agent/db/repos/agentscan-reporting.js");
}

/** The diff scan at the current generation; returns how many rows it enqueued. */
export async function enqueueAtCurrentGeneration(backfill: boolean): Promise<number> {
  const repo = await reportingRepo();
  const state = await repo.getReportingState();
  const outcome = await repo.enqueueEligibleActivity(backfill, state.registrationGeneration);
  if (outcome.kind !== "applied") throw new Error(`enqueue refused: ${outcome.kind}`);
  return outcome.rows;
}

/**
 * The claim at the current generation, with the generation it ran at - the
 * fence a terminal write for these rows has to carry.
 */
export async function claimTickAtCurrentGeneration(limit = 10): Promise<{
  generation: number;
  events: readonly ClaimedOutboxEvent[];
}> {
  const repo = await reportingRepo();
  const state = await repo.getReportingState();
  const claim = await repo.claimDueOutbox(limit, state.registrationGeneration);
  if (claim.kind !== "claimed") throw new Error(`claim refused: ${claim.kind}`);
  return { generation: state.registrationGeneration, events: claim.events };
}

/** The claim at the current generation; returns the claimed events. */
export async function claimAtCurrentGeneration(
  limit = 10,
): Promise<readonly ClaimedOutboxEvent[]> {
  return (await claimTickAtCurrentGeneration(limit)).events;
}
