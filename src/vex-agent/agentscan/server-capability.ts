/**
 * WHAT THE DEPLOYED AgentScan SERVER ACCEPTS, as opposed to what this build can
 * write.
 *
 * ## The defect this module owns
 *
 * `db/repos/agentscan-reporting.ts` carries a gate that reads like a statement
 * about the server and is entirely a statement about this database: it compares
 * `vocabulary_version` and `backfill_vocabulary_version`, both local, and
 * nothing in the lane had ever asked the deployment what it accepts. So a row
 * carrying a role this build knows and the deployed contract does not was sent,
 * came back in `rejectedIndexes` as `validation_failed`, and `markOutboxRejected`
 * made that PERMANENT. The activity was then never reported at all, not even
 * after the server deployed, because a rejected outbox row is terminal and is
 * never retried. (Codex final review 2026-09-06, lane 7.)
 *
 * ## Why the ingest response IS the probe
 *
 * Measured against the live deployment at `agentscan.projectvex.ai` on
 * 2026-09-06, read-only, before this module was written:
 *
 *   - `GET /healthz` answers `{"db":"ok","workerAgeSec":...}` and carries no
 *     version, contract identifier or vocabulary;
 *   - the server's route set is byte-identical between the deployed contract and
 *     the one this build targets (both expose exactly `/healthz`,
 *     `/api/{activity,agents/:name,lookup,protocols,stats,tx/:publicId,verification}`,
 *     `/v1/agents/{register,revoke,session/start,session/complete}`,
 *     `/v1/events`, `/v1/tokens/attest`), so no endpoint appears or disappears
 *     with a contract version;
 *   - the one public read that reflects a server vocabulary is the activity
 *     feed's `kind` filter: an unknown kind is silently dropped rather than
 *     refused (`?kind=transfer` returned the same unfiltered page as
 *     `?kind=bogus_kind_probe`, while `?kind=lend` filtered and `?kind=claim`
 *     returned an empty page), which does identify the deployment as the old
 *     contract but speaks for EVENT_KINDS only. The roles below arrive in a
 *     different server PR than the `transfer` kind does, so that signal would
 *     answer for the wrong deployment step.
 *
 * There is therefore no capability endpoint to ask. The only authority on "does
 * this server accept this role" is the ingest response itself, so the probe is
 * ONE send and its answer is cached here with an expiry.
 *
 * ## The posture, and where it comes from
 *
 * `agents-colab/metamask-core/packages/transaction-controller/src/helpers/PendingTransactionTracker.ts`:
 * a LOOKUP FAILURE IS NEVER A VERDICT. A receipt the tracker could not read
 * produces `#warnTransaction` - a visible reason attached to the record - and
 * the transaction stays pending; only a definitive on-chain signal
 * (`#failTransaction`, `#dropTransaction`) is terminal. Adopted in shape: a
 * refusal of a role the deployment does not carry yet is not a verdict about the
 * row. The row stays OWED with the reason visible in `agentscan_outbox.last_error`,
 * the role is withheld so the lane stops spending sends on it, and when the
 * deployment advances the row goes out once.
 *
 * A refused item costs the lane's minute budget and a batch slot, and nothing
 * else: the server's strikes are recorded by its VERIFY worker against activities
 * it has already accepted (`apps/server/src/repos/activities-verify-repo.ts`
 * `recordStrike`), so an item the ingest schema refused never becomes an activity
 * and never accrues one. Withholding is therefore about not wasting the budget
 * and not re-asking a question that was already answered, not about avoiding
 * quarantine.
 *
 * ## Ownership and lifetime
 *
 * PROCESS-LIFETIME, deliberately. The record is a cache of a remote fact, not
 * durable state: nothing here is a decision this install must remember across
 * restarts, and persisting it would create a second source of truth about a
 * server we can simply ask again. The cost of losing it is one extra send per
 * role per process start, which is also the repair when a deployment lands while
 * Vex is running. `resetAgentscanServerCapability` is the test seam and the only
 * way to clear it wholesale.
 */

