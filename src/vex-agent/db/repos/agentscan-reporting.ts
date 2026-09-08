/**
 * AgentScan reporting repo - the state singleton + outbox behind the
 * `agentscan_report` sync lane (migration 073).
 *
 * ── The diff scan, not writer hooks ────────────────────────────────────────
 *
 * `enqueueEligibleActivity` is the ONLY producer of outbox rows. It diffs
 * `agent_activity` against the outbox's `UNIQUE (activity_id, status)` pair,
 * so it captures both brand-new rows and status transitions idempotently -
 * with ZERO code in the money-path writers. Completed outbox rows are kept
 * forever as the report-log; deleting them would let the scan re-enqueue the
 * same pair on every tick.
 *
 * ── Claim-and-stamp (crash-safe drain) ─────────────────────────────────────
 *
 * `claimDueOutbox` bumps `attempt_count` and pushes `next_attempt_at`
 * (exponential, capped 1 h) BEFORE the caller sends, exactly like the
 * launch-attribution lane: a crash mid-send retries after the backoff instead
 * of hot-looping, and the server deduplicates retried batches, so re-sending
 * is always safe. `rescheduleOutbox` overrides the stamp when the server
 * answered with its own `Retry-After`.
 *
 * ONE GENERATION PER TICK, READ WITH THE CREDENTIALS. The lane reads
 * `agentHash`, `ingestToken` and `registration_generation` in a single
 * `getReportingState()` and carries that generation into the incremental
 * enqueue, the claim and every TERMINAL write (`markOutboxSent`,
 * `markOutboxRejected`, `rescheduleOutbox`). Each of them applies only while the
 * singleton still carries it - see `writeOutboxAtGeneration` for the in-flight
 * send a 401 reset would otherwise lose, and `enqueueEligibleActivity` for the
 * insert that reset would be unable to relabel.
 *
 * ── What never goes in here ────────────────────────────────────────────────
 *
 * `last_error` carries status/code words only ("429 rate_limited"), never
 * response bodies and never the ingest token. The eligibility predicate keeps
 * rows the ingest contract cannot express (the approval roles the server's enum
 * does not contain) out of the outbox entirely.
 */

import type { PoolClient } from "pg";
import { queryOne, queryWith, execute, executeWith, queryOneWith, withTransaction } from "../client.js";

export type AgentscanStopReason = "consent_revoked" | "quarantined" | "agent_conflict" | "wallet_conflict";

export interface AgentscanReportingState {
  readonly agentHash: string | null;
  readonly ingestToken: string | null;
  readonly consentVersion: number;
  readonly acceptedAt: string | null;
  readonly registeredAt: string | null;
  readonly registerAttemptCount: number;
  readonly nextRegisterAttemptAt: string;
  readonly backfillEnqueuedAt: string | null;
  /**
   * Which reporting vocabulary this install's DATABASE carries (migration 107
   * stamps 2). It says which roles the schema can STORE, never which roles a
   * backfill has already covered - that is `backfillVocabularyVersion`.
   */
  readonly vocabularyVersion: number;
  /**
   * Which vocabulary the LAST COMPLETED controlled backfill actually scanned,
   * `null` when no backfill has ever completed on this install.
   *
   * Separate from `vocabularyVersion` because the two answer different
   * questions, and conflating them is how an older binary defeats the gate: a
   * build whose `AGENTSCAN_VOCABULARY_VERSION` is 1, running against a database
   * migration 107 has already stamped at 2, scans only the V1 roles and would
   * otherwise leave behind a completion mark that the next V2 build reads as
   * "the family history is already covered" - and every historical family row
   * then reaches the server labelled as live activity. The stamp is written by
   * the marking transaction with the version the scan itself ran under, so it
   * can only ever say what was really covered.
   */
  readonly backfillVocabularyVersion: number | null;
  /**
   * Bumped by every registration reset (`resetForReRegistration`,
   * `resetIdentityForRecovery`). The controlled backfill carries the generation
   * it started under and refuses to write its completion mark if that generation
   * has moved, so a 401 reset landing mid-backfill is never overwritten by the
   * stale mark that started before it.
   */
  readonly registrationGeneration: number;
  readonly stoppedReason: AgentscanStopReason | null;
  /** Display name AgentScan bound to this install (session/complete response). */
  readonly agentName: string | null;
  /** When the last successful wallet-binding handshake completed. */
  readonly lastHandshakeAt: string | null;
  /** session/complete's syncState.lastAcceptedRowId - null for a brand-new agent. */
  readonly serverCursorRowId: number | null;
  /** sha256 of the sorted chainFamily:address inventory list the last handshake covered. */
  readonly boundWalletsFingerprint: string | null;
}

/**
 * Which LOCAL LEDGER an outbox row reports.
 *
 * Two id spaces, never one: `agent_activity` ids and `lighter_fills` ids are
 * independent sequences, so a row names its source and carries exactly one
 * reference (migration 152's `agentscan_outbox_source_reference` CHECK). The
 * reported `sourceRowId` is namespaced for the same reason - AgentScan dedupes
 * on (agent_hash, source_row_id), and two ledgers sharing an id space would
 * collide there silently.
 */
export type AgentscanOutboxSourceKind =
  | "agent_activity"
  | "lighter_fill"
  /**
   * An UPDATE to one already-delivered fill, carrying only the exact charged
   * fees that became known after it was sent. A fill's own outbox row is
   * terminal once sent, so without this kind an exact fee proven later has no
   * row to ride and never reaches the server at all. It is never a second
   * fill: it reports the SAME `sourceRowId` and carries no economics (H0
   * H0 correction 4).
   */
  | "lighter_fill_enrichment";

export interface ClaimedOutboxEvent {
  readonly outboxId: number;
  readonly sourceKind: AgentscanOutboxSourceKind;
  /** The `agent_activity` id, or null on a `lighter_fill` row. */
  readonly activityId: number | null;
  readonly status: "pending" | "confirmed" | "definitively_failed" | "superseded_unproven";
  readonly backfill: boolean;
  /** Raw `agent_activity` row for payload building; null if the row vanished between claim and read. */
  readonly activity: Record<string, unknown> | null;
  /** The `lighter_fills` id, or null on an `agent_activity` row. */
  readonly fillId: number | null;
  /** Raw `lighter_fills` row for payload building; null if the row vanished between claim and read. */
  readonly fill: Record<string, unknown> | null;
  /** The `lighter_fills.revision` an enrichment row delivers; null on every other kind. */
  readonly enrichmentRevision: number | null;
}

/**
 * What one claim attempt did, at the generation the caller asked for.
 *
 * THE GENERATION IS AN INPUT, NOT A RESULT, and round 3 had that backwards.
 * It argued that reading the generation under the claim's own share lock is
 * exact where passing the lane's earlier read down would wrongly refuse a batch
 * whose generation had moved. That argument is wrong, because the generation
 * does not belong to the claim: it belongs to the `agentHash` and `ingestToken`
 * the lane read in the same `getReportingState()`, and a batch claimed at G+1
 * is about to be sent under G's credentials. Adopting the newer generation at
 * the claim let the whole stale tick proceed - including the UNFENCED
 * incremental enqueue that ran before it, which inserts `backfill = FALSE` rows
 * AFTER the reset that would have relabelled them, so nothing can ever relabel
 * them and this install's history reaches the server as live activity.
 *
 * A stale tick therefore refuses ONCE and stops. It does not repeat forever:
 * the next tick calls `getReportingState()` again and works at the current
 * generation with the credentials that belong to it.
 */
export type ClaimOutboxOutcome =
  | { readonly kind: "claimed"; readonly events: readonly ClaimedOutboxEvent[] }
  | { readonly kind: "stale_generation" };

/**
 * What a fenced outbox write did - the incremental enqueue as well as every
 * terminal write.
 *
 * `stale_generation` is an ORDINARY outcome, not an error: a registration reset
 * committed since the caller read the state this work was decided against, so
 * the rows in question have already been relabelled as owed history and belong
 * to a different (or abandoned) identity. The write applies to nothing and the
 * caller reports the rows as still owed.
 */
export type OutboxWriteOutcome =
  | { readonly kind: "applied"; readonly rows: number }
  | { readonly kind: "stale_generation"; readonly rows: 0 };

