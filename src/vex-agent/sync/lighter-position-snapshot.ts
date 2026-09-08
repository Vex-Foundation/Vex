/**
 * THE LIGHTER POSITION SNAPSHOT SWEEP.
 *
 * A fill says what Vex did. A position says where the ACCOUNT stands, and the
 * two are not the same statement: an account can hold a position Vex never
 * opened, and no sum over Vex-authored fills can ever produce the account's
 * real exposure. So the snapshot is reported as what it is - an OBSERVATION of
 * an account-wide state at a moment, client-reported, never verified - and it
 * is labelled that way everywhere it is displayed: "Account position on
 * Lighter, observed <time>; may include activity outside Vex."
 *
 * ## Why it is not an event
 *
 * An event is a thing that happened, with a transaction and an economic
 * lifecycle. An observation is a reading of a state. Modelling the second as
 * the first is how a read model ends up double-counting a position as volume,
 * so the snapshot is a projection with its own tables (migration 152) and
 * never enters the activity ledger.
 *
 * ## Freshness, and the resurrection this design prevents
 *
 * Observations arrive out of order: a sweep that took longer than the next
 * one, a replay, a backfill after downtime. Freshness is therefore compared
 * WITHOUT the observation's own identity (H0 revision 2, correction 2), and
 * at TWO levels, because one is provably not enough.
 *
 * PER MARKET: `lighter_position_market_state` is keyed by (environment,
 * account, market) and carries the observed_at of the newest observation that
 * spoke for that market, open or closed. An older observation updates nothing.
 *
 * PER SCOPE: `lighter_position_sweep_state.complete_watermark_at` carries the
 * observed_at of the newest COMPLETE observation whose coverage was "all".
 * That observation spoke for every market on the account, including markets it
 * never listed - and those markets have no row of their own to refuse a late
 * backfill with. Three histories the market table alone gets wrong, all three
 * pinned in `src/__tests__/integration/repos/lighter-position-observations.int.test.ts`:
 *
 *   1. an EMPTY complete observation at 12:00 writes no market row at all;
 *      an 11:00 backfill listing an open position then inserts it as open and
 *      a closed position has resurrected.
 *   2. a position closed at 10:00, an empty complete observation at 12:00,
 *      then the same 11:00 backfill: same resurrection.
 *   3. a COMPLETE observation whose coverage lists only market 1 closes
 *      market 2, which it never read.
 *
 * The watermark closes 1 and 2 by refusing every observation older than it for
 * the whole scope. Scoping the closure to the observation's own COVERAGE
 * closes 3: a coverage list closes only the markets on that list, and only a
 * coverage of "all" may close a market it did not mention.
 *
 * A CLOSURE KEEPS ITS MARKER. When a complete observation reports no position
 * in a market, the row stays with `open = FALSE` and the new observed_at
 * rather than being deleted - because a deleted row is indistinguishable from
 * a market never seen, and the next late backfill would happily resurrect the
 * position it closed. An EMPTY complete observation is the sharpest case of
 * this and is a real, meaningful fact: the account has no open positions.
 *
 * An INCOMPLETE observation (a truncated page, a failed read) updates only the
 * markets it lists and never infers a closure from an absence, because an
 * absence in an incomplete reading is exactly what it says: unknown.
 *
 * ## Boundedness, and the fairness the bound needs
 *
 * A fixed number of scopes per sweep, and the report says how many were left
 * (`hasMore`, `remainingScopes`) rather than silently doing part of the work.
 * The next sweep continues; nothing is dropped.
 *
 * ORDERING BY THE LAST SUCCESS STARVES, which is the whole reason
 * `lighter_position_sweep_state` carries an attempt marker. Five scopes that
 * always fail - no credential in the vault, a provider error - never get a
 * last-observation time, so they sort first forever and fill every bounded
 * sweep; a sixth healthy account is then never observed at all. The queue is
 * ordered by the last ATTEMPT instead, and the marker is written for every
 * attempt whatever it produced. It is written BEFORE the provider read as
 * well, so a sweep that dies mid-scope has still moved that scope to the tail
 * rather than leaving it to block every sweep after it.
 *
 * ## Credentials
 *
 * A scope is observed only while this install can still resolve a read-only
 * account credential for it. The account endpoint would answer a public read
 * by index, so this gate is not about the endpoint: it is about AUTHORITY to
 * observe. An account whose credential is gone is an account this install no
 * longer holds, and continuing to publish observations of it would be
 * reporting on somebody else's trading.
 */

