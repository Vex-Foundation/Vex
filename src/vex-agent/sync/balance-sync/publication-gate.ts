/**
 * The SERIALIZED PUBLICATION GATE for portfolio snapshots, and the IN-FLIGHT
 * LEDGER it reads.
 *
 * ## What a snapshot means now (owner decision 2026-09-04)
 *
 * A snapshot group is a MEASUREMENT of the portfolio at one instant, and money
 * that has left one place and not yet arrived at the other is part of that
 * measurement, not a reason to refuse to take it. The group therefore records
 * three separate facts:
 *
 *   settled     - the sum of the per-wallet `total_usd` rows: balances we read.
 *   in transit  - money we can NAME (this bridge leg, this transfer intent),
 *                 whose age is still inside the bound for its kind.
 *   unresolved  - money whose kind's bound has passed. It is LISTED and
 *                 COUNTED, and it is NEVER added to the in-transit total,
 *                 because a figure nobody can prove must not be presented as
 *                 part of a portfolio.
 *
 * The anxiety case the previous design existed to prevent - "I bridged $150 of
 * my $200, a snapshot fires mid-flight and shows $50 next to a $150 loss" -
 * stays impossible, but it is prevented by ACCOUNTING for the $150, not by
 * withholding the snapshot. Withholding was the reversed decision: on the
 * owner's machine ONE bridge row the provider never conclusively reported
 * withheld every snapshot for 31 days, so the card showed a month-old baseline
 * beside a live total, which is a worse lie than either honest number.
 *
 * ## Adopted from MetaMask's `bridge-status-controller`
 *
 * (`agents-colab/metamask-core/packages/bridge-status-controller/src/`). A
 * pending bridge there is a FIRST-CLASS tracked item: the history entry is
 * written with the quote's own amounts and `estimatedProcessingTimeInSeconds`
 * BEFORE any status arrives (`utils/history.ts` `getInitialHistoryItem`), it is
 * polled until COMPLETE or FAILED, and at no point are the wallet's balances
 * hidden or the amount booked as lost. Age bounds what is POLLED
 * (`DEFAULT_MAX_PENDING_HISTORY_ITEM_AGE_MS`, 2 days) and what is RETRIED
 * (`MAX_ATTEMPTS`), never what is displayed. Our `unresolved` standing is that
 * same idea at our own scale: the bound stops us calling the money in transit,
 * and it never books the money as gone and never hides the rest.
 *
 * ## Why the table lock and the transition fence remain
 *
 * Accounting for in-flight money does not make a HALF-READ group safe. The
 * lock (`LOCK TABLE agent_activity IN SHARE MODE`, taken by
 * `./snapshot-publication.ts`) still makes the ledger read a boundary rather
 * than a stale reading: it conflicts with the `ROW EXCLUSIVE` lock every
 * activity INSERT/UPDATE takes, so from the moment we hold it no activity row
 * can be written until we commit.
 *
 * The table lock was chosen DELIBERATELY over per-wallet advisory locks: an
 * advisory scheme is only safe once all of `agent_activity`'s writers agree on
 * a global lock order, and inventing that ordering is a far larger money-path
 * risk than a sub-second exclusive window on one table. SHARE mode is
 * self-compatible, so it does NOT serialize two concurrent PUBLISHERS against
 * each other - that is already excluded in-process by `./single-flight.ts`.
 *
 * `readActivityFence` closes the second race: a transaction that BEGINS and
 * SETTLES entirely inside the multi-wallet scan leaves nothing in flight at
 * publication time, yet the wallets scanned before it and after it were read on
 * opposite sides of a money movement. It is stamped at cycle start rather than
 * here, so it lives in `./activity-fence.ts` and is re-exported below; see that
 * module for why the fence is keyed on MONEY and no longer on `updated_at`.
 *
 * ## Known scope limit
 *
 * `protocol_executions.execution_status = 'intent'` is in the session-scoped
 * money-state reader but NOT here: that table carries no `wallet_address`, so
 * it cannot be scoped to this cycle's wallets. Every such intent that reaches a
 * broadcast writes an `agent_activity` row, which branch 1 sees.
 */

import { formatUnits } from "viem";

