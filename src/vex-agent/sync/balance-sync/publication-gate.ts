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
 * opposite sides of a money movement. See `FENCE_SQL` for why the fence is
 * keyed on MONEY and no longer on `updated_at`.
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
 * Bounded: the ledger is a named list a human reads, and it is persisted into
 * the group record, so it cannot be allowed to grow with the money path. More
 * rows than this is reported (`InFlightLedger.truncated`), never dropped
 * silently.
 */
const MAX_IN_FLIGHT = 50;

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

/** One thing this cycle's money is currently inside. */
export type InFlightKind =
  | "agent_activity_pending"
  | "wallet_intent_live"
  | "wallet_confirmation_unknown"
  | "wallet_transaction_intent_live"
  | "wallet_transaction_confirmation_unknown"
  | "wallet_wrap_intent_live"
  | "wallet_wrap_confirmation_unknown";

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

export interface InFlightLedger {
  readonly entries: readonly InFlightEntry[];
  /**
   * More than `MAX_IN_FLIGHT` rows existed; the OLDEST were kept. Reported so
   * a consumer knows rows are missing rather than being told a short list is
   * the whole truth.
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

function standingFor(
  kind: InFlightKind,
  detail: string | null,
  ageSeconds: number,
  secondsUntilExpiry: number | null,
): InFlightStanding {
  const bound = boundFor(kind, detail);
  if (bound.rule === "own-expiry") {
    if (secondsUntilExpiry === null) {
      return ageSeconds <= bound.fallbackMaxAgeSeconds ? "in_transit" : "unresolved";
    }
    return secondsUntilExpiry > 0 ? "in_transit" : "unresolved";
  }
  return ageSeconds <= bound.maxAgeSeconds ? "in_transit" : "unresolved";
}

// ── The transition fence ─────────────────────────────────────────────────

/**
 * The activity table's MONEY generation for one wallet set. Compared by VALUE,
 * so every component is read back as a stable string rather than a
 * driver-typed `Date`/`BigInt` whose equality depends on the pg type parser.
 */
export interface ActivityFence {
  readonly maxId: string;
  readonly rowCount: string;
  readonly pendingCount: string;
  readonly confirmedCount: string;
}

interface FenceRow {
  max_id: string;
  row_count: string;
  pending_count: string;
  confirmed_count: string;
}

/**
 * WHY THESE FOUR COLUMNS, AND WHY `MAX(updated_at)` IS GONE.
 *
 * The fence must move when MONEY moves during the scan and stay still when
 * bookkeeping touches a row. `MAX(updated_at)` failed the second half: every
 * bridge sweep attempt stamps `updated_at = NOW()` on a still-pending row - the
 * candidate claim (`bridge-activity-repair-production-deps.ts`), `touchLastChecked`
 * and `clearVerificationStall` (`db/repos/agent-activity/swap-lifecycle/
 * verification-bookkeeping.ts`) all do, and the sweep runs every five minutes
 * forever on an old row. That is a pure re-check of something we already knew,
 * and it was tripping `activity_transition` on cycles where nothing moved.
 *
 * Those same three writers set ONLY `updated_at`, `last_attempted_at`,
 * `last_checked_at`, `verification_attempts`, `last_verification_*` and
 * `provider_status`; every one of them is fenced with `WHERE ... status =
 * 'pending'` and none inserts, deletes or writes `status`. So all four
 * components below are invariant under a sweep touch, by construction rather
 * than by hope.
 *
 * What each component catches:
 *   max_id           a row INSERTED during the scan (a broadcast).
 *   row_count        an insert or a delete.
 *   pending_count    any transition INTO or OUT OF the in-flight state -
 *                    which is what a settlement is.
 *   confirmed_count  a confirmation specifically, so a settle-and-broadcast
 *                    pair inside one scan (pending_count unchanged) is caught.
 *
 * The one status change invisible here is `definitively_failed` <->
 * `superseded_unproven`: a relabelling of an already-dead row, where no balance
 * moves and nothing enters or leaves flight. `status` has exactly four values
 * (migration 078), so that is the complete gap.
 */
const FENCE_SQL = `
  SELECT COALESCE(MAX(id), 0)::text                                  AS max_id,
         COUNT(*)::text                                              AS row_count,
         COUNT(*) FILTER (WHERE status = 'pending')::text            AS pending_count,
         COUNT(*) FILTER (WHERE status = 'confirmed')::text          AS confirmed_count
    FROM agent_activity
   WHERE wallet_address = ANY($1::text[])`;

/**
 * Stamp the activity generation for `walletAddresses`. Call this BEFORE the
 * scan starts; the same value is handed to the publisher so the gate can prove
 * no money moved in between.
 */
export async function readActivityFence(
  executor: Executor,
  walletAddresses: readonly string[],
): Promise<ActivityFence> {
  const res = await executor.query<FenceRow>(FENCE_SQL, [[...walletAddresses]]);
  const row = res.rows[0];
  return {
    maxId: row?.max_id ?? "0",
    rowCount: row?.row_count ?? "0",
    pendingCount: row?.pending_count ?? "0",
    confirmedCount: row?.confirmed_count ?? "0",
  };
}

export function fencesMatch(a: ActivityFence, b: ActivityFence): boolean {
  return a.maxId === b.maxId
    && a.rowCount === b.rowCount
    && a.pendingCount === b.pendingCount
    && a.confirmedCount === b.confirmedCount;
}

// ── The ledger query ─────────────────────────────────────────────────────

/**
 * Seven wallet-scoped predicates, one round trip. Each is the wallet-scoped
 * reading of the correspondingly named predicate in
 * `db/repos/approval-intents/money-state.ts`; which rows count as live is that
 * module's decision, deliberately not re-derived here. What is NEW is that each
 * branch also carries WHAT the money is.
 *
 *  1. `agent_activity` PENDING - a broadcast awaiting confirmation. For a
 *     `bridge_fill_expected` row the money in transit is the EXPECTED OUTPUT
 *     (`amount_out_human` / `token_out_symbol` / `usd_out_est`): the input has
 *     already left the wallet and the balance read no longer contains it. For
 *     every other role the input leg is the amount in transit.
 *  2. `wallet_intents` `consuming`, or `pending` that has NOT expired. `amount`
 *     is the human quantity the user approved and `token` its symbol.
 *  3. `wallet_intents` hash-carrying rows in a state that does not prove an
 *     outcome. A legacy `failed`-with-hash row releases ONLY when its linked
 *     activity proves a mined revert.
 *  4/5. `wallet_transaction_intents` (migration 087) - a GENERIC calldata
 *     proposal, so the table carries no amount or asset at all and the ledger
 *     honestly reports nulls rather than inventing a figure from the payload.
 *  6/7. `wallet_wrap_intents` (migration 096). Its amount is base units
 *     (`amount_raw`) with `wrapped_native_decimals`; the conversion happens in
 *     TypeScript through viem's `formatUnits`, never in floating-point SQL.
 *
 * `expires_at` is selected wherever the table has it; `STANDING_BOUNDS` alone
 * decides whether the standing rule uses it.
 */
const IN_FLIGHT_SQL = `
  SELECT * FROM (
  SELECT 'agent_activity_pending'::text AS kind, a.id::text AS ref,
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

  SELECT 'wallet_intent_live', w.intent_id::text, w.status::text, w.created_at,
         w.expires_at, w.amount, NULL::smallint, w.token, NULL::numeric
    FROM wallet_intents w
   WHERE w.wallet_address = ANY($1::text[])
     AND (w.status = 'consuming' OR (w.status = 'pending' AND w.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_confirmation_unknown', w.intent_id::text, w.status::text, w.created_at,
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

  SELECT 'wallet_transaction_intent_live', t.intent_id::text, t.status::text, t.created_at,
         t.expires_at, NULL::text, NULL::smallint, NULL::text, NULL::numeric
    FROM wallet_transaction_intents t
   WHERE t.wallet_address = ANY($1::text[])
     AND (t.status IN ('consuming', 'broadcast_unconfirmed')
          OR (t.status = 'pending' AND t.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_transaction_confirmation_unknown', t.intent_id::text, t.status::text, t.created_at,
         t.expires_at, NULL::text, NULL::smallint, NULL::text, NULL::numeric
    FROM wallet_transaction_intents t
   WHERE t.wallet_address = ANY($1::text[])
     AND t.tx_hash IS NOT NULL
     AND t.status NOT IN ('executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed')

   UNION ALL

  SELECT 'wallet_wrap_intent_live', w2.intent_id::text, w2.status::text, w2.created_at,
         w2.expires_at, w2.amount_raw, w2.wrapped_native_decimals,
         w2.wrapped_native_symbol, NULL::numeric
    FROM wallet_wrap_intents w2
   WHERE w2.wallet_address = ANY($1::text[])
     AND (w2.status IN ('consuming', 'broadcast_unconfirmed', 'review_required')
          OR (w2.status = 'pending' AND w2.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_wrap_confirmation_unknown', w2.intent_id::text, w2.status::text, w2.created_at,
         w2.expires_at, w2.amount_raw, w2.wrapped_native_decimals,
         w2.wrapped_native_symbol, NULL::numeric
    FROM wallet_wrap_intents w2
   WHERE w2.wallet_address = ANY($1::text[])
     AND w2.tx_hash IS NOT NULL
     AND w2.status NOT IN (
           'executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed', 'review_required'
         )
  ) ledger
   ORDER BY since ASC, ref ASC
   LIMIT $2`;

interface LedgerRow {
  kind: InFlightKind;
  ref: string;
  detail: string | null;
  since: Date | string | null;
  expires_at: Date | string | null;
  amount_text: string | null;
  amount_decimals: number | string | null;
  symbol: string | null;
  usd_est: string | number | null;
}

/**
 * Read everything this cycle's money is currently inside, INSIDE the caller's
 * transaction and AFTER the caller has taken the activity table lock. Read
 * outside that lock the answer is stale the instant it returns - hence the
 * required `Executor`.
 *
 * `MAX_IN_FLIGHT + 1` rows are requested so an overflow is DETECTED rather than
 * inferred; the extra row is dropped and `truncated` says so.
 */
export async function readInFlightMoney(
  executor: Executor,
  walletAddresses: readonly string[],
  now: number = Date.now(),
): Promise<InFlightLedger> {
  if (walletAddresses.length === 0) return { entries: [], truncated: false };
  const res = await executor.query<LedgerRow>(IN_FLIGHT_SQL, [
    [...walletAddresses],
    MAX_IN_FLIGHT + 1,
  ]);
  const truncated = res.rows.length > MAX_IN_FLIGHT;
  const kept = truncated ? res.rows.slice(0, MAX_IN_FLIGHT) : res.rows;
  return {
    entries: kept.map((row) => toEntry(row, now)),
    truncated,
  };
}

function toEntry(row: LedgerRow, now: number): InFlightEntry {
  const ageSeconds = toAgeSeconds(row.since, now);
  const expiresAtMs = toEpochMs(row.expires_at);
  const secondsUntilExpiry =
    expiresAtMs === null ? null : Math.floor((expiresAtMs - now) / 1000);
  return {
    kind: row.kind,
    ref: row.ref,
    detail: row.detail,
    standing: standingFor(row.kind, row.detail, ageSeconds, secondsUntilExpiry),
    ageSeconds,
    amountHuman: toHumanAmount(row.amount_text, row.amount_decimals),
    symbol: row.symbol,
    usdEstimate: toUsdEstimate(row.usd_est),
  };
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
 */
function toUsdEstimate(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toEpochMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toAgeSeconds(since: Date | string | null, now: number): number {
  const ms = toEpochMs(since);
  if (ms === null) return 0;
  return Math.max(0, Math.floor((now - ms) / 1000));
}