import { randomUUID } from "node:crypto";

import { query, withTransaction } from "@vex-agent/db/client.js";
import { getLighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterAccountPosition } from "@tools/lighter/types.js";
import { resolveLighterReadOnlyAccountAuth } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import {
  resolveLighterMarketAssets,
  type LighterFillObservationDeps,
} from "@vex-agent/tools/protocols/lighter/fill-observation.js";
import type { LighterPositionObservationPayload } from "../agentscan/client.js";
import logger from "@utils/logger.js";

/**
 * Scopes observed per sweep. Five matches the withdrawal repair's own bound
 * and keeps one sweep inside the provider's documented request budget; the
 * cadence below then covers a realistic install (one or two accounts) many
 * times over.
 */
export const LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP = 5;

/** An onboarded Lighter account this install holds. */
export interface LighterSnapshotScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}

/**
 * What one attempt on one scope produced. Written to the attempt marker
 * whatever it is: the queue is ordered by attempt, not by success.
 *
 * `attempted` is the marker written before the provider read and overwritten
 * by one of the other three afterwards; a row still carrying it is a sweep
 * that died mid-scope.
 */
export type LighterSnapshotAttemptResult =
  | "attempted"
  | "no_credential"
  | "provider_unavailable"
  | "observed";

export interface LighterPositionSnapshotReport {
  readonly examined: number;
  readonly observed: number;
  readonly awaitingVault: number;
  readonly errors: number;
  readonly lastError: string | null;
  /** TRUE when scopes were left for the next sweep. Never a silent partial result. */
  readonly hasMore: boolean;
  /** How many scopes this sweep did not reach. */
  readonly remainingScopes: number;
}

/**
 * The onboarded scopes, oldest observation first, plus the total so the sweep
 * can report what it left behind.
 *
 * ORDERED BY THE LAST ATTEMPT, NULLS FIRST - never by the last observation. A
 * scope that always fails has no observation and would sort first forever
 * under a success ordering, and five such scopes fill every sweep of five.
 *
 * READ-ONLY PROJECTION, and it belongs to the onboarding repo rather than
 * here: `db/repos/lighter-onboarding-workflows.ts` is the owner of that table
 * and is gaining bounded list queries in the stream/recovery lane. Until that
 * lands this sweep reads it directly rather than blocking on it; the query is
 * a plain projection with no policy in it, and moving it is a one-line change.
 */
async function listSnapshotScopes(
  limit: number,
): Promise<{ scopes: readonly LighterSnapshotScope[]; total: number }> {
  const rows = await query<{
    environment: string;
    account_index: string | number;
    total: string | number;
  }>(
    `WITH scopes AS (
       SELECT w.environment, w.resolved_account_index AS account_index
         FROM lighter_onboarding_workflows w
         JOIN lighter_integration_settings s
           ON s.environment = w.environment AND s.wallet_address = w.wallet_address
        WHERE w.resolved_account_index IS NOT NULL AND s.enabled
        GROUP BY w.environment, w.resolved_account_index
     )
     SELECT scopes.environment,
            scopes.account_index,
            (SELECT COUNT(*) FROM scopes) AS total
       FROM scopes
       LEFT JOIN lighter_position_sweep_state sweep
              ON sweep.environment = scopes.environment
             AND sweep.account_index = scopes.account_index
      ORDER BY sweep.last_attempt_at ASC NULLS FIRST, scopes.account_index ASC
      LIMIT $1`,
    [limit],
  );
  const total = rows.length === 0 ? 0 : Number(rows[0]?.total ?? 0);
  const scopes = rows.flatMap((row) => {
    const accountIndex = Number(row.account_index);
    if (row.environment !== "core" && row.environment !== "rhc") return [];
    if (!Number.isSafeInteger(accountIndex)) return [];
    return [{ environment: row.environment as LighterEnvironment, accountIndex }];
  });
  return { scopes, total };
}