import type { Executor } from "@vex-agent/db/client.js";

/**
 * Bounded: the DISPLAYED ledger is a named list a human reads, and it is
 * persisted into the group record, so it cannot be allowed to grow with the
 * money path.
 *
 * It bounds the LIST and nothing else. Every total and every count this module
 * reports is aggregated by the SERVER over EVERY matching row, so a wallet with
 * 400 in-flight rows still contributes all 400 to its own totals while the list
 * shows the 50 oldest and says so (`InFlightLedger.totalCount` against
 * `entries.length`, and `truncated`). A bound that also bounded the totals
 * would silently remove money from the portfolio, which the repository's
 * no-silent-cutting decree forbids.
 */
const MAX_IN_FLIGHT = 50;

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

/**
 * One thing this cycle's money is currently inside.
 *
 * DUPLICATED, deliberately, by `vex-app/src/shared/schemas/portfolio.ts`'s
 * `snapshotInFlightKindDtoSchema`. The engine tree (`src/`) and the desktop
 * app's `shared` tree cannot import each other: `shared` bundles into the
 * untrusted renderer and the process-boundary gate forbids `@vex-agent` there
 * (rule 90), while the root project's `rootDir` is `src`, so it cannot reach
 * into `vex-app`. `vex-app/src/shared/engine-error-classification.ts` carries
 * the same duplication for the same reason. The two lists are pinned against
 * each other by `vex-app/src/main/database/__tests__/portfolio-snapshot-basis.test.ts`,
 * which runs in the main process and CAN see both.
 */
export const IN_FLIGHT_KINDS = [
  "agent_activity_pending",
  "wallet_intent_live",
  "wallet_confirmation_unknown",
  "wallet_transaction_intent_live",
  "wallet_transaction_confirmation_unknown",
  "wallet_wrap_intent_live",
  "wallet_wrap_confirmation_unknown",
] as const;

export type InFlightKind = (typeof IN_FLIGHT_KINDS)[number];

/**
 * - `in_transit`  - inside the bound for its kind. Counted in the group's
 *                   in-transit total; this is money we expect to land.
 * - `unresolved`  - past that bound. Listed and counted so a human sees it,
 *                   and DELIBERATELY excluded from every total: a figure whose
 *                   outcome nobody can prove must not be presented as part of
 *                   a portfolio, in either direction.
 */
export type InFlightStanding = "in_transit" | "unresolved";

/** One row of the group's in-flight ledger. */
export interface InFlightEntry {
  readonly kind: InFlightKind;
  /**
   * The wallet this money belongs to, carried on EVERY entry so a portfolio
   * read for a SUBSET of the group's wallets can drop what is not its own.
   *
   * Adopted from MetaMask's `bridge-status-controller`: its history item is
   * written with `account: selectedAddress` at creation
   * (`utils/history.ts` `getInitialHistoryItem`) and every scoped operation
   * filters on `bridgeHistoryItem.account === address`
   * (`bridge-status-controller.ts` `#wipeBridgeStatusByChainId`), so one
   * account's pending item can never be attributed to another's.
   */
  readonly walletAddress: string;
  /** Identifier of the row, for audit and operator diagnosis. */
  readonly ref: string;
  /** Structural label only (a status or an event role) - never provider text. */
  readonly detail: string | null;
  readonly standing: InFlightStanding;
  /** Seconds since the row was created. */
  readonly ageSeconds: number;
  /**
   * The human token quantity in transit, as a STRING with `symbol` beside it
   * (rule 90: raw amounts travel with their units and never touch floating
   * point). `null` when the owning table records no amount.
   */
  readonly amountHuman: string | null;
  readonly symbol: string | null;
  /** A display ESTIMATE in USD, never a settlement figure. `null` when unknown. */
  readonly usdEstimate: number | null;
}

/**
 * One wallet's in-flight accounting, aggregated by the SERVER over EVERY row
 * that belongs to it - never over the bounded display list.
 */
export interface WalletInFlightTotals {
  readonly walletAddress: string;
  /** Every in-flight row for this wallet, whether or not it is displayed. */
  readonly entryCount: number;
  /** Rows whose kind's bound has passed. In NO total, in either direction. */
  readonly unresolvedCount: number;
  /**
   * Sum of the USD ESTIMATES of this wallet's `in_transit` rows. Estimates
   * only, never negative (a negative estimate is read as "not priced"), and 0
   * when nothing is in flight or nothing carries a price.
   */
  readonly inTransitUsd: number;
}