/**
 * WHAT IS REPORTABLE AT ALL - the single source of truth for the diff scan,
 * split by VOCABULARY VERSION because the two halves are gated differently.
 *
 * It is the contract vocabulary the server's closed enums accept, minus the
 * deliberate exclusions named below:
 *
 * `allowance` / `allowance_reset` are absent because the server's role enum does
 * not contain them, so every such event would be rejected item by item.
 * Approvals are still recorded locally; they simply have nowhere to go.
 *
 * `wrap`/`unwrap` are in the server's vocabulary and DO have a producer in this
 * install now (the `WalletWrapPrepare`/`WalletWrapConfirm` pair). They are still
 * left out, and the gate is named rather than assumed: adding `'wrap'` to the
 * kind list and the `wrap`/`unwrap` roles to the role list is blocked on a LIVE
 * confirmation that the AgentScan server's ingest accepts kind `wrap` for both
 * directions INCLUDING the pending states. A kind the server rejects costs batch
 * items, and an amount it cannot verify costs strikes, so the vocabulary is
 * proven against the running server before rows are sent, not inferred from the
 * enum it publishes.
 *
 * NOTHING IN THIS PREDICATE IS A STATEMENT ABOUT THE SERVER, and reading it as
 * one was a real defect (the final review of 2026-09-06, lane 7). Both versions it
 * compares are LOCAL: `vocabulary_version` is what this database can STORE and
 * `backfill_vocabulary_version` is what a scan on this install has COVERED.
 * Neither can say whether the deployment accepts a role, and a role the
 * deployment does not carry used to come back as a per-item `validation_failed`
 * and be marked rejected FOREVER. The capability half lives where it can be
 * measured - `../../agentscan/server-capability.ts`, on the ingest response, with
 * the row left OWED - and the two gates are independent: this one decides whether
 * a row may be enqueued at all and how it is labelled, that one decides whether
 * the deployment can take it yet.
 *
 * `pools_fee` WAS such a gap and is now closed, by the lane that owns the pools
 * launch writer (PR5). WHAT THE HISTORICAL ROWS MEAN, decided there and recorded
 * here because this predicate is what acts on it: a `pools_fee` row is THE SAME
 * FEE a `vex_fee` row on a launch is - the same 25 bps, on the same
 * `launch_msg_value` basis, to the same Vex treasury, charged by the same leg -
 * written under the venue-named spelling the vocabulary used before migration
 * 107 unified it. It is history, not a different charge, so it is admitted
 * beside `vex_fee` on the launch arm rather than left unreportable. New rows are
 * written as `vex_fee` (`@tools/pools-fun/fee/venue.ts`), so this arm stops
 * gaining members the day migration 107 landed and covers a closed population.
 *
 * `wallet_transfer` and the `transaction` kind's five roles are absent for the
 * same reason as `wrap`: present in the server's vocabulary, never proven live.
 */
const ELIGIBLE_STATUS_AND_FAMILY_SQL = `
      a.status IN ('pending','confirmed','definitively_failed','superseded_unproven')
  AND a.chain_family IN ('eip155','solana')`;

/** The vocabulary every install has always reported. Ungated. */
const ELIGIBLE_VOCABULARY_V1_SQL = `(
      a.kind IN ('swap','bridge','lend','prediction','yield','launch')
  AND a.event_role IN (
        'swap','swap_fee','trench_fee',
        'bridge_deposit','bridge_fee','bridge_fill_expected','bridge_fill_observed','bridge_refund',
        'lend_deposit','lend_withdraw','lend_borrow_operate',
        'predict_buy','predict_sell','predict_claim','predict_close',
        'yield_pt','yield_yt','yield_py','yield_lp','yield_sy','yield_claim',
        'token_launch'))`;

/**
 * The launchpad family and the venue-independent fee leg (migration 107). Every
 * arm mirrors the server's `ROLES_BY_KIND`: the claim kind carries the three new
 * claim roles beside `pools_claim`, `launch_cancel` rides the launch kind, and
 * `vex_fee` is admitted on swap, bridge and launch and nowhere else.
 *
 * `pools_claim` joins HERE rather than in V1 even though the role predates this
 * migration: no install has ever reported one, so admitting it makes historical
 * rows newly eligible, which is exactly the population the version gate exists
 * to route through the controlled backfill.
 */
const ELIGIBLE_VOCABULARY_V2_SQL = `(
      (a.kind = 'claim'
       AND a.event_role IN ('pools_claim','creator_fee_claim','holder_reward_claim','reward_distribution'))
   OR (a.kind = 'launch' AND a.event_role = 'launch_cancel')
   OR (a.kind IN ('swap','bridge','launch') AND a.event_role = 'vex_fee'))`;

/**
 * V3: the historical launch-fee rows, and WHY THEY COULD NOT JOIN V2.
 *
 * `pools_fee` is admitted for the reason recorded above - it is the same fee a
 * `vex_fee` launch row is, under the spelling the vocabulary used before
 * migration 107 unified it - but admitting it is still a WIDENING, and a
 * widening makes rows that already exist newly eligible. It was first written
 * into the V2 arm with the version left at 2, and that is precisely the shape
 * the gate cannot absorb (the final review of 2026-09-06, lane 7): the gate asks
 * `backfill_vocabulary_version >= version`, and an installation that had already
 * completed the V2 backfill satisfies it on the day it upgrades. Migration 107's
 * walk is guarded by `vocabulary_version < 2` and skips that installation
 * entirely, so the first incremental tick would sweep every historical launch
 * fee into the outbox labelled LIVE ACTIVITY - and a completed outbox row is
 * never re-sent, so nothing afterwards could correct it.
 *
 * A version is cheap and the alternative is unrepairable, so the population gets
 * its own: migration 111 walks `vocabulary_version` to 3, the V2-covered install
 * no longer satisfies the V3 gate, and the controlled backfill claims these rows
 * as the history they are. Nothing else moves: the V2 arm keeps its own literal
 * 2 below, so an install that covered V2 goes on reporting the launchpad family
 * as live activity while only the launch-fee arm waits.
 *
 * The arm covers a CLOSED population. New rows are written as `vex_fee`
 * (`@tools/pools-fun/fee/venue.ts`), so it stopped gaining members the day
 * migration 107 landed.
 */
const ELIGIBLE_VOCABULARY_V3_SQL = `(a.kind = 'launch' AND a.event_role = 'pools_fee')`;

/**
 * V4: the exchange FUNDING legs of the Lighter integration - a deposit into
 * the venue and a claimed withdrawal out of it.
 *
 * Only the funding legs. A Lighter FILL has no settlement transaction and no
 * `agent_activity` row at all; it lives in the `lighter_fills` ledger
 * (migration 152) and reaches the same outbox through
 * {@link enqueueEligibleLighterFills}. Cancels, modifies and closes are not
 * economic activity and are never reported: a close is one or more fills.
 *
 * The arm gets its own version for the reason the V3 arm did, even though no
 * install can have history under it yet: a widening is gated at the version
 * that introduced it, so the discipline holds when the population is not empty
 * on some future install.
 */
const ELIGIBLE_VOCABULARY_V4_SQL = `(
      a.kind = 'exchange'
  AND a.event_role IN ('exchange_deposit','exchange_withdrawal'))`;

/**
 * The vocabulary version this build writes and reports. Migration 111 stamps the
 * same number onto `agentscan_reporting_state.vocabulary_version`, so a build
 * running against a database that has not applied it stays at whatever that
 * database carries - it cannot report a role its own CHECK constraint would
 * refuse to store, and it cannot claim coverage of a vocabulary it never
 * scanned.
 *
 * Bumping this constant is what makes an already-completed backfill INSUFFICIENT
 * again (`sync/agentscan-report.ts` `backfillOwed`, and the `already_marked`
 * decline in `enqueueBackfillAndMark`), so every widening that adds historical
 * rows must bump it and add the matching migration in the same change.
 */
export const AGENTSCAN_VOCABULARY_VERSION = 4;

/** The version the launchpad-family arm (migration 107) was gated at, and stays gated at. */
const LAUNCHPAD_FAMILY_VOCABULARY_VERSION = 2;

/** The version the historical launch-fee arm (migration 111) was gated at, and stays gated at. */
const LAUNCH_FEE_VOCABULARY_VERSION = 3;

/**
 * The version the Lighter arms are gated at (migration 152) - both the
 * exchange funding legs above and the fill ledger's own enqueue below.
 */
export const LIGHTER_VOCABULARY_VERSION = 4;