/** A position as it is stored and reported: named fields only, no provider passthrough. */
export interface LighterObservedPosition {
  readonly marketIndex: number;
  readonly marketSymbol: string;
  /** Signed decimal string in base units. A short position is negative. */
  readonly size: string;
  readonly entryPrice: string | null;
  readonly unrealizedPnl: string | null;
  readonly realizedPnl: string | null;
  readonly liquidationPrice: string | null;
}

/**
 * PURE: one provider position DTO -> the position we store, or null when the
 * row carries nothing worth storing.
 *
 * PnL travels only when the provider reported it, and it is never derived: a
 * PnL computed on our side from fills alone would be wrong the moment the
 * account traded outside Vex, and funding and fee inclusion are the provider's
 * conventions, not ours. Whatever it says is stored unadjusted.
 *
 * A zero-size position is dropped: the provider returns rows for markets with
 * no exposure, and storing them as open positions would show a user positions
 * they do not have.
 */
export function projectLighterPosition(dto: LighterAccountPosition): LighterObservedPosition | null {
  const size = decimalOrNull(dto.position);
  if (size === null || isZeroDecimal(size)) return null;
  const marketIndex = Number(dto.market_id);
  if (!Number.isSafeInteger(marketIndex) || marketIndex < 0) return null;
  const signed = Number(dto.sign) < 0 ? `-${size}` : size;
  return {
    marketIndex,
    marketSymbol: typeof dto.symbol === "string" && dto.symbol.length > 0 ? dto.symbol : String(marketIndex),
    size: signed,
    entryPrice: decimalOrNull(dto.avg_entry_price),
    unrealizedPnl: signedDecimalOrNull(dto.unrealized_pnl),
    realizedPnl: signedDecimalOrNull(dto.realized_pnl),
    liquidationPrice: decimalOrNull(dto.liquidation_price),
  };
}

/** One observation, ready to be stored. */
export interface LighterPositionObservation {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly observationId: string;
  readonly observedAt: string;
  readonly coverage: "all" | readonly number[];
  readonly complete: boolean;
  readonly positions: readonly LighterObservedPosition[];
}

/**
 * Record that this scope was ATTEMPTED, with what the attempt produced.
 *
 * Called twice per scope: once with `attempted` before the provider is read,
 * and once with the settled result afterwards. The first write is what makes
 * the queue fair under a crash - the scope has already moved to the tail
 * before anything can go wrong with it - and the second is what makes the
 * marker readable, so an operator can see that five scopes are failing for
 * `no_credential` rather than inferring it from silence.
 */
export async function recordLighterSnapshotAttempt(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly result: LighterSnapshotAttemptResult;
}): Promise<void> {
  await query(
    `INSERT INTO lighter_position_sweep_state
       (environment, account_index, last_attempt_at, last_attempt_result, last_observed_at, updated_at)
     VALUES ($1, $2, NOW(), $3, CASE WHEN $3 = 'observed' THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (environment, account_index) DO UPDATE
        SET last_attempt_at = NOW(),
            last_attempt_result = EXCLUDED.last_attempt_result,
            last_observed_at = CASE
              WHEN EXCLUDED.last_attempt_result = 'observed' THEN NOW()
              ELSE lighter_position_sweep_state.last_observed_at
            END,
            updated_at = NOW()`,
    [input.environment, input.accountIndex, input.result],
  );
}

/** What storing one observation did to the durable state. */
export interface LighterPositionObservationOutcome {
  /** Market rows this observation moved. Zero is ordinary, never an error. */
  readonly marketsUpdated: number;
  /**
   * TRUE when the observation was older than the scope watermark, so a newer
   * complete reading of the whole account had already spoken for every market
   * it could have covered. The observation is still retained as a record; it
   * simply moved nothing.
   */
  readonly ignoredAsStale: boolean;
  /** TRUE when this exact observation id had already been stored. */
  readonly replayed: boolean;
}

/**
 * Store one observation and settle the freshness in ONE transaction.
 *
 * Atomic because the halves are one fact: an observation whose positions
 * landed but whose closures did not would leave the account showing exposure
 * it has just closed, and that is precisely the state a reader would act on.
 * `received_at` is server-assigned by the column default; nothing here dates
 * its own arrival.
 *
 * The order is deliberate. The scope row is created and locked FIRST, so two
 * observations of one account can never interleave their watermark reads; the
 * watermark is then compared before a single market row is touched.
 */