export interface InFlightLedger {
  /** The bounded DISPLAY list: the `MAX_IN_FLIGHT` oldest rows, all wallets. */
  readonly entries: readonly InFlightEntry[];
  /** Per-wallet aggregates over ALL rows. Absent wallet means nothing in flight. */
  readonly perWallet: readonly WalletInFlightTotals[];
  /** Every in-flight row across every requested wallet, displayed or not. */
  readonly totalCount: number;
  /**
   * `totalCount` exceeded `MAX_IN_FLIGHT`; the OLDEST were kept in `entries`.
   * Reported so a consumer knows rows are missing rather than being told a
   * short list is the whole truth. The TOTALS are unaffected.
   */
  readonly truncated: boolean;
}

// ── The standing bounds. ONE table, data, not scattered constants ────────

type StandingBound =
  /** In transit while `ageSeconds` is within `maxAgeSeconds`. */
  | { readonly rule: "max-age"; readonly maxAgeSeconds: number; readonly why: string }
  /**
   * In transit until the row's OWN `expires_at`. `fallbackMaxAgeSeconds`
   * applies only if that column comes back null, which the schema forbids
   * (`expires_at` is NOT NULL on all three intent tables) - defence in depth,
   * not an expected path.
   */
  | { readonly rule: "own-expiry"; readonly fallbackMaxAgeSeconds: number; readonly why: string };

interface KindBound {
  readonly bound: StandingBound;
  /**
   * Overrides keyed on `detail`, which is the event ROLE for
   * `agent_activity_pending` and the row STATUS everywhere else. Two rows
   * caught by the same UNION branch are not necessarily waiting on the same
   * clock, and the standing must follow what the row IS, not which predicate
   * matched it.
   */
  readonly byDetail?: Readonly<Record<string, StandingBound>>;
}

/**
 * A hash exists and the outcome is not proven. The wait is a chain confirmation
 * plus our verifier, not an approval window.
 *
 * MEASURED, not assumed: the three "live" branches admit `broadcast_unconfirmed`
 * alongside `consuming` and unexpired `pending`, so a row that has ALREADY
 * broadcast is reported under a `*_intent_live` kind. Its `expires_at` bounds
 * the APPROVAL, which stopped being the relevant clock the moment the
 * transaction left; without this override a three-hour-old broadcast whose
 * expiry has not lapsed reads as `in_transit`, which the real-Postgres suite
 * caught.
 */
const BROADCAST_AWAITING_PROOF: StandingBound = {
  rule: "max-age",
  maxAgeSeconds: 2 * HOUR_SECONDS,
  why: "broadcast hash awaiting a conclusive read",
};

/**
 * How long each kind of in-flight money stays `in_transit`.
 *
 * Every value is a GENEROUS reading of the observed wait, because the cost of
 * the two errors is asymmetric: calling settled money "in transit" for an extra
 * hour overstates a portfolio the user can still see settling, while calling
 * live money "unresolved" drops it out of the total while it is genuinely on
 * its way. Nothing here terminalizes a row, changes a status or moves money -
 * these bounds decide one word in a report.
 */