/**
 * THE BACKFILL GATE ON THE WIDENED VOCABULARY, and the defect it exists to
 * prevent.
 *
 * Widening the reportable vocabulary makes rows that ALREADY EXIST newly
 * eligible. The scan runs in two modes: the one-time BACKFILL (`backfill =
 * TRUE`, "this is history") and the incremental tick (`backfill = FALSE`, "this
 * just happened"). Whichever runs first claims the whole newly-eligible
 * population, because a completed outbox row is never re-enqueued and never
 * re-sent. If the incremental tick got there first, months of historical claim
 * rows would reach the server labelled as live activity - a lie it has no way to
 * detect and this install no way to correct.
 *
 * So the new vocabulary is admitted only when BOTH hold:
 *   - the database carries the widening (`vocabulary_version >= N`), and
 *   - this scan is either the controlled backfill itself, or it runs after a
 *     backfill THAT COVERED THIS VOCABULARY completed
 *     (`backfill_vocabulary_version >= N`).
 *
 * N is per ARM, not per build: the launchpad family is gated at 2 and the
 * historical launch-fee population at 3, so an installation that covered 2 keeps
 * reporting the family live while only the arm it never scanned waits.
 *
 * THE SECOND CONDITION IS A VERSION AND NOT A TIMESTAMP, and that is the whole
 * point of it. `backfill_enqueued_at IS NOT NULL` says only that SOME backfill
 * ran; it cannot say which vocabulary that backfill scanned. A build at
 * `AGENTSCAN_VOCABULARY_VERSION = 1` running against a database migration 107
 * has already stamped at 2 - an older binary on a migrated install, which is an
 * ordinary state during a staged rollout - performs a V1-ONLY scan and, under
 * the timestamp gate, leaves a mark the next V2 build reads as "the family
 * history is covered". Every historical claim row then reaches the server
 * labelled live activity. The version stamp is written by the marking
 * transaction with the version the scan actually ran under, so it can only say
 * what was really covered, and a V1 mark cannot satisfy a V2 gate.
 *
 * That is the VS Code one-time-migration shape (a durable done-marker, the work
 * skipped when it is present, the marker written after the work) applied to a
 * set query: migration 107 resets the marker, the next periodic run enqueues the
 * history under it, and every incremental tick before that mark refuses the new
 * roles instead of stealing them.
 *
 * `$1` is the scan's own backfill flag, cast so Postgres reads it as a boolean
 * in both the predicate and the inserted column.
 */
const ELIGIBILITY_SQL = `
      ${ELIGIBLE_STATUS_AND_FAMILY_SQL}
  AND (
        ${ELIGIBLE_VOCABULARY_V1_SQL}
     OR (${ELIGIBLE_VOCABULARY_V2_SQL}
         AND s.vocabulary_version >= ${LAUNCHPAD_FAMILY_VOCABULARY_VERSION}
         AND ($1::boolean
              OR s.backfill_vocabulary_version >= ${LAUNCHPAD_FAMILY_VOCABULARY_VERSION}))
     OR (${ELIGIBLE_VOCABULARY_V3_SQL}
         AND s.vocabulary_version >= ${LAUNCH_FEE_VOCABULARY_VERSION}
         AND ($1::boolean
              OR s.backfill_vocabulary_version >= ${LAUNCH_FEE_VOCABULARY_VERSION}))
     OR (${ELIGIBLE_VOCABULARY_V4_SQL}
         AND s.vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION}
         AND ($1::boolean
              OR s.backfill_vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION}))
      )`;

/**
 * How long a confirmed row may wait for its executed amounts before it is
 * reported without them.
 *
 * The amounts have to ride the TERMINAL event: the server's only merge window
 * is `pending -> terminal`, and a second terminal event for the same pair is
 * silently dropped, so an amount that arrives after the confirmed event was
 * sent can never reach the server. Holding is therefore the only way to report
 * a settled amount at all. The grace bounds the hold: a decoder that never
 * finishes, or a lane that is not running, must not make the activity itself
 * invisible.
 */
const CONFIRMED_AMOUNT_GRACE_MINUTES = 15;

/** The roles whose completeness means BOTH executed legs. */
const BOTH_LEGS_ROLES_SQL = `(
  'swap','wrap','unwrap','token_launch',
  'yield_pt','yield_yt','yield_sy',
  'predict_buy','predict_sell','predict_claim','predict_close')`;

/**
 * The LEND roles: required legs follow the tokens the row itself populated. A
 * vault deposit/withdrawal populates both sides (asset <-> shares) and so still
 * requires both; a direct-market operation moves exactly ONE token and requires
 * only that side.
 */
const LEND_ROLES_SQL = `('lend_deposit','lend_withdraw','lend_borrow_operate')`;

/**
 * The CLAIM-KIND roles that PAY the wallet, and therefore owe their payout
 * before the terminal event is reported.
 *
 * `pools_claim` proved the shape: `collectAndClaim` returns the launched token
 * and the asset it was paired against together, so a row carrying one and not
 * the other has read half a settlement. Migration 102's `creator_fee_claim` and
 * `holder_reward_claim` are that same shape under venue-independent names, and
 * the AgentScan contract admits exactly these three on its second-output-leg
 * allowlist (`SECOND_LEG_ROLES`).
 *
 * `reward_distribution` is deliberately NOT here. The caller of `distribute()`
 * is paid nothing, so there is no leg of theirs to wait for; requiring one would
 * hold every honest distribute for the full grace and then report it amountless
 * anyway. Its amounts are optional on both sides of the wire.
 *
 * A zero is a PROVEN amount, not a missing one, which is why every test here is
 * on the field's presence rather than on its value.
 */
const CLAIM_FAMILY_PAYOUT_ROLES_SQL = `('pools_claim','creator_fee_claim','holder_reward_claim')`;

/**
 * "This row's role has every executed leg it requires" - the SQL mirror of
 * `roleLegsIncomplete` (`./agent-activity/role-legs.ts`), negated.
 *
 * A mirror rather than a shared implementation because the scan is one set
 * query over the whole table and cannot call a row predicate. It must be kept
 * arm for arm with that function: `yield_claim` is output-only,
 * `bridge_deposit` is input-only, the second legs are required only where the
 * row populated their tokens, the LEND roles require each FIRST leg on those
 * same terms (a vault row populates both token sides and needs both, a
 * direct-market row moves exactly ONE token and needs one), and a role that
 * bears no amounts is never incomplete. The claim family proves its OUTPUTS
 * only (it spends nothing), `launch_cancel` waits for the refund only when the
 * row itself declared the token it is refunded in, and `reward_distribution`
 * and `vex_fee` bear no required amounts at all.
 */
const ROLE_LEGS_COMPLETE_SQL = `
  CASE
    WHEN a.event_role = 'yield_claim' THEN a.executed_amount_out_raw IS NOT NULL
    WHEN a.event_role = 'bridge_deposit' THEN a.executed_amount_in_raw IS NOT NULL
    WHEN a.event_role IN ${CLAIM_FAMILY_PAYOUT_ROLES_SQL} THEN
      a.executed_amount_out_raw IS NOT NULL
      AND (a.token_out2_address IS NULL OR a.executed_amount_out2_raw IS NOT NULL)
    WHEN a.event_role = 'launch_cancel' THEN
      (a.token_out_address IS NULL OR a.executed_amount_out_raw IS NOT NULL)
    WHEN a.event_role IN ${LEND_ROLES_SQL} THEN
      (a.token_in_address IS NULL OR a.executed_amount_in_raw IS NOT NULL)
      AND (a.token_out_address IS NULL OR a.executed_amount_out_raw IS NOT NULL)
    WHEN a.event_role IN ('yield_py','yield_lp') THEN
      a.executed_amount_in_raw IS NOT NULL
      AND a.executed_amount_out_raw IS NOT NULL
      AND (a.token_in2_address IS NULL OR a.executed_amount_in2_raw IS NOT NULL)
      AND (a.token_out2_address IS NULL OR a.executed_amount_out2_raw IS NOT NULL)
    WHEN a.event_role IN ${BOTH_LEGS_ROLES_SQL} THEN
      a.executed_amount_in_raw IS NOT NULL AND a.executed_amount_out_raw IS NOT NULL
    ELSE TRUE
  END`;

/**
 * THE ONE HOLD THE GRACE MAY NOT LIFT: an amount whose own transaction has not
 * happened yet.
 *
 * Every other reason a confirmed row is amountless is a lane that might never
 * finish, which is what the grace above bounds. `keeper_purchase_pending` is not
 * that: a Virtuals launch's payout is bought by the VENUE'S KEEPER in a second
 * transaction, minutes to hours later, with no signer or job of ours able to
 * hurry it. Releasing the terminal pair on a timer would spend the server's
 * single `pending -> terminal` merge window (`activities-ingest-repo.ts:73`
 * accepts that promotion exactly once and silently drops a repeat) on a report
 * that carries no payout - and the real figure, when the keeper sweep writes it,
 * would then have nowhere to go, forever.
 *
 * So a launch waiting on its keeper is not reportable as terminal at all. The
 * hold ends when a settlement is OBSERVED (the keeper's amount, or a
 * cancellation) or when the sweep concludes by name that no amount is coming -
 * both of which replace this provenance, which is what makes the wait bounded by
 * an event rather than unbounded in time. The activity itself is never invisible
 * meanwhile: whichever tick first sees the row holds its terminal event and
 * sends the PENDING snapshot instead (see
 * {@link KEEPER_OWED_PENDING_PROJECTION_SQL}), which is also what the server
 * needs in order to have something to promote when the payout lands.
 */
// `IS DISTINCT FROM` rather than `<>`: settlement_source is NULL on every
// pending row and on every row written before migration 067, and three-valued
// logic would turn "we do not know how the amounts were established" into "not
// ready", holding back the whole table.
const SETTLEMENT_NOT_STILL_OWED_SQL =
  `a.settlement_source IS DISTINCT FROM 'keeper_purchase_pending'`;