export async function storeLighterPositionObservation(
  observation: LighterPositionObservation,
): Promise<LighterPositionObservationOutcome> {
  const coverageAll = observation.coverage === "all";
  const coveredMarkets: readonly number[] = coverageAll ? [] : observation.coverage;
  return withTransaction(async (client) => {
    // RESERVE THE SCOPE BEFORE READING ITS WATERMARK. Without the insert there
    // is no row to lock on the first observation an install ever stores, and
    // two concurrent sweeps would both read "no watermark" and both apply.
    await client.query(
      `INSERT INTO lighter_position_sweep_state (environment, account_index)
       VALUES ($1, $2)
       ON CONFLICT (environment, account_index) DO NOTHING`,
      [observation.environment, observation.accountIndex],
    );
    const scope = await client.query<{ complete_watermark_at: Date | string | null }>(
      `SELECT complete_watermark_at
         FROM lighter_position_sweep_state
        WHERE environment = $1 AND account_index = $2
        FOR UPDATE`,
      [observation.environment, observation.accountIndex],
    );

    const inserted = await client.query(
      `INSERT INTO lighter_position_observations
         (environment, account_index, observation_id, observed_at, source, coverage_markets, complete, positions)
       VALUES ($1, $2, $3, $4::timestamptz, 'account_endpoint', $5::jsonb, $6, $7::jsonb)
       ON CONFLICT (environment, account_index, observation_id) DO NOTHING
       RETURNING id`,
      [
        observation.environment,
        observation.accountIndex,
        observation.observationId,
        observation.observedAt,
        JSON.stringify(observation.coverage),
        observation.complete,
        JSON.stringify(observation.positions),
      ],
    );
    if (inserted.rowCount === 0) {
      return { marketsUpdated: 0, ignoredAsStale: false, replayed: true };
    }

    // THE SCOPE WATERMARK, and it is checked before anything is written. A
    // complete "all" observation spoke for EVERY market on this account, so
    // nothing older than it may move any market here - including a market it
    // never listed, which has no row of its own to defend itself with.
    const watermark = timestampOrNull(scope.rows[0]?.complete_watermark_at ?? null);
    const observedAtMs = Date.parse(observation.observedAt);
    if (watermark !== null && Number.isFinite(observedAtMs) && observedAtMs <= watermark) {
      logger.debug("sync.lighter_position_snapshot.ignored_as_stale", {
        environment: observation.environment,
        observationId: observation.observationId,
      });
      return { marketsUpdated: 0, ignoredAsStale: true, replayed: false };
    }

    let marketsUpdated = 0;
    // THE OPEN MARKETS. `observed_at <` in the conflict guard is what makes a
    // late observation a no-op rather than a rewrite: the stored row already
    // speaks for this market with a newer reading. The guard does not look at
    // `open`, so a market closed at 10:00 and reopened at 11:00 reopens.
    for (const position of observation.positions) {
      const updated = await client.query(
        `INSERT INTO lighter_position_market_state
           (environment, account_index, market_index, observed_at, observation_id, open, position, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5, TRUE, $6::jsonb, NOW())
         ON CONFLICT (environment, account_index, market_index) DO UPDATE
            SET observed_at = EXCLUDED.observed_at,
                observation_id = EXCLUDED.observation_id,
                open = TRUE,
                position = EXCLUDED.position,
                updated_at = NOW()
          WHERE lighter_position_market_state.observed_at < EXCLUDED.observed_at`,
        [
          observation.environment,
          observation.accountIndex,
          position.marketIndex,
          observation.observedAt,
          observation.observationId,
          JSON.stringify(position),
        ],
      );
      marketsUpdated += updated.rowCount ?? 0;
    }

    // THE CLOSURES, only from a COMPLETE observation and only INSIDE ITS OWN
    // COVERAGE. An incomplete reading's silence about a market means
    // "unknown", never "closed"; and a complete reading of markets 1 and 3
    // says nothing whatsoever about market 2.
    if (observation.complete) {
      const openMarketIndexes = observation.positions.map((position) => position.marketIndex);
      if (coverageAll) {
        // Coverage "all" is the only reading entitled to close a market it did
        // not mention. Already-closed rows are left alone: the scope watermark
        // this observation is about to advance is what defends them, so
        // rewriting every closed row on every sweep would be churn.
        const closed = await client.query(
          `UPDATE lighter_position_market_state
              SET observed_at = $4::timestamptz,
                  observation_id = $5,
                  open = FALSE,
                  position = NULL,
                  updated_at = NOW()
            WHERE environment = $1 AND account_index = $2
              AND observed_at < $4::timestamptz
              AND open = TRUE
              AND NOT (market_index = ANY($3::int[]))`,
          [
            observation.environment,
            observation.accountIndex,
            openMarketIndexes,
            observation.observedAt,
            observation.observationId,
          ],
        );
        marketsUpdated += closed.rowCount ?? 0;
      } else {
        // A LISTED market with no position is closed, and the marker is
        // WRITTEN rather than only updated: a market that has never had a row
        // needs one now, or the next late backfill has nothing to lose against.
        // This scope's watermark does not move for a partial coverage, so the
        // marker is the only defence these markets have.
        const closedMarkets = coveredMarkets.filter(
          (market) => !openMarketIndexes.includes(market),
        );
        for (const market of closedMarkets) {
          const closed = await client.query(
            `INSERT INTO lighter_position_market_state
               (environment, account_index, market_index, observed_at, observation_id, open, position, updated_at)
             VALUES ($1, $2, $3, $4::timestamptz, $5, FALSE, NULL, NOW())
             ON CONFLICT (environment, account_index, market_index) DO UPDATE
                SET observed_at = EXCLUDED.observed_at,
                    observation_id = EXCLUDED.observation_id,
                    open = FALSE,
                    position = NULL,
                    updated_at = NOW()
              WHERE lighter_position_market_state.observed_at < EXCLUDED.observed_at`,
            [
              observation.environment,
              observation.accountIndex,
              market,
              observation.observedAt,
              observation.observationId,
            ],
          );
          marketsUpdated += closed.rowCount ?? 0;
        }
      }
    }

    // ADVANCE THE SCOPE WATERMARK, and only for a COMPLETE reading of the
    // WHOLE account. A partial coverage never earns the right to silence the
    // markets it did not read.
    if (observation.complete && coverageAll) {
      await client.query(
        `UPDATE lighter_position_sweep_state
            SET complete_watermark_at = $3::timestamptz,
                complete_watermark_observation_id = $4,
                updated_at = NOW()
          WHERE environment = $1 AND account_index = $2
            AND (complete_watermark_at IS NULL OR complete_watermark_at < $3::timestamptz)`,
        [
          observation.environment,
          observation.accountIndex,
          observation.observedAt,
          observation.observationId,
        ],
      );
    }

    return { marketsUpdated, ignoredAsStale: false, replayed: false };
  });
}