const STANDING_BOUNDS: Readonly<Record<InFlightKind, KindBound>> = {
  // A broadcast awaiting confirmation. A same-chain leg (swap, transfer,
  // launch, allowance) is minutes at worst on every chain we support.
  agent_activity_pending: {
    bound: { rule: "max-age", maxAgeSeconds: HOUR_SECONDS, why: "same-chain leg awaiting confirmation" },
    byDetail: {
      // The cross-chain fill. Relay quotes seconds and Khalani minutes; two
      // hours is far outside both and still short of a day-long stall.
      bridge_fill_expected: {
        rule: "max-age",
        maxAgeSeconds: 2 * HOUR_SECONDS,
        why: "cross-chain fill; Relay quotes seconds, Khalani minutes",
      },
    },
  },
  // A claimable proposal: it is in transit exactly as long as it can still be
  // consumed. Past `expires_at` the CAS refuses it, so it is dead, not slow.
  wallet_intent_live: {
    bound: { rule: "own-expiry", fallbackMaxAgeSeconds: HOUR_SECONDS, why: "claimable until its own expiry" },
    byDetail: { broadcast_unconfirmed: BROADCAST_AWAITING_PROOF },
  },
  wallet_confirmation_unknown: {
    bound: BROADCAST_AWAITING_PROOF,
  },
  wallet_transaction_intent_live: {
    bound: { rule: "own-expiry", fallbackMaxAgeSeconds: HOUR_SECONDS, why: "claimable until its own expiry" },
    byDetail: { broadcast_unconfirmed: BROADCAST_AWAITING_PROOF },
  },
  wallet_transaction_confirmation_unknown: {
    bound: BROADCAST_AWAITING_PROOF,
  },
  wallet_wrap_intent_live: {
    bound: { rule: "own-expiry", fallbackMaxAgeSeconds: HOUR_SECONDS, why: "claimable until its own expiry" },
    byDetail: { broadcast_unconfirmed: BROADCAST_AWAITING_PROOF },
  },
  wallet_wrap_confirmation_unknown: {
    bound: BROADCAST_AWAITING_PROOF,
  },
};

/** The bound that applies to one row. Exported for the table test. */
export function boundFor(kind: InFlightKind, detail: string | null): StandingBound {
  const entry = STANDING_BOUNDS[kind];
  const override = detail === null ? undefined : entry.byDetail?.[detail];
  return override ?? entry.bound;
}

/**
 * THE ONE DOCUMENTED EXCEPTION to "every in-flight row is listed and
 * classified" (owner decision 2026-09-04, after the review finding that expired
 * pending intents disappear from the ledger).
 *
 * A `pending` wallet / transaction / wrap intent that is past its own
 * `expires_at` and carries NO transaction hash is NOT listed at all - not as
 * `in_transit`, not as `unresolved`. It is not money in flight and never was:
 *
 *   - a `pending` row is a PROPOSAL the user has not spent. The consuming CAS
 *     (`consumeIfPending` and its siblings) filters on `expires_at > NOW()`, so
 *     past that instant the proposal can never be claimed;
 *   - `tx_hash IS NULL` proves nothing was ever broadcast, so no balance moved
 *     and there is no outcome for anyone to prove.
 *
 * Listing it as `unresolved` would tell a human that money is unaccounted for
 * when in fact none ever left. The moment a row DOES carry a hash it is caught
 * by its table's `*_confirmation_unknown` (or `*_intent_live`) branch, which
 * has NO expiry predicate at all: expiry bounds the APPROVAL, and the approval
 * stopped being the relevant clock the moment the transaction left. The
 * integration suite pins both halves as a table over the three intent tables.
 *
 * This is a predicate of `IN_FLIGHT_SQL` (the `expires_at > NOW()` conjunct on
 * each `pending` branch), not of `STANDING_BOUNDS`: a row that is excluded has
 * no standing to compute.
 */

/**
 * The bound table as the SERVER sees it: one row per (kind, detail), with
 * `detail = null` meaning "the kind's default". Built ONCE from
 * `STANDING_BOUNDS` above, which stays the single owner of the DATA; the SQL
 * `CASE` in `LEDGER_CTE` is the single owner of the RULE.
 *
 * Standing moved into SQL because the totals must be aggregated over EVERY
 * row, not over the bounded display list, and an aggregate cannot ask
 * TypeScript how to classify a row it never returns.
 */
interface StandingBoundRow {
  readonly kind: InFlightKind;
  readonly detail: string | null;
  readonly rule: StandingBound["rule"];
  readonly seconds: number;
}

function secondsOf(bound: StandingBound): number {
  return bound.rule === "max-age" ? bound.maxAgeSeconds : bound.fallbackMaxAgeSeconds;
}

function standingBoundRows(): readonly StandingBoundRow[] {
  const rows: StandingBoundRow[] = [];
  for (const kind of IN_FLIGHT_KINDS) {
    const entry = STANDING_BOUNDS[kind];
    rows.push({ kind, detail: null, rule: entry.bound.rule, seconds: secondsOf(entry.bound) });
    for (const [detail, bound] of Object.entries(entry.byDetail ?? {})) {
      rows.push({ kind, detail, rule: bound.rule, seconds: secondsOf(bound) });
    }
  }
  return rows;
}