/**
 * The settlement provenances that END the wait without amounts: a decoder that
 * declined by name (`noteSettlementDeclined`) and the durable quarantine two
 * disagreeing decoders leave behind. Each is a CONCLUSION that no reportable
 * amount is coming, so holding the row longer would only delay the activity.
 */
const SETTLEMENT_CONCLUDED_WITHOUT_AMOUNTS_SQL =
  `a.settlement_source IN ('amounts_incomplete','amounts_undecodable','conflict_quarantined')`;

/**
 * HOLD A CONFIRMED ROW UNTIL ITS MONEY IS KNOWN - the readiness gate, applied
 * before the pair is ever enqueued.
 *
 * The server merges `pending -> terminal` exactly once and silently drops a
 * repeat of a terminal pair, so executed amounts that miss their own confirmed
 * event are lost to it forever. Enqueueing the pending snapshot immediately and
 * the confirmed snapshot only when its amounts are settled is what makes the
 * one merge window carry the money.
 *
 * Three ways out, so the hold can never be permanent: the amounts arrived, a
 * decoder concluded by name that none are coming, or the grace elapsed. Every
 * other status bypasses the gate entirely - a pending row has no amounts to
 * wait for, and neither a definitive failure nor a superseded row ever will.
 *
 * The SECOND arm is the exception to the grace and the only one: an amount whose
 * own transaction has not happened yet is not a lane that might never finish
 * (see {@link SETTLEMENT_NOT_STILL_OWED_SQL}). It ends on an event, never on a
 * clock.
 */
const CONFIRMED_READINESS_SQL = `
  ((a.status <> 'confirmed'
    OR ${ROLE_LEGS_COMPLETE_SQL}
    OR ${SETTLEMENT_CONCLUDED_WITHOUT_AMOUNTS_SQL}
    OR a.confirmed_at IS NULL
    OR a.confirmed_at < NOW() - make_interval(mins => ${CONFIRMED_AMOUNT_GRACE_MINUTES}))
   AND (a.status <> 'confirmed' OR ${SETTLEMENT_NOT_STILL_OWED_SQL}))`;

/**
 * THE PENDING PROJECTION A CONFIRMED-BUT-OWED LAUNCH STILL NEEDS.
 *
 * The diff scan enqueues the pair `(activity_id, a.status)` - the row's status
 * as it stands NOW - so the pending snapshot of any row is only ever produced by
 * a tick that RAN while the row was pending. For every other role that is
 * harmless: a row that confirms between two ticks simply reports its terminal
 * event, which the server inserts on first sight
 * (`activities-ingest-repo.ts` INSERT arm).
 *
 * A launch waiting on the venue's keeper is the one row for which it is not.
 * Its terminal event is HELD by {@link SETTLEMENT_NOT_STILL_OWED_SQL} until the
 * keeper settles - minutes to hours - and if no tick happened to run between the
 * row's creation and its confirmation, it has no pending event either. The
 * activity is then INVISIBLE on AgentScan for the whole wait: created, confirmed
 * and reported nowhere (Codex round-3 blocker 5C, reproduced on real Postgres).
 * K3's "the pending snapshot still reports immediately" only ever held when a
 * tick fell in that window.
 *
 * So a confirmed row whose keeper purchase is still owed also projects the
 * PENDING snapshot it never got to send. That is not a second reporting path:
 * it is the same outbox pair every other row produces, in the order the server
 * expects - a pending insert now, its single `pending -> terminal` promotion
 * when the payout is known. The `NOT EXISTS` diff makes it exactly once (a row
 * that already sent its pending snapshot inserts nothing here), and the server
 * ignores a pending event for a row it already holds as terminal
 * (`PROMOTE_PENDING_ACTIVITY` requires `status = 'pending'`), so this can never
 * regress a status either.
 */
const KEEPER_OWED_PENDING_PROJECTION_SQL = `
  a.status = 'confirmed' AND a.settlement_source = 'keeper_purchase_pending'`;

/** Exponential claim backoff: 30 s · 2^n, capped at 1 h (exponent clamped so POWER stays finite). */
const CLAIM_BACKOFF_SQL = `LEAST(30 * POWER(2, LEAST(o.attempt_count, 20)), 3600)`;

/**
 * The generation predicate restated inside a fenced statement's own SQL, so the
 * row write and the fence are evaluated by ONE statement against ONE committed
 * state rather than by two. Every caller of it has already taken the singleton
 * `FOR SHARE` in the same transaction; the predicate is the second half of that
 * guard, never a substitute for it.
 */
const GENERATION_UNCHANGED_SQL = (param: string) =>
  `(SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1) = ${param}::int`;

async function ensureSingleton(): Promise<void> {
  await execute(
    `INSERT INTO agentscan_reporting_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );
}

interface StateRow {
  agent_hash: string | null;
  ingest_token: string | null;
  consent_version: number;
  accepted_at: Date | null;
  registered_at: Date | null;
  register_attempt_count: number;
  next_register_attempt_at: Date;
  backfill_enqueued_at: Date | null;
  vocabulary_version: number;
  backfill_vocabulary_version: number | null;
  registration_generation: number;
  stopped_reason: AgentscanStopReason | null;
  agent_name: string | null;
  last_handshake_at: Date | null;
  server_cursor_row_id: string | number | null;
  bound_wallets_fingerprint: string | null;
}

function mapState(row: StateRow): AgentscanReportingState {
  return {
    agentHash: row.agent_hash,
    ingestToken: row.ingest_token,
    consentVersion: Number(row.consent_version),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    registerAttemptCount: Number(row.register_attempt_count),
    nextRegisterAttemptAt: new Date(row.next_register_attempt_at).toISOString(),
    backfillEnqueuedAt: row.backfill_enqueued_at ? new Date(row.backfill_enqueued_at).toISOString() : null,
    vocabularyVersion: Number(row.vocabulary_version),
    backfillVocabularyVersion:
      row.backfill_vocabulary_version === null ? null : Number(row.backfill_vocabulary_version),
    registrationGeneration: Number(row.registration_generation),
    stoppedReason: row.stopped_reason,
    agentName: row.agent_name,
    lastHandshakeAt: row.last_handshake_at ? new Date(row.last_handshake_at).toISOString() : null,
    serverCursorRowId: row.server_cursor_row_id === null ? null : Number(row.server_cursor_row_id),
    boundWalletsFingerprint: row.bound_wallets_fingerprint,
  };
}

export async function getReportingState(): Promise<AgentscanReportingState> {
  await ensureSingleton();
  const row = await queryOne<StateRow>(`SELECT * FROM agentscan_reporting_state WHERE id = 1`);
  if (!row) throw new Error("agentscan_reporting_state singleton missing after ensure");
  return mapState(row);
}

/**
 * Store an identity IF none exists yet; an already-stored identity always
 * wins. The `agent_hash IS NULL` guard (not a read-then-write) is what makes
 * concurrent callers safe - exactly one generator result is ever persisted.
 */
export async function ensureIdentity(
  gen: () => { agentHash: string; ingestToken: string },
): Promise<AgentscanReportingState> {
  await ensureSingleton();
  const identity = gen();
  await execute(
    `UPDATE agentscan_reporting_state
        SET agent_hash = $1, ingest_token = $2, accepted_at = NOW(), updated_at = NOW()
      WHERE id = 1 AND agent_hash IS NULL`,
    [identity.agentHash, identity.ingestToken],
  );
  return getReportingState();
}

export interface MarkHandshakeCompleteInput {
  /** Display name AgentScan bound to this install (session/complete response). */
  readonly agentName: string;
  /** The ROTATED token session/complete returned - replaces whatever was stored. */
  readonly ingestToken: string;
  /** session/complete's syncState.lastAcceptedRowId - null for a brand-new agent. */
  readonly serverCursorRowId: number | null;
  /** sha256 of the sorted chainFamily:address inventory list this handshake covered. */
  readonly walletsFingerprint: string;
}

/**
 * A successful wallet-binding handshake (session/start → sign → session/complete):
 * rotate the stored token, stamp `registered_at` (kept in sync so the existing
 * backfill/drain gate needs no change) and `last_handshake_at`, store the
 * server's name/cursor/fingerprint, and reset the attempt backoff to 0/now -
 * a stale attempt count from a PRIOR failed handshake must not throttle the
 * NEXT one this success has nothing to do with.
 */
export async function markHandshakeComplete(input: MarkHandshakeCompleteInput): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET ingest_token = $1,
            agent_name = $2,
            server_cursor_row_id = $3,
            bound_wallets_fingerprint = $4,
            registered_at = NOW(),
            last_handshake_at = NOW(),
            register_attempt_count = 0,
            next_register_attempt_at = NOW(),
            updated_at = NOW()
      WHERE id = 1`,
    [input.ingestToken, input.agentName, input.serverCursorRowId, input.walletsFingerprint],
  );
}