/**
 * The roles this build can emit whose SERVER-SIDE deployment it must not assume.
 *
 * Exactly the five migration 107 minted, and the same five
 * `agents-colab/agents_dm/verify/agentscan-contract-acceptance.ts` pins as
 * refused by the deployed contract and accepted by vex-agentscan #78. They are
 * the whole gap: `pools_fee` and `pools_claim` are deliberately ABSENT because
 * the deployed contract has carried both since its own migration 0015 - they are
 * new to our eligibility predicate, not to the server - and treating them as
 * provisional would withhold rows the server would have taken.
 *
 * A rejection of anything NOT in this set is a client bug and stays terminal:
 * the server has carried those roles for as long as it has existed, so retrying
 * an identical payload could only refail.
 *
 * This set shrinks to nothing once #78 is deployed everywhere, at which point
 * withholding never triggers and the whole module is inert. It is not deleted
 * then: the next vocabulary widening is the next entry.
 */
export const AGENTSCAN_PROVISIONAL_ROLES: ReadonlySet<string> = new Set([
  "creator_fee_claim",
  "holder_reward_claim",
  "reward_distribution",
  "launch_cancel",
  "vex_fee",
]);

/**
 * How long a refused role stays withheld before the lane spends one more send
 * finding out whether the deployment has advanced.
 *
 * Six hours is chosen against the two costs it sits between. Too short and every
 * withheld role burns the lane's minute budget re-asking a deployment that has
 * not moved; too long and a real deployment goes unnoticed for a day. A held row's own `next_attempt_at` is pushed to exactly this
 * window, so a withheld role costs at most one claim and one send per row per
 * six hours, and the deployment is noticed within six hours of landing.
 */
export const AGENTSCAN_ROLE_RECHECK_MS = 6 * 60 * 60 * 1000;

/** Wall-clock ms after which each withheld role is probed again. */
const withheldUntilMs = new Map<string, number>();

/**
 * Roles this deployment has been OBSERVED to accept, and the reason the record
 * keeps them.
 *
 * A provisional role has two ways to be refused, and they are indistinguishable
 * in the response: the deployment does not carry it, or our payload is wrong.
 * Before anything of that role has ever been accepted, "not deployed" is the
 * safe reading - holding a row that the server would have taken costs a delay,
 * while rejecting one terminally loses the activity for good. AFTER the
 * deployment has taken a row of that role, that reading is no longer available:
 * the vocabulary is demonstrably there, so a refusal is about the payload and
 * must stay terminal, or a malformed row would cycle through the recheck window
 * forever instead of being reported as the client bug it is.
 */
const observedAcceptedRoles = new Set<string>();

/**
 * Read a per-item ingest refusal as a statement about the DEPLOYMENT rather than
 * about the row, and withhold the role until the recheck window lapses.
 *
 * Returns whether the refusal was read that way. `false` means the role has been
 * in the server's vocabulary all along, so the refusal is about the payload and
 * the caller must treat it as terminal exactly as before.
 */
export function noteRoleRefusedByServer(eventRole: string, nowMs: number): boolean {
  if (!AGENTSCAN_PROVISIONAL_ROLES.has(eventRole)) return false;
  if (observedAcceptedRoles.has(eventRole)) return false;
  withheldUntilMs.set(eventRole, nowMs + AGENTSCAN_ROLE_RECHECK_MS);
  return true;
}

/**
 * The deployment took a row of this role, so the withholding is over now rather
 * than when the window happens to lapse. Safe to call for any role.
 */
export function noteRoleAcceptedByServer(eventRole: string): void {
  withheldUntilMs.delete(eventRole);
  if (AGENTSCAN_PROVISIONAL_ROLES.has(eventRole)) observedAcceptedRoles.add(eventRole);
}

/** Is this role currently withheld from the wire? */
export function isRoleWithheld(eventRole: string, nowMs: number): boolean {
  const until = withheldUntilMs.get(eventRole);
  if (until === undefined) return false;
  if (nowMs >= until) {
    // The window lapsed: drop the entry so the next send is a real probe again.
    withheldUntilMs.delete(eventRole);
    return false;
  }
  return true;
}

/** The withheld roles, for the lane's structured log. Ascending, so it is stable. */
export function withheldRoles(nowMs: number): readonly string[] {
  return [...withheldUntilMs.keys()].filter((role) => isRoleWithheld(role, nowMs)).sort();
}

/** Test seam. Production has no reason to clear the whole record at once. */
export function resetAgentscanServerCapability(): void {
  withheldUntilMs.clear();
  observedAcceptedRoles.clear();
}