const STANDING_BOUND_ROWS_JSON = JSON.stringify(standingBoundRows());

// ── The transition fence ─────────────────────────────────────────────────

/**
 * The fence lives in `./activity-fence.ts`: it is stamped at cycle start, long
 * before this module's transaction exists, and it answers a different question
 * (did money MOVE) from the ledger below (what money IS in flight). Re-exported
 * here so every consumer of the publication gate keeps one import.
 */
export {
  readActivityFence,
  fencesMatch,
  type ActivityFence,
} from "./activity-fence.js";

// ── The ledger query ─────────────────────────────────────────────────────

/**
 * Seven wallet-scoped predicates, one round trip. Each is the wallet-scoped
 * reading of the correspondingly named predicate in
 * `db/repos/approval-intents/money-state.ts`; which rows count as live is that
 * module's decision, deliberately not re-derived here. What is NEW is that each
 * branch also carries WHAT the money is and WHOSE it is.
 *
 *  1. `agent_activity` PENDING - a broadcast awaiting confirmation. For a
 *     `bridge_fill_expected` row the money in transit is the EXPECTED OUTPUT
 *     (`amount_out_human` / `token_out_symbol` / `usd_out_est`): the input has
 *     already left the wallet and the balance read no longer contains it. For
 *     every other role the input leg is the amount in transit.
 *  2. `wallet_intents` `consuming`, or `pending` that has NOT expired. `amount`
 *     is the human quantity the user approved and `token` its symbol. The
 *     expiry conjunct is the documented exception above, not an oversight.
 *  3. `wallet_intents` hash-carrying rows in a state that does not prove an
 *     outcome. A legacy `failed`-with-hash row releases ONLY when its linked
 *     activity proves a mined revert. NO expiry predicate: a broadcast row is
 *     never dropped because its approval window lapsed.
 *  4/5. `wallet_transaction_intents` (migration 087) - a GENERIC calldata
 *     proposal, so the table carries no amount or asset at all and the ledger
 *     honestly reports nulls rather than inventing a figure from the payload.
 *  6/7. `wallet_wrap_intents` (migration 096). Its amount is base units
 *     (`amount_raw`) with `wrapped_native_decimals`; the conversion happens in
 *     TypeScript through viem's `formatUnits`, never in floating-point SQL.
 *
 * EVERY branch selects `wallet_address`. The predicate already filters on it,
 * so attribution costs nothing and is exact - and without it a portfolio read
 * for one wallet inherits another wallet's pending bridge, which is the defect
 * this column exists to close.
 *
 * `expires_at` is selected wherever the table has it; the bound table alone
 * decides whether the standing rule uses it.
 */