/** A failed register attempt: bump the counter, hold the next try for `delaySeconds`. */
export async function noteRegisterAttemptFailed(delaySeconds: number): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET register_attempt_count = register_attempt_count + 1,
            next_register_attempt_at = NOW() + make_interval(secs => $1::float8),
            updated_at = NOW()
      WHERE id = 1`,
    [delaySeconds],
  );
}

/**
 * Shared by `resetForReRegistration` and `resetIdentityForRecovery`: EVERY
 * non-poisoned outbox row becomes owed again and flagged `backfill` (a
 * historical resend, not fresh activity). Poisoned rows (`rejected_at`) stay
 * poisoned - a validation refusal the server made once does not become valid by
 * resending the identical payload. Caller runs this inside its own transaction
 * alongside its own state reset, so a crash can't leave one half applied.
 *
 * SENT AND UNSENT ALIKE, and the unsent half is the one this rule exists for.
 * The reset used to be scoped to `sent_at IS NOT NULL`, which reads as "only a
 * row the server already saw needs resending". That is wrong for the state this
 * path is entered from: the 401 that triggers it arrives while a batch is in
 * flight, so the rows that were being sent when the identity went away are
 * exactly the ones still `sent_at IS NULL` and still `backfill = FALSE`. Left
 * untouched, they survive the reset and the drain later sends this install's
 * historical activity to a freshly-registered agent labelled as LIVE. The
 * controlled backfill cannot rescue them either: `enqueueEligibleActivity` is a
 * diff on `(activity_id, status)` and those pairs already have rows, so it
 * inserts nothing and the mislabelling is permanent. Resetting an unsent row is
 * otherwise a no-op on its own terms - it was owed before and is owed after.
 */
async function resetOutboxForFullResend(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE agentscan_outbox
        SET sent_at = NULL, attempt_count = 0, next_attempt_at = NOW(), backfill = TRUE, last_error = NULL
      WHERE rejected_at IS NULL`,
  );
}

/**
 * `auth_lost` recovery (401/403-not_registered on send): the server no longer
 * knows this install (a server-side reset is the expected cause), so it also
 * has none of the history this install already sent. Registration is
 * idempotent - the lane simply re-registers the SAME identity next tick - but
 * the diff scan's NOT-EXISTS can never re-enqueue a pair that already has an
 * outbox row, so a full resend has to come from resetting the existing rows,
 * not from re-scanning. The identity itself (agent_hash/ingest_token) is left
 * untouched: this path is for when the SERVER has forgotten the install, not
 * for when the CLIENT's stored token has drifted from what the server
 * actually holds (that case is `resetIdentityForRecovery`, below).
 */
export async function resetForReRegistration(): Promise<void> {
  await ensureSingleton();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentscan_reporting_state
          SET registered_at = NULL,
              backfill_enqueued_at = NULL,
              backfill_vocabulary_version = NULL,
              registration_generation = registration_generation + 1,
              updated_at = NOW()
        WHERE id = 1`,
    );
    await resetOutboxForFullResend(client);
  });
}

/**
 * `auth_lost` recovery for a session/complete `401` on an EXISTING binding
 * (token mismatch): unlike `resetForReRegistration`, this is NOT recoverable
 * by retrying the same identity, because the server holds SOME current token
 * for this agent_hash that this install does not know (the canonical cause:
 * a crash between the server committing a rotation and this install
 * persisting it via `markHandshakeComplete` - the next handshake attempt
 * would keep presenting the same stale bearer forever, an infinite 401 loop).
 * The only way out is to abandon the identity entirely: clear agent_hash,
 * ingest_token, agent_name, bound_wallets_fingerprint, and every
 * registration/backfill/handshake stamp, and reset the attempt backoff so
 * the next tick retries immediately. `ensureIdentity` then mints a FRESH
 * agent_hash/ingest_token next run, and the server's transfer-on-proof
 * semantics (sprint lead addendum) re-bind the same proven wallets to it -
 * that is the designed recovery, not a data-loss path. The outbox reset is
 * the same full-resend as `resetForReRegistration`, in the same transaction.
 */
export async function resetIdentityForRecovery(): Promise<void> {
  await ensureSingleton();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentscan_reporting_state
          SET agent_hash = NULL,
              ingest_token = NULL,
              agent_name = NULL,
              bound_wallets_fingerprint = NULL,
              registered_at = NULL,
              backfill_enqueued_at = NULL,
              backfill_vocabulary_version = NULL,
              registration_generation = registration_generation + 1,
              last_handshake_at = NULL,
              server_cursor_row_id = NULL,
              register_attempt_count = 0,
              next_register_attempt_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
    );
    await resetOutboxForFullResend(client);
  });
}

/** Permanent stop - 410, 403-quarantined, or a register 409. Never auto-cleared. */
export async function markStopped(reason: AgentscanStopReason): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET stopped_reason = $1, stopped_at = NOW(), updated_at = NOW()
      WHERE id = 1`,
    [reason],
  );
}


/**
 * The diff scan. Inserts every eligible-AND-READY (activity, status) pair the
 * outbox has never seen - the row's own status, plus the pending projection a
 * confirmed launch still owing its keeper purchase never sent
 * (see {@link KEEPER_OWED_PENDING_PROJECTION_SQL}); returns how many were
 * enqueued. `backfill` stamps the rows as belonging to the one-time
 * post-registration history send.
 *
 * A confirmed pair that is held back by `CONFIRMED_READINESS_SQL` is not lost:
 * the scan is a diff, so the next tick that finds it ready enqueues it then.
 * The same is true of a row held back by the vocabulary gate: the controlled
 * backfill picks it up, and every scan after that mark sees it.
 */
const enqueueEligibleSql = (generationPredicate: string): string => `
     INSERT INTO agentscan_outbox (activity_id, status, backfill)
     SELECT a.id, snapshot.status, $1::boolean
       FROM agent_activity a
      CROSS JOIN (
             SELECT vocabulary_version, backfill_vocabulary_version
               FROM agentscan_reporting_state
              WHERE id = 1
           ) s
      -- THE SNAPSHOTS THIS ROW OWES, at most one of each per scan. The row's own
      -- status when the readiness gate lets it through, plus the pending
      -- projection a confirmed launch still owing its keeper purchase never got
      -- to send. The two arms are mutually exclusive by construction: the
      -- readiness gate holds exactly the rows the second arm selects.
      CROSS JOIN LATERAL (
             SELECT a.status AS status WHERE ${CONFIRMED_READINESS_SQL}
             UNION ALL
             SELECT 'pending'::text WHERE ${KEEPER_OWED_PENDING_PROJECTION_SQL}
           ) snapshot
      WHERE ${ELIGIBILITY_SQL}
        AND ${generationPredicate}
        AND NOT EXISTS (SELECT 1 FROM agentscan_outbox o
                         WHERE o.activity_id = a.id AND o.status = snapshot.status)
     ON CONFLICT (activity_id, status) DO NOTHING`;

/**
 * THE FILL LEDGER'S OWN DIFF SCAN.
 *
 * The same shape as the activity scan and for the same reasons: a set query
 * over the ledger, `NOT EXISTS` against the outbox, no hooks in the writers, so
 * a fill recorded while the app was offline is enqueued by the next tick and a
 * fill already enqueued is never enqueued twice.
 *
 * ONE STATUS, ALWAYS `confirmed`. A fill is not a proposal that might fail
 * later: the provider executed it, and its economics are immutable from that
 * moment. There is no pending snapshot to send and no terminal transition to
 * wait for, so the `(source, status)` pair a fill produces is unique by
 * construction. That is also why the readiness gate the activity scan applies
 * (hold a confirmed row until its money is known) has no counterpart here: the
 * money IS the fill.
 *
 * The vocabulary gate is the same two-part gate the launchpad arms use - the
 * database carries the widening, and either this scan IS the controlled
 * backfill or a backfill that covered this vocabulary has completed - so fills
 * written before this install ever registered are reported as the history they
 * are, not as live activity.
 */
const enqueueEligibleFillsSql = (generationPredicate: string): string => `
     INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, status, backfill)
     SELECT 'lighter_fill', f.id, 'confirmed', $1::boolean
       FROM lighter_fills f
      CROSS JOIN (
             SELECT vocabulary_version, backfill_vocabulary_version
               FROM agentscan_reporting_state
              WHERE id = 1
           ) s
      WHERE s.vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION}
        AND ($1::boolean OR s.backfill_vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION})
        -- HELD ROWS ARE NOT VEX ACTIVITY YET. A fill observed before its
        -- intent was known (recovery after a crash) is a fact worth storing
        -- and NOT a claim that Vex created the order: reporting it would
        -- attribute someone else's trading to this agent whenever the match is
        -- wrong. attachLighterFillToIntent is what grants the attribution,
        -- and this null is what withholds it until then.
        AND f.execution_intent_id IS NOT NULL
        AND ${generationPredicate}
        AND NOT EXISTS (SELECT 1 FROM agentscan_outbox o
                         WHERE o.lighter_fill_id = f.id AND o.status = 'confirmed')`;