/**
 * One bounded sweep.
 *
 * Never signs, never submits, never retries a provider call: it reads an
 * account state and writes a local projection of it. A scope that fails is
 * counted and the sweep continues, so one unreachable account cannot stop the
 * others from being observed.
 */
export async function snapshotLighterPositions(): Promise<LighterPositionSnapshotReport> {
  const { scopes, total } = await listSnapshotScopes(LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP);
  const client = getLighterClient();
  let observed = 0;
  let awaitingVault = 0;
  let errors = 0;
  let lastError: string | null = null;

  for (const scope of scopes) {
    // THE ATTEMPT MARKER GOES DOWN FIRST. A scope that dies mid-read - an
    // unhandled provider hang, a process kill - has already moved to the tail
    // of the queue, so it cannot occupy the front of every later sweep.
    await markAttempt(scope, "attempted");
    let result: LighterSnapshotAttemptResult = "provider_unavailable";
    try {
      const auth = await resolveLighterReadOnlyAccountAuth(scope.environment, scope.accountIndex);
      if (auth === null) {
        awaitingVault += 1;
        result = "no_credential";
      } else {
        const response = await client.getAccount(scope.environment, {
          by: "index",
          value: scope.accountIndex,
        });
        const account = response.accounts.find(
          (candidate) => Number(candidate.account_index ?? candidate.index) === scope.accountIndex,
        );
        // A response that did not carry this account is an INCOMPLETE reading,
        // not an empty one: reporting it as complete would close every position
        // the account holds on the strength of a page that never mentioned it.
        const positionsDto = account?.positions;
        const complete = account !== undefined && Array.isArray(positionsDto);
        const positions = (positionsDto ?? []).flatMap((dto) => {
          const projected = projectLighterPosition(dto);
          return projected === null ? [] : [projected];
        });
        const stored = await storeLighterPositionObservation({
          environment: scope.environment,
          accountIndex: scope.accountIndex,
          observationId: randomUUID(),
          observedAt: new Date().toISOString(),
          coverage: complete ? "all" : positions.map((position) => position.marketIndex),
          complete,
          positions,
        });
        observed += 1;
        result = "observed";
        logger.debug("sync.lighter_position_snapshot.observed", {
          environment: scope.environment,
          complete,
          positions: positions.length,
          marketsUpdated: stored.marketsUpdated,
          ignoredAsStale: stored.ignoredAsStale,
        });
      }
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      result = "provider_unavailable";
    }
    // SETTLE THE MARKER WITH THE REAL REASON.
    await markAttempt(scope, result);
  }

  const remainingScopes = Math.max(0, total - scopes.length);
  return {
    examined: scopes.length,
    observed,
    awaitingVault,
    errors,
    lastError,
    hasMore: remainingScopes > 0,
    remainingScopes,
  };
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function decimalOrNull(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

function signedDecimalOrNull(value: unknown): string | null {
  return typeof value === "string" && SIGNED_DECIMAL.test(value) ? value : null;
}

function isZeroDecimal(value: string): boolean {
  return /^0(\.0+)?$/.test(value);
}

/**
 * Write one attempt marker and never throw.
 *
 * The marker is bookkeeping about fairness, and a failed write must not turn
 * one scope into the whole sweep's failure - that is the same starvation the
 * marker exists to prevent, arriving through the back door. A scope whose
 * marker did not move is simply attempted again by the next sweep.
 */
async function markAttempt(
  scope: LighterSnapshotScope,
  result: LighterSnapshotAttemptResult,
): Promise<void> {
  try {
    await recordLighterSnapshotAttempt({ ...scope, result });
  } catch (error) {
    logger.warn("sync.lighter_position_snapshot.attempt_marker_failed", {
      environment: scope.environment,
      result,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A timestamp column as epoch milliseconds, or null when the column is empty. */
function timestampOrNull(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ── The wire path: which observation goes to AgentScan, and when it is settled ──

/**
 * One stored observation, ready to be projected onto the wire.
 *
 * The ledger row is the source; nothing here is re-read from the provider,
 * because the observation is a record of what was true at `observedAt` and a
 * fresh read would be a different observation.
 */
export interface StoredLighterPositionObservation {
  readonly id: number;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly observationId: string;
  readonly observedAt: string;
  readonly coverage: "all" | readonly number[];
  readonly complete: boolean;
  readonly positions: readonly LighterObservedPosition[];
}

/**
 * How many unsent observations of ONE scope a single tick may carry.
 *
 * The batch is bounded overall by its caller's limit; this second bound is
 * about FAIRNESS inside it, so an account that produced a burst of partial
 * readings cannot take every slot from the quiet accounts behind it. The rest
 * of the burst is still owed and goes out on the next tick, in the same order.
 */
const OBSERVATIONS_PER_SCOPE_PER_TICK = 4;

/**
 * The unsent observations, OLDEST FIRST WITHIN EACH SCOPE, bounded twice.
 *
 * IT USED TO TAKE THE NEWEST PER SCOPE AND NOTHING ELSE, on the reasoning that
 * an older unsent observation of the same account is superseded by
 * construction. That is only true when the newer one COVERS it. Market 1
 * observed at 12:00 and market 2 at 11:00 are two disjoint facts about the
 * same account: the 11:00 reading is still the only thing this install knows
 * about market 2, and dropping it delivered a hole. So every unsent
 * observation is a candidate, and coverage - not recency - decides what
 * replaces what, at the marker below.
 *
 * ORDER IS PART OF THE CONTRACT. Within a scope the batch is oldest-first, so
 * the marker only ever collapses backwards: a delivered observation settles
 * the older readings it covers, never a newer one it does not. Across scopes
 * the queue is ordered by each scope's OLDEST owed reading, so a busy account
 * cannot starve a quiet one - the same fairness rule the sweep's attempt
 * marker enforces upstream.
 *
 * Superseded rows are not silently dropped: {@link markLighterPositionObservationSent}
 * settles them explicitly, with `superseded` as their disposition, so the
 * table never accumulates rows that are neither owed nor accounted for.
 */
export async function listUnsentLighterPositionObservations(
  limit: number,
): Promise<readonly StoredLighterPositionObservation[]> {
  const rows = await query<{
    id: string | number;
    environment: string;
    account_index: string | number;
    observation_id: string;
    observed_at: Date | string;
    coverage_markets: unknown;
    complete: boolean;
    positions: unknown;
  }>(
    `SELECT id, environment, account_index, observation_id, observed_at,
            coverage_markets, complete, positions
       FROM (
         SELECT id, environment, account_index, observation_id, observed_at,
                coverage_markets, complete, positions,
                MIN(observed_at) OVER (PARTITION BY environment, account_index) AS scope_owed_since,
                ROW_NUMBER() OVER (
                  PARTITION BY environment, account_index
                  ORDER BY observed_at ASC, id ASC
                ) AS scope_rank
           FROM lighter_position_observations
          WHERE sent_at IS NULL
       ) owed
      WHERE scope_rank <= $2
      ORDER BY scope_owed_since ASC, environment ASC, account_index ASC, observed_at ASC, id ASC
      LIMIT $1`,
    [Math.max(1, Math.trunc(limit)), OBSERVATIONS_PER_SCOPE_PER_TICK],
  );
  return rows.flatMap((row) => {
    if (row.environment !== "core" && row.environment !== "rhc") return [];
    const accountIndex = Number(row.account_index);
    if (!Number.isSafeInteger(accountIndex)) return [];
    const coverage = readCoverage(row.coverage_markets);
    if (coverage === null) return [];
    return [{
      id: Number(row.id),
      environment: row.environment as LighterEnvironment,
      accountIndex,
      observationId: row.observation_id,
      observedAt: new Date(row.observed_at).toISOString(),
      coverage,
      complete: row.complete,
      positions: readStoredPositions(row.positions),
    }];
  });
}

/**
 * Settle one delivered observation, and every older unsent observation of the
 * same scope THAT THE DELIVERED ONE COVERS.
 *
 * ONE TRANSACTION, because the two halves are one fact: an observation marked
 * sent while its predecessors stayed owed would put them back at the head of
 * the next batch, where the server can only ignore them as stale. The
 * disposition column is what keeps the two apart honestly - `sent` means this
 * install delivered it and the server took it; `superseded` means a delivered
 * reading of the same account REPLACED it and this one never will be
 * delivered.
 *
 * ## COVERAGE, NOT RECENCY, DECIDES
 *
 * Being newer is not being a replacement. Two rules, and each one exists
 * because breaking it discards a fact this install is the only holder of:
 *
 *   - COVERAGE. A complete `all` observation read every market, so every older
 *     reading of that account is contained in it. A LIST observation read the
 *     markets it names and nothing else: it replaces only older readings whose
 *     own list is a SUBSET of it (jsonb `<@`), so market 1 at 12:00 leaves
 *     market 2 at 11:00 exactly where it was - still owed, still the only
 *     thing known about market 2.
 *   - COMPLETENESS. An incomplete reading never supersedes a complete one. A
 *     complete observation carries a fact a truncated one cannot: that the
 *     positions it lists are ALL the positions in its coverage, which is what
 *     the server closes positions on. Retiring it behind a partial reading of
 *     the same markets would silently drop that closure evidence.
 *
 * The server assigns its own `received_at` and does not return it, so nothing
 * here records a server-side arrival time it cannot know.
 */
export async function markLighterPositionObservationSent(
  observationRowId: number,
): Promise<{ readonly sent: boolean; readonly superseded: number }> {
  return withTransaction(async (client) => {
    const delivered = await client.query<{
      environment: string;
      account_index: string | number;
      observed_at: Date | string;
      coverage_markets: unknown;
      complete: boolean;
    }>(
      `UPDATE lighter_position_observations
          SET sent_at = NOW(), send_disposition = 'sent'
        WHERE id = $1 AND sent_at IS NULL
        RETURNING environment, account_index, observed_at, coverage_markets, complete`,
      [observationRowId],
    );
    const row = delivered.rows[0];
    if (row === undefined) return { sent: false, superseded: 0 };
    const superseded = await client.query(
      `UPDATE lighter_position_observations
          SET sent_at = NOW(), send_disposition = 'superseded'
        WHERE environment = $1 AND account_index = $2
          AND observed_at < $3::timestamptz
          AND sent_at IS NULL
          AND ($4::jsonb = '"all"'::jsonb OR coverage_markets <@ $4::jsonb)
          AND ($5::boolean OR NOT complete)`,
      [
        row.environment,
        row.account_index,
        new Date(row.observed_at).toISOString(),
        JSON.stringify(row.coverage_markets),
        row.complete,
      ],
    );
    return { sent: true, superseded: superseded.rowCount ?? 0 };
  });
}

function readCoverage(value: unknown): "all" | readonly number[] | null {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return null;
  const markets = value.filter((entry): entry is number => Number.isInteger(entry) && entry >= 0);
  return markets.length === value.length ? markets : null;
}

/**
 * The stored positions, read back through the SAME named fields they were
 * stored with. No spread and no passthrough: a column that grew a field this
 * build does not know must not reach the wire.
 */
function readStoredPositions(value: unknown): readonly LighterObservedPosition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const marketIndex = Number(row.marketIndex);
    if (!Number.isSafeInteger(marketIndex) || marketIndex < 0) return [];
    if (typeof row.marketSymbol !== "string" || row.marketSymbol.length === 0) return [];
    const size = signedDecimalOrNull(row.size);
    if (size === null) return [];
    return [{
      marketIndex,
      marketSymbol: row.marketSymbol,
      size,
      entryPrice: decimalOrNull(row.entryPrice),
      unrealizedPnl: signedDecimalOrNull(row.unrealizedPnl),
      realizedPnl: signedDecimalOrNull(row.realizedPnl),
      liquidationPrice: decimalOrNull(row.liquidationPrice),
    }];
  });
}

/**
 * PURE: one stored observation plus the venue's size decimals -> the wire
 * payload `POST /v1/lighter/positions` accepts.
 *
 * ALL OR NOTHING. A position whose size decimals cannot be resolved is not
 * dropped from the payload: dropping it would turn a complete observation into
 * a false one, and a complete observation is exactly what the server is
 * entitled to close positions on. The whole observation stays unsent instead,
 * and the next drain tries again.
 *
 * `accountIndex` travels as decimal digits, not a number: it is a venue
 * identity and a JSON number is not a safe container for one.
 */
export function projectLighterObservationForWire(
  observation: StoredLighterPositionObservation,
  sizeDecimalsByMarket: ReadonlyMap<number, number>,
): LighterPositionObservationPayload | null {
  const positions: LighterPositionObservationPayload["positions"][number][] = [];
  for (const position of observation.positions) {
    const sizeDecimals = sizeDecimalsByMarket.get(position.marketIndex);
    if (sizeDecimals === undefined) return null;
    positions.push({
      marketIndex: position.marketIndex,
      marketSymbol: position.marketSymbol,
      sizeDecimals,
      size: position.size,
      entryPrice: position.entryPrice,
      unrealizedPnl: position.unrealizedPnl,
      realizedPnl: position.realizedPnl,
      liquidationPrice: position.liquidationPrice,
    });
  }
  return {
    environment: observation.environment,
    accountIndex: String(observation.accountIndex),
    observationId: observation.observationId,
    observedAt: observation.observedAt,
    source: "account_endpoint",
    coverage: { markets: observation.coverage, complete: observation.complete },
    positions,
  };
}

/**
 * The size decimals every market this observation names, read through the
 * shared market cache. `null` when the provider could not describe one of
 * them - the observation then waits rather than going out incomplete.
 */
export async function readObservationSizeDecimals(
  observation: StoredLighterPositionObservation,
  deps: LighterFillObservationDeps,
): Promise<ReadonlyMap<number, number> | null> {
  const decimals = new Map<number, number>();
  for (const position of observation.positions) {
    if (decimals.has(position.marketIndex)) continue;
    try {
      const market = await resolveLighterMarketAssets(
        observation.environment,
        position.marketIndex,
        deps,
      );
      decimals.set(position.marketIndex, market.sizeDecimals);
    } catch (error) {
      logger.info("sync.lighter_position_snapshot.market_decimals_unavailable", {
        environment: observation.environment,
        marketIndex: position.marketIndex,
        reason: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  }
  return decimals;
}