const LEDGER_BRANCHES_SQL = `
  SELECT 'agent_activity_pending'::text AS kind, a.wallet_address, a.id::text AS ref,
         a.event_role::text AS detail, a.created_at AS since,
         NULL::timestamptz AS expires_at,
         CASE WHEN a.event_role = 'bridge_fill_expected'
              THEN a.amount_out_human ELSE a.amount_in_human END AS amount_text,
         NULL::smallint AS amount_decimals,
         CASE WHEN a.event_role = 'bridge_fill_expected'
              THEN a.token_out_symbol ELSE a.token_in_symbol END AS symbol,
         CASE WHEN a.event_role = 'bridge_fill_expected'
              THEN a.usd_out_est ELSE a.usd_in_est END AS usd_est
    FROM agent_activity a
   WHERE a.wallet_address = ANY($1::text[]) AND a.status = 'pending'

   UNION ALL

  SELECT 'wallet_intent_live', w.wallet_address, w.intent_id::text, w.status::text, w.created_at,
         w.expires_at, w.amount, NULL::smallint, w.token, NULL::numeric
    FROM wallet_intents w
   WHERE w.wallet_address = ANY($1::text[])
     AND (w.status = 'consuming' OR (w.status = 'pending' AND w.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_confirmation_unknown', w.wallet_address, w.intent_id::text, w.status::text, w.created_at,
         w.expires_at, w.amount, NULL::smallint, w.token, NULL::numeric
    FROM wallet_intents w
   WHERE w.wallet_address = ANY($1::text[])
     AND w.tx_hash IS NOT NULL
     AND (
       w.status IN ('broadcast_unconfirmed', 'review_required', 'audit_failed')
       OR (
         w.status = 'failed'
         AND w.failure_reason IS DISTINCT FROM 'RepairLane:chain_reverted'
         AND NOT EXISTS (
           SELECT 1 FROM agent_activity a2
            WHERE a2.id = w.activity_id
              AND a2.event_role = 'wallet_transfer'
              AND a2.tx_hash = w.tx_hash
              AND a2.status = 'definitively_failed'
              AND a2.failure_code = 'mined_revert'
         )
       )
     )

   UNION ALL

  SELECT 'wallet_transaction_intent_live', t.wallet_address, t.intent_id::text, t.status::text, t.created_at,
         t.expires_at, NULL::text, NULL::smallint, NULL::text, NULL::numeric
    FROM wallet_transaction_intents t
   WHERE t.wallet_address = ANY($1::text[])
     AND (t.status IN ('consuming', 'broadcast_unconfirmed')
          OR (t.status = 'pending' AND t.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_transaction_confirmation_unknown', t.wallet_address, t.intent_id::text, t.status::text, t.created_at,
         t.expires_at, NULL::text, NULL::smallint, NULL::text, NULL::numeric
    FROM wallet_transaction_intents t
   WHERE t.wallet_address = ANY($1::text[])
     AND t.tx_hash IS NOT NULL
     AND t.status NOT IN ('executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed')

   UNION ALL

  SELECT 'wallet_wrap_intent_live', w2.wallet_address, w2.intent_id::text, w2.status::text, w2.created_at,
         w2.expires_at, w2.amount_raw, w2.wrapped_native_decimals,
         w2.wrapped_native_symbol, NULL::numeric
    FROM wallet_wrap_intents w2
   WHERE w2.wallet_address = ANY($1::text[])
     AND (w2.status IN ('consuming', 'broadcast_unconfirmed', 'review_required')
          OR (w2.status = 'pending' AND w2.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_wrap_confirmation_unknown', w2.wallet_address, w2.intent_id::text, w2.status::text, w2.created_at,
         w2.expires_at, w2.amount_raw, w2.wrapped_native_decimals,
         w2.wrapped_native_symbol, NULL::numeric
    FROM wallet_wrap_intents w2
   WHERE w2.wallet_address = ANY($1::text[])
     AND w2.tx_hash IS NOT NULL
     AND w2.status NOT IN (
           'executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed', 'review_required'
         )`;

/**
 * The bound table, the age and the standing, evaluated by the SERVER over
 * EVERY in-flight row.
 *
 *   `bounds`      `STANDING_BOUNDS` projected through `$3::jsonb`. The data
 *                 still has exactly one owner in TypeScript; the server is
 *                 handed a copy per call rather than a second table to
 *                 maintain, so the two cannot drift.
 *   `aged`        seconds since the row was created, floored at 0, against the
 *                 caller's clock `$4` - the same instant used for every row in
 *                 the group, and controllable by a test.
 *   `classified`  the effective bound for the row (its `detail` override if the
 *                 table has one, otherwise the kind's default), then the
 *                 standing. `own-expiry` uses the row's own `expires_at`, and
 *                 falls back to the kind's seconds only when that column is
 *                 NULL - which the schema forbids on all three intent tables.
 *
 * A NEGATIVE `usd_est` is normalized to NULL here, ONCE, so the entry a human
 * reads and the total it feeds can never disagree. A price feed that emits a
 * negative estimate is reporting "unknown", and unknown must not subtract from
 * a portfolio (review finding, 2026-09-04).
 */