/**
 * THE ENRICHMENT SCAN - how an exact fee proven AFTER delivery gets out.
 *
 * The defect it closes (review round 1, gap A): the fill scan above excludes
 * any fill that already has an outbox row, which is correct for the fill (its
 * economics are immutable, so a second report of it would be a duplicate) and
 * fatal for the fee. `enrichLighterFillChargedFees` writes an exact charged
 * amount that was unknown at fill time and bumps `lighter_fills.revision`; the
 * fill's own row is already `sent_at`, terminal and invisible to the diff, so
 * without this scan the exact figure is never reported and AgentScan sums
 * estimates forever.
 *
 * The row is keyed on (fill, revision), so:
 *
 *   - a fee proven after delivery produces exactly ONE pending enrichment row;
 *   - a repeat of the same enrichment updates nothing (the `IS NULL` guard),
 *     leaves the revision where it was, and produces no second row;
 *   - a SECOND, genuinely new fee (the exchange fee proven after the
 *     integrator fee) bumps the revision again and gets its own row.
 *
 * DELIVERY OF THE FILL IS THE PRECONDITION. While the fill's own row is still
 * unsent, the mapper reads the ledger row at claim time and the exact fee
 * travels on the fill itself; enqueuing an enrichment for a fill nobody has
 * seen would ask the server to update a fill it does not hold.
 */
const enqueueFillEnrichmentsSql = (generationPredicate: string): string => `
     INSERT INTO agentscan_outbox
       (source_kind, lighter_fill_id, enrichment_revision, status, backfill)
     SELECT 'lighter_fill_enrichment', f.id, f.revision, 'confirmed', $1::boolean
       FROM lighter_fills f
      CROSS JOIN (
             SELECT vocabulary_version, backfill_vocabulary_version
               FROM agentscan_reporting_state
              WHERE id = 1
           ) s
      WHERE f.revision > 0
        AND s.vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION}
        AND ($1::boolean OR s.backfill_vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION})
        AND ${generationPredicate}
        AND EXISTS (SELECT 1 FROM agentscan_outbox base
                     WHERE base.lighter_fill_id = f.id
                       AND base.source_kind = 'lighter_fill'
                       AND base.sent_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM agentscan_outbox e
                         WHERE e.lighter_fill_id = f.id
                           AND e.source_kind = 'lighter_fill_enrichment'
                           AND e.enrichment_revision = f.revision)`;

/**
 * The controlled backfill's own enqueue. No generation predicate here: its
 * caller (`enqueueBackfillAndMark`) already holds the singleton `FOR UPDATE`
 * and has compared the generation itself before reaching this statement.
 */
const ENQUEUE_BACKFILL_SQL = enqueueEligibleSql("TRUE");

/** The fill ledger's half of the controlled backfill, under the same lock. */
const ENQUEUE_BACKFILL_FILLS_SQL = enqueueEligibleFillsSql("TRUE");

/** The enrichment half of the controlled backfill, under the same lock. */
const ENQUEUE_BACKFILL_FILL_ENRICHMENTS_SQL = enqueueFillEnrichmentsSql("TRUE");

/** The incremental fill scan, fenced on the lane's credential generation. */
const ENQUEUE_INCREMENTAL_FILLS_SQL = enqueueEligibleFillsSql(GENERATION_UNCHANGED_SQL("$2"));

/** The incremental enrichment scan, fenced on the same generation. */
const ENQUEUE_INCREMENTAL_FILL_ENRICHMENTS_SQL = enqueueFillEnrichmentsSql(GENERATION_UNCHANGED_SQL("$2"));

/** The incremental scan's enqueue, fenced on the lane's credential generation. */
const ENQUEUE_INCREMENTAL_SQL = enqueueEligibleSql(GENERATION_UNCHANGED_SQL("$2"));

/**
 * THE INCREMENTAL SCAN IS FENCED ON THE LANE'S CREDENTIAL GENERATION.
 *
 * The defect it closes (Codex final review, round 3): a reset can RELABEL rows
 * that already exist, but it can do nothing about a row inserted AFTER it
 * commits. The push lane reads registered state at G, passes its guards, and a
 * concurrent 401 reset then commits G+1 and relabels every non-rejected row as
 * owed history. If the stale lane goes on to run an UNFENCED incremental scan,
 * it inserts a previously absent `(activity_id, status)` pair as
 * `backfill = FALSE` after that relabel. The controlled backfill cannot repair
 * it either - its enqueue is the same diff, and the pair is already taken by the
 * `UNIQUE (activity_id, status)` row - so the row is permanently mislabelled and
 * is later sent to the server as live activity. No later reset needs to happen
 * for that to be the end state: an exhausted rate budget or a retryable send
 * failure is enough to leave the row sitting there.
 *
 * So the scan takes the singleton `FOR SHARE` (a reset holds it exclusively, so
 * a scan arriving mid-reset waits and then reads the new generation) and inserts
 * only while `registration_generation` still equals what the caller read
 * alongside its credentials. When it moved, nothing is inserted and the caller
 * is told `stale_generation`; the next tick re-reads state and scans at the
 * current generation.
 */
export async function enqueueEligibleActivity(
  backfill: boolean,
  expectedGeneration: number,
): Promise<OutboxWriteOutcome> {
  // The singleton has to exist before the CROSS JOIN below, or the scan reads
  // zero state rows and enqueues nothing at all - a silent no-op, not an error.
  await ensureSingleton();
  return withTransaction(async (client) => {
    const state = await queryOneWith<{ registration_generation: number }>(
      client,
      `SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR SHARE`,
    );
    if (state === null || Number(state.registration_generation) !== expectedGeneration) {
      return { kind: "stale_generation", rows: 0 } as const;
    }
    const rows = await executeWith(client, ENQUEUE_INCREMENTAL_SQL, [backfill, expectedGeneration]);
    return { kind: "applied", rows } as const;
  });
}

/**
 * The incremental fill scan, fenced exactly like the activity one.
 *
 * Separate from {@link enqueueEligibleActivity} rather than folded into it
 * because the two read different tables with different eligibility, and a
 * single statement over both would have to invent a join that means nothing.
 * They share the transaction discipline, not the query.
 *
 * TWO STATEMENTS, ONE TRANSACTION AND ONE FENCE: the new fills, then the
 * enrichments of fills already delivered. The second reads the outbox rows the
 * first may have just written, and running it in the same transaction is what
 * keeps a fill and the enrichment of an older fill from landing under two
 * different generations.
 */
export async function enqueueEligibleLighterFills(
  backfill: boolean,
  expectedGeneration: number,
): Promise<OutboxWriteOutcome> {
  await ensureSingleton();
  return withTransaction(async (client) => {
    const state = await queryOneWith<{ registration_generation: number }>(
      client,
      `SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR SHARE`,
    );
    if (state === null || Number(state.registration_generation) !== expectedGeneration) {
      return { kind: "stale_generation", rows: 0 } as const;
    }
    const rows =
      (await executeWith(client, ENQUEUE_INCREMENTAL_FILLS_SQL, [backfill, expectedGeneration]))
      + (await executeWith(client, ENQUEUE_INCREMENTAL_FILL_ENRICHMENTS_SQL, [backfill, expectedGeneration]));
    return { kind: "applied", rows } as const;
  });
}

/** What one attempt at the controlled backfill did, whether or not it got to mark. */
export interface BackfillEnqueueOutcome {
  /** Rows this attempt enqueued as history. `0` when it declined to run. */
  readonly enqueued: number;
  /** Whether the completion mark was written. `false` means the backfill is still owed. */
  readonly marked: boolean;
  /**
   * Why the attempt declined, `null` when it ran. `generation_moved`: a
   * registration reset landed after the caller read its state, so this scan
   * belongs to an identity that no longer exists. `already_marked`: a concurrent
   * runner completed the same backfill first.
   */
  readonly declined: "generation_moved" | "already_marked" | null;
}

