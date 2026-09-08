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
 * PER MARKET and WITHOUT the observation's own identity (Codex H0 round 2,
 * correction 2): `lighter_position_market_state` is keyed by (environment,
 * account, market) and carries the observed_at of the newest observation that
 * spoke for that market. An older observation updates nothing.
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
 * ## Boundedness
 *
 * A fixed number of scopes per sweep, and the report says how many were left
 * (`hasMore`, `remainingScopes`) rather than silently doing part of the work.
 * The next sweep continues; nothing is dropped.
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
       LEFT JOIN LATERAL (
              SELECT MAX(o.observed_at) AS last_observed_at
                FROM lighter_position_observations o
               WHERE o.environment = scopes.environment
                 AND o.account_index = scopes.account_index
            ) last ON TRUE
      ORDER BY last.last_observed_at ASC NULLS FIRST, scopes.account_index ASC
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
 * Store one observation and settle the per-market freshness in ONE
 * transaction.
 *
 * Atomic because the two halves are one fact: an observation whose positions
 * landed but whose closures did not would leave the account showing exposure
 * it has just closed, and that is precisely the state a reader would act on.
 *
 * Returns how many market rows the observation actually moved. Zero is an
 * ordinary outcome for a late observation, not an error.
 */
export async function storeLighterPositionObservation(
  observation: LighterPositionObservation,
): Promise<{ marketsUpdated: number; ignoredAsStale: boolean }> {
  return withTransaction(async (client) => {
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
    if (inserted.rowCount === 0) return { marketsUpdated: 0, ignoredAsStale: false };

    let marketsUpdated = 0;
    // THE OPEN MARKETS. `observed_at <` in the conflict guard is what makes a
    // late observation a no-op rather than a rewrite: the stored row already
    // speaks for this market with a newer reading.
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

    // THE CLOSURES, and only from a COMPLETE observation. An incomplete
    // reading's silence about a market means "unknown", never "closed".
    if (observation.complete) {
      const openMarketIndexes = observation.positions.map((position) => position.marketIndex);
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
    }

    return { marketsUpdated, ignoredAsStale: false };
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
    try {
      const auth = await resolveLighterReadOnlyAccountAuth(scope.environment, scope.accountIndex);
      if (auth === null) {
        awaitingVault += 1;
        continue;
      }
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
      const result = await storeLighterPositionObservation({
        environment: scope.environment,
        accountIndex: scope.accountIndex,
        observationId: randomUUID(),
        observedAt: new Date().toISOString(),
        coverage: complete ? "all" : positions.map((position) => position.marketIndex),
        complete,
        positions,
      });
      observed += 1;
      logger.debug("sync.lighter_position_snapshot.observed", {
        environment: scope.environment,
        complete,
        positions: positions.length,
        marketsUpdated: result.marketsUpdated,
      });
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
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