const LEDGER_CTE_SQL = `
  bounds AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb)
      AS b(kind text, detail text, rule text, seconds bigint)
  ),
  ledger AS (
${LEDGER_BRANCHES_SQL}
  ),
  aged AS (
    SELECT l.*,
           GREATEST(
             0,
             FLOOR(EXTRACT(EPOCH FROM ($4::timestamptz - COALESCE(l.since, $4::timestamptz))))
           )::bigint AS age_seconds
      FROM ledger l
  ),
  classified AS (
    SELECT a.kind, a.wallet_address, a.ref, a.detail, a.since, a.age_seconds,
           a.amount_text, a.amount_decimals, a.symbol,
           CASE WHEN a.usd_est >= 0 THEN a.usd_est END AS usd_est,
           CASE
             WHEN eff.rule = 'own-expiry' AND a.expires_at IS NOT NULL
               THEN CASE WHEN a.expires_at > $4::timestamptz
                         THEN 'in_transit' ELSE 'unresolved' END
             WHEN a.age_seconds <= eff.seconds THEN 'in_transit'
             ELSE 'unresolved'
           END AS standing
      FROM aged a
      JOIN LATERAL (
        SELECT b.rule, b.seconds
          FROM bounds b
         WHERE b.kind = a.kind
           AND (b.detail IS NULL OR b.detail = a.detail)
         ORDER BY (b.detail IS NULL) ASC
         LIMIT 1
      ) eff ON TRUE
  )`;

/**
 * ONE statement, two kinds of row, because they must agree.
 *
 * `agent_activity` is locked by the caller, but `wallet_intents`,
 * `wallet_transaction_intents` and `wallet_wrap_intents` are not; under READ
 * COMMITTED two separate statements would see two snapshots, and an aggregate
 * that counted four rows beside a list that showed five would be a worse
 * report than either. A single statement is one snapshot by construction.
 *
 *   `row_type = 'wallet'`  one per wallet with anything in flight: its counts
 *                          and its in-transit total, over ALL of its rows.
 *   `row_type = 'entry'`   the bounded display list, oldest first.
 */
const IN_FLIGHT_SQL = `
  WITH ${LEDGER_CTE_SQL},
  per_wallet AS (
    SELECT c.wallet_address,
           COUNT(*)                                                  AS entry_count,
           COUNT(*) FILTER (WHERE c.standing = 'unresolved')         AS unresolved_count,
           COALESCE(SUM(c.usd_est) FILTER (WHERE c.standing = 'in_transit'), 0) AS in_transit_usd
      FROM classified c
     GROUP BY c.wallet_address
  ),
  shown AS (
    SELECT * FROM classified ORDER BY since ASC, ref ASC LIMIT $2
  )
  SELECT 0 AS sort_group, 'wallet'::text AS row_type, w.wallet_address,
         w.entry_count::text      AS entry_count,
         w.unresolved_count::text AS unresolved_count,
         w.in_transit_usd::text   AS in_transit_usd,
         NULL::text        AS kind,
         NULL::text        AS ref,
         NULL::text        AS detail,
         NULL::text        AS standing,
         NULL::bigint      AS age_seconds,
         NULL::timestamptz AS since,
         NULL::text        AS amount_text,
         NULL::int         AS amount_decimals,
         NULL::text        AS symbol,
         NULL::numeric     AS usd_est
    FROM per_wallet w
   UNION ALL
  SELECT 1, 'entry'::text, s.wallet_address,
         NULL::text, NULL::text, NULL::text,
         s.kind, s.ref, s.detail, s.standing, s.age_seconds, s.since,
         s.amount_text, s.amount_decimals::int, s.symbol, s.usd_est
    FROM shown s
   ORDER BY sort_group ASC, since ASC NULLS FIRST, ref ASC, wallet_address ASC`;

interface LedgerRow {
  row_type: string;
  wallet_address: string;
  entry_count: string | null;
  unresolved_count: string | null;
  in_transit_usd: string | null;
  kind: string | null;
  ref: string | null;
  detail: string | null;
  standing: string | null;
  since: Date | string | null;
  age_seconds: string | number | null;
  amount_text: string | null;
  amount_decimals: number | string | null;
  symbol: string | null;
  usd_est: string | number | null;
}

const EMPTY_LEDGER: InFlightLedger = {
  entries: [],
  perWallet: [],
  totalCount: 0,
  truncated: false,
};