/**
 * THE CONTROLLED BACKFILL, ENQUEUE AND COMPLETION MARK IN ONE TRANSACTION.
 *
 * Two commits used to do this - `enqueueEligibleActivity(true)` and then
 * `markBackfillEnqueued()` - and the window between them is a lost update. The
 * 401 lane (`resetForReRegistration`) clears `backfill_enqueued_at` because the
 * whole history is owed again; if that reset lands after the enqueue commits and
 * before the mark does, the mark writes the timestamp straight back over it. The
 * install then believes a backfill it never ran is complete, and every
 * newly-eligible historical row that the reset made owed is picked up by the
 * next INCREMENTAL tick and reported as live activity.
 *
 * The fix is the one shape that makes the two halves one fact: a single
 * transaction that takes `SELECT ... FOR UPDATE` on the singleton before it
 * scans, so a concurrent reset either completes entirely before this attempt or
 * waits behind it, and never interleaves.
 *
 * THE GENERATION IS THE SECOND HALF OF THE GUARD, and it covers what the lock
 * cannot: a reset that landed BEFORE this transaction started, after the caller
 * read the state that made it decide to backfill. The caller passes the
 * generation it saw; a different one under the lock means this scan was decided
 * against an identity that no longer exists, so the attempt declines without
 * enqueueing or marking and the next tick starts over on the current one.
 *
 * The mark stamps `backfill_vocabulary_version` with the version THIS scan ran
 * under, never the schema's, and never walks it backwards - see
 * `AgentscanReportingState.backfillVocabularyVersion` for why an older binary
 * must not be able to satisfy a newer gate.
 */
export async function enqueueBackfillAndMark(input: {
  startedAtGeneration: number;
}): Promise<BackfillEnqueueOutcome> {
  await ensureSingleton();
  return withTransaction(async (client) => {
    const locked = await queryOneWith<{
      registration_generation: number;
      backfill_enqueued_at: Date | null;
      backfill_vocabulary_version: number | null;
    }>(
      client,
      `SELECT registration_generation, backfill_enqueued_at, backfill_vocabulary_version
         FROM agentscan_reporting_state
        WHERE id = 1
          FOR UPDATE`,
    );
    if (locked === null) throw new Error("agentscan_reporting_state singleton missing after ensure");

    if (Number(locked.registration_generation) !== input.startedAtGeneration) {
      return { enqueued: 0, marked: false, declined: "generation_moved" as const };
    }
    const covered =
      locked.backfill_vocabulary_version === null ? null : Number(locked.backfill_vocabulary_version);
    if (locked.backfill_enqueued_at !== null && covered !== null && covered >= AGENTSCAN_VOCABULARY_VERSION) {
      return { enqueued: 0, marked: false, declined: "already_marked" as const };
    }

    // BOTH LEDGERS, ONE BACKFILL. The completion mark says which VOCABULARY was
    // covered, and the Lighter vocabulary spans the activity funding legs and
    // the fill ledger; marking coverage while scanning only one of them would
    // leave the other permanently blocked by its own gate's second condition.
    const enqueued =
      (await executeWith(client, ENQUEUE_BACKFILL_SQL, [true]))
      + (await executeWith(client, ENQUEUE_BACKFILL_FILLS_SQL, [true]))
      + (await executeWith(client, ENQUEUE_BACKFILL_FILL_ENRICHMENTS_SQL, [true]));
    await executeWith(
      client,
      `UPDATE agentscan_reporting_state
          SET backfill_enqueued_at = NOW(),
              backfill_vocabulary_version = GREATEST(COALESCE(backfill_vocabulary_version, 0), $2::int),
              updated_at = NOW()
        WHERE id = 1 AND registration_generation = $1::int`,
      [input.startedAtGeneration, AGENTSCAN_VOCABULARY_VERSION],
    );
    return { enqueued, marked: true, declined: null };
  });
}

/**
 * Claim up to `limit` due rows (backfill first, then oldest), stamping the
 * retry backoff before the caller sends, PROVIDED the registration generation
 * the caller read with its credentials is still current. Returns each claimed
 * pair with its live `agent_activity` row for payload building.
 *
 * Claiming rows the caller cannot legitimately send is worse than claiming
 * nothing: the claim stamps a backoff on rows a reset has just re-owed, and the
 * batch would go out under credentials the reset replaced. So a moved generation
 * claims nothing and answers `stale_generation` - see `ClaimOutboxOutcome`.
 *
 * ONE TRANSACTION, AND THE LOCK ORDER IS STATE THEN OUTBOX. Every writer that
 * touches both the singleton and the outbox takes them in that order
 * (`resetForReRegistration` / `resetIdentityForRecovery` via their state UPDATE,
 * `enqueueBackfillAndMark` via `FOR UPDATE`, the fenced incremental enqueue and
 * the fenced terminal writes via `FOR SHARE`), so no pair of them can deadlock.
 */
/**
 * The discriminator a claimed row reports, read against the references it
 * actually carries rather than trusted blindly: a column value that disagrees
 * with the row's own references would otherwise route the payload builder at
 * the wrong ledger.
 */
function readSourceKind(
  column: string | null,
  fillId: number | null,
  enrichmentRevision: string | number | null,
): AgentscanOutboxSourceKind {
  if (fillId === null) return "agent_activity";
  if (column === "lighter_fill_enrichment" && enrichmentRevision !== null) {
    return "lighter_fill_enrichment";
  }
  return "lighter_fill";
}

export async function claimDueOutbox(
  limit: number,
  expectedGeneration: number,
): Promise<ClaimOutboxOutcome> {
  await ensureSingleton();
  return withTransaction(async (client) => {
    const state = await queryOneWith<{ registration_generation: number }>(
      client,
      `SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR SHARE`,
    );
    if (state === null) throw new Error("agentscan_reporting_state singleton missing after ensure");
    if (Number(state.registration_generation) !== expectedGeneration) {
      return { kind: "stale_generation" } as const;
    }

    const claimed = await queryWith<{
      id: string | number;
      source_kind: string | null;
      activity_id: string | number | null;
      lighter_fill_id: string | number | null;
      enrichment_revision: string | number | null;
      status: ClaimedOutboxEvent["status"];
      backfill: boolean;
    }>(
      client,
      `WITH claimed AS (
         SELECT o.id FROM agentscan_outbox o
          WHERE o.sent_at IS NULL AND o.rejected_at IS NULL AND o.next_attempt_at <= NOW()
            AND ${GENERATION_UNCHANGED_SQL("$2")}
          ORDER BY o.backfill DESC, o.id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE agentscan_outbox o
          SET attempt_count = o.attempt_count + 1,
              next_attempt_at = NOW() + make_interval(secs => ${CLAIM_BACKOFF_SQL}),
              last_error = NULL
         FROM claimed
        WHERE o.id = claimed.id
       RETURNING o.id, o.source_kind, o.activity_id, o.lighter_fill_id, o.enrichment_revision,
                 o.status, o.backfill`,
      [limit, expectedGeneration],
    );
    if (claimed.length === 0) return { kind: "claimed", events: [] } as const;

    const activityIds = [
      ...new Set(claimed.filter((c) => c.activity_id !== null).map((c) => Number(c.activity_id))),
    ];
    const activityRows = activityIds.length === 0
      ? []
      : await queryWith<Record<string, unknown>>(
          client,
          `SELECT * FROM agent_activity WHERE id = ANY($1::bigint[])`,
          [activityIds],
        );
    const byId = new Map(activityRows.map((r) => [Number(r.id), r]));

    const fillIds = [
      ...new Set(claimed.filter((c) => c.lighter_fill_id !== null).map((c) => Number(c.lighter_fill_id))),
    ];
    const fillRows = fillIds.length === 0
      ? []
      : await queryWith<Record<string, unknown>>(
          client,
          `SELECT * FROM lighter_fills WHERE id = ANY($1::bigint[])`,
          [fillIds],
        );
    const fillById = new Map(fillRows.map((r) => [Number(r.id), r]));

    return {
      kind: "claimed",
      events: claimed.map((c) => {
        const activityId = c.activity_id === null ? null : Number(c.activity_id);
        const fillId = c.lighter_fill_id === null ? null : Number(c.lighter_fill_id);
        return {
          outboxId: Number(c.id),
          // A row written before migration 152 carries no discriminator column
          // value of its own only in theory - the column has a DEFAULT - but a
          // null is read as the ledger the reference actually points at rather
          // than trusted blindly.
          sourceKind: readSourceKind(c.source_kind, fillId, c.enrichment_revision),
          activityId,
          status: c.status,
          backfill: c.backfill,
          activity: activityId === null ? null : byId.get(activityId) ?? null,
          fillId,
          fill: fillId === null ? null : fillById.get(fillId) ?? null,
          enrichmentRevision: c.enrichment_revision === null ? null : Number(c.enrichment_revision),
        };
      }),
    } as const;
  });
}

/**
 * THE FENCE EVERY TERMINAL OUTBOX WRITE PASSES THROUGH.
 *
 * The defect it closes (Codex final review, round 2): the periodic and push
 * lanes claim different batches concurrently. Request A commits on the server
 * but its response is delayed; request B comes back 401, the drain resets the
 * registration (every non-rejected row unsent, `backfill = TRUE`, generation
 * G+1); A's delayed 200 then arrives and writes `sent_at`. That row is now
 * "already sent" AFTER the reset that made it owed again, so it is silently
 * omitted from the full resend the reset exists to produce. Under
 * `resetIdentityForRecovery` it is worse than a gap: the event stays attached to
 * the identity that was abandoned and never reaches the new one.
 *
 * `atGeneration` is the generation the lane read ALONGSIDE the `agentHash` and
 * `ingestToken` this batch was sent under, handed down through the claim (which
 * refuses at any other generation), so a terminal write is fenced on the
 * credentials that produced it rather than on whatever the claim happened to
 * observe. Two halves, and both are needed:
 *
 *   - `SELECT ... FOR SHARE` on the singleton SERIALIZES this write against a
 *     reset. A reset holds the row exclusively (its own UPDATE), so a write that
 *     arrives mid-reset blocks here until the reset commits and then reads the
 *     new generation. Without it, the write could slip in between the reset's
 *     state UPDATE and its outbox relabel and be undone silently - which is
 *     correct by luck, not by construction - or read a pre-reset snapshot.
 *   - the same generation is restated as a PREDICATE in the UPDATE itself, so
 *     the row write and the fence are evaluated by one statement against one
 *     committed state, never by two.
 *
 * When the reset won, the write applies to nothing: the row stays unsent and
 * backfill-marked, exactly as the reset left it, and the caller is told
 * `stale_generation` so it can report the rows as still owed instead of as sent.
 *
 * This is VS Code's `handleSaveSuccess`
 * (`agents-colab/vscode/src/vs/workbench/services/textfile/common/textFileEditorModel.ts:953-964`):
 * a write that SUCCEEDED downstream may only clear the dirty flag if the
 * model's `versionId` did not move while it was in flight; otherwise the success
 * is real and the model stays dirty. Adopted verbatim in shape. What differs is
 * the failure vocabulary: VS Code silently traces, and metamask-core's
 * `#updateTransactionInternal` throws when the record it re-reads is gone
 * (`agents-colab/metamask-core/packages/transaction-controller/src/TransactionController.ts:2616`),
 * because their caller aborts the whole flow. Ours returns a typed outcome,
 * because a stale batch is ordinary weather on this lane and the drain has to
 * keep accounting for the remaining rows.
 */
async function writeOutboxAtGeneration(
  atGeneration: number,
  run: (client: PoolClient) => Promise<number>,
): Promise<OutboxWriteOutcome> {
  await ensureSingleton();
  return withTransaction(async (client) => {
    const state = await queryOneWith<{ registration_generation: number }>(
      client,
      `SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR SHARE`,
    );
    if (state === null || Number(state.registration_generation) !== atGeneration) {
      return { kind: "stale_generation", rows: 0 } as const;
    }
    return { kind: "applied", rows: await run(client) } as const;
  });
}

/**
 * Server accepted (or deduplicated) these events - terminal, never resent,
 * PROVIDED the registration generation has not moved since the lane read the
 * credentials this batch went out under.
 */
export async function markOutboxSent(
  outboxIds: number[],
  atGeneration: number,
): Promise<OutboxWriteOutcome> {
  if (outboxIds.length === 0) return { kind: "applied", rows: 0 };
  return writeOutboxAtGeneration(atGeneration, (client) =>
    executeWith(
      client,
      `UPDATE agentscan_outbox
          SET sent_at = NOW(), last_error = NULL
        WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND rejected_at IS NULL
          AND ${GENERATION_UNCHANGED_SQL("$2")}`,
      [outboxIds, atGeneration],
    ),
  );
}

/**
 * Server's per-item validation refusal - terminal; retrying an identical payload
 * can only refail. Fenced like every terminal write: a rejection decided against
 * a batch the reset has already relabelled must not poison a row that is now
 * owed again as history, because the payload the NEXT identity sends is not the
 * one this verdict was about.
 */
export async function markOutboxRejected(
  outboxId: number,
  error: string,
  atGeneration: number,
): Promise<OutboxWriteOutcome> {
  return writeOutboxAtGeneration(atGeneration, (client) =>
    executeWith(
      client,
      `UPDATE agentscan_outbox
          SET rejected_at = NOW(), last_error = $2
        WHERE id = $1 AND sent_at IS NULL AND rejected_at IS NULL
          AND ${GENERATION_UNCHANGED_SQL("$3")}`,
      [outboxId, error.slice(0, 200), atGeneration],
    ),
  );
}

/**
 * Override the stamped backoff (e.g. the server's own Retry-After) for still-owed
 * rows. Fenced too: the reset sets `next_attempt_at = NOW()` because the whole
 * history is owed immediately, and a stale hold decided under the previous
 * identity must not push the new one's resend an hour into the future.
 *
 * `reason` is written to `last_error` when given, which is how a hold becomes
 * VISIBLE: an outbox row with neither `sent_at` nor `rejected_at` is owed, and
 * `last_error` is the only place that can say WHY it is waiting. The lane's
 * capability gate depends on that - a row withheld because the deployed
 * AgentScan server does not carry its role yet must be distinguishable, in the
 * database, from one simply waiting on a backoff. Omitting the argument leaves
 * whatever the row already carried, so the ordinary Retry-After hold is
 * unchanged.
 *
 * `last_error` keeps its long-standing contract: status and code WORDS only,
 * never a response body and never the ingest token.
 */
export async function rescheduleOutbox(
  outboxIds: number[],
  delaySeconds: number,
  atGeneration: number,
  reason?: string,
): Promise<OutboxWriteOutcome> {
  if (outboxIds.length === 0) return { kind: "applied", rows: 0 };
  return writeOutboxAtGeneration(atGeneration, (client) =>
    executeWith(
      client,
      `UPDATE agentscan_outbox
          SET next_attempt_at = NOW() + make_interval(secs => $2::float8),
              last_error = COALESCE($4::text, last_error)
        WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND rejected_at IS NULL
          AND ${GENERATION_UNCHANGED_SQL("$3")}`,
      [outboxIds, delaySeconds, atGeneration, reason ?? null],
    ),
  );
}

/**
 * WHAT THE DEPLOYED SERVER ADVERTISES, observed durably with its time.
 *
 * The process-lifetime record in `../../agentscan/server-capability.ts` learns
 * from ingest REFUSALS, and that mechanism cannot work for a vocabulary whose
 * whole contract is that nothing is sent before the server advertises it: the
 * first send would be the probe, and the probe is exactly what must not happen.
 * So a capability is learned from what the server SAYS (its handshake response
 * and its capabilities endpoint) and remembered here, keyed by which server
 * said it and under which registration.
 *
 * `present = false` is a real observation, not an absence of one: an old server
 * answering 404 on the capabilities endpoint has positively told us it carries
 * nothing. "Never asked" is the row not existing.
 */
export interface AgentscanServerCapabilityRecord {
  readonly capability: string;
  readonly present: boolean;
  readonly observedAt: string;
  readonly registrationGeneration: number;
}

/**
 * Record one capability observation for one server.
 *
 * The write is unconditional for the (server, capability) pair: the newest
 * answer from the server is the answer, in both directions. A capability that
 * disappears (a rollback, or a deployment skew behind a load balancer) must be
 * able to go back to absent, because the alternative is sending rows to a
 * deployment that will refuse them.
 */
export async function recordServerCapabilityObservation(input: {
  readonly serverFingerprint: string;
  readonly capability: string;
  readonly present: boolean;
  readonly registrationGeneration: number;
}): Promise<void> {
  await execute(
    `INSERT INTO agentscan_server_capabilities
       (server_fingerprint, capability, present, observed_at, registration_generation)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (server_fingerprint, capability) DO UPDATE
        SET present = EXCLUDED.present,
            observed_at = EXCLUDED.observed_at,
            registration_generation = EXCLUDED.registration_generation`,
    [input.serverFingerprint, input.capability, input.present, input.registrationGeneration],
  );
}

/**
 * The stored observation, or `null` when this server has never been asked.
 *
 * A POSITIVE observation made under a DIFFERENT registration generation is
 * returned as it is stored, with its generation, so the caller can decide: a
 * re-registration can move the install to a different agent on a different
 * deployment, and a positive answer from the deployment we were talking to
 * before is not evidence about the one we are talking to now.
 */
export async function getServerCapabilityObservation(
  serverFingerprint: string,
  capability: string,
): Promise<AgentscanServerCapabilityRecord | null> {
  const row = await queryOne<{
    capability: string;
    present: boolean;
    observed_at: Date;
    registration_generation: number;
  }>(
    `SELECT capability, present, observed_at, registration_generation
       FROM agentscan_server_capabilities
      WHERE server_fingerprint = $1 AND capability = $2`,
    [serverFingerprint, capability],
  );
  if (row === null) return null;
  return {
    capability: row.capability,
    present: row.present,
    observedAt: new Date(row.observed_at).toISOString(),
    registrationGeneration: Number(row.registration_generation),
  };
}