/**
 * Read everything this cycle's money is currently inside, INSIDE the caller's
 * transaction and AFTER the caller has taken the activity table lock. Read
 * outside that lock the answer is stale the instant it returns - hence the
 * required `Executor`.
 *
 * The DISPLAY list is bounded at `MAX_IN_FLIGHT`. The per-wallet totals are
 * not: they are aggregated by the server over every matching row, so bounding
 * the list can never remove money from a total. `truncated` compares the two.
 */
export async function readInFlightMoney(
  executor: Executor,
  walletAddresses: readonly string[],
  now: number = Date.now(),
): Promise<InFlightLedger> {
  if (walletAddresses.length === 0) return EMPTY_LEDGER;
  const res = await executor.query<LedgerRow>(IN_FLIGHT_SQL, [
    [...walletAddresses],
    MAX_IN_FLIGHT,
    STANDING_BOUND_ROWS_JSON,
    new Date(now).toISOString(),
  ]);

  const entries: InFlightEntry[] = [];
  const perWallet: WalletInFlightTotals[] = [];
  let totalCount = 0;
  for (const row of res.rows) {
    if (row.row_type === "wallet") {
      const totals = toWalletTotals(row);
      perWallet.push(totals);
      totalCount += totals.entryCount;
      continue;
    }
    entries.push(toEntry(row));
  }
  return { entries, perWallet, totalCount, truncated: totalCount > entries.length };
}

function toWalletTotals(row: LedgerRow): WalletInFlightTotals {
  return {
    walletAddress: row.wallet_address,
    entryCount: toCount(row.entry_count),
    unresolvedCount: toCount(row.unresolved_count),
    inTransitUsd: Math.max(0, toUsdEstimate(row.in_transit_usd) ?? 0),
  };
}

function toEntry(row: LedgerRow): InFlightEntry {
  return {
    kind: toKind(row.kind),
    walletAddress: row.wallet_address,
    ref: row.ref ?? "",
    detail: row.detail,
    standing: row.standing === "unresolved" ? "unresolved" : "in_transit",
    ageSeconds: toCount(row.age_seconds),
    amountHuman: toHumanAmount(row.amount_text, row.amount_decimals),
    symbol: row.symbol,
    usdEstimate: toUsdEstimate(row.usd_est),
  };
}

/**
 * The `kind` column is emitted by `LEDGER_BRANCHES_SQL` itself, one literal per
 * branch, so it is always one of the seven. Parsed rather than asserted anyway:
 * the value has crossed the driver, and a cast here would be the one place a
 * future eighth branch could enter the ledger unnamed.
 */
function toKind(value: string | null): InFlightKind {
  const match = IN_FLIGHT_KINDS.find((kind) => kind === value);
  if (match === undefined) {
    throw new Error(`in-flight ledger returned an unknown kind: ${String(value)}`);
  }
  return match;
}

/** A `COUNT`/`bigint` column: a non-negative integer, never a fraction. */
function toCount(value: string | number | null): number {
  if (value === null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * `amountHuman` is a STRING throughout. A row that already stores a human
 * quantity is passed through verbatim; a row that stores base units carries its
 * decimals and is converted by viem's `formatUnits`, which is exact integer
 * arithmetic. No token amount touches a float on this path.
 */
function toHumanAmount(text: string | null, decimals: number | string | null): string | null {
  if (text === null) return null;
  if (decimals === null) return text;
  const scale = typeof decimals === "number" ? decimals : Number.parseInt(decimals, 10);
  if (!Number.isInteger(scale) || scale < 0 || scale > 255) return text;
  if (!/^[0-9]+$/.test(text)) return text;
  return formatUnits(BigInt(text), scale);
}

/**
 * A DISPLAY estimate. `NUMERIC` arrives from node-pg as a string; a USD
 * estimate is a display numeric (never a token amount), so a finite `number` is
 * the right shape and an unparseable value is `null`, not zero - "we do not
 * know" and "it is worth nothing" are different facts.
 *
 * A NEGATIVE estimate is also `null`. The SQL already normalizes it (see
 * `LEDGER_CTE_SQL`); this is the same decision at the driver boundary, so a
 * negative figure cannot reach a portfolio and subtract from it whichever path
 * it arrived on.
 */
function toUsdEstimate(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
