/**
 * Indexify creators handler — leaderboard, or one creator's profile+metrics.
 */

import { getIndexifyClient } from "@tools/indexify/client.js";
import type { IndexifyLeaderboardPeriod, IndexifyLeaderboardSort } from "@tools/indexify/constants.js";
import {
  INDEXIFY_LEADERBOARD_PERIODS,
  INDEXIFY_LEADERBOARD_SORTS,
  INDEXIFY_LIST_LIMIT_CAP,
} from "@tools/indexify/constants.js";
import { ok, fail, str } from "../../handler-helpers.js";
import { readEnum, readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { indexifyFailureDetail } from "./failure.js";

const CREATORS_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: INDEXIFY_LIST_LIMIT_CAP },
  offset: { domain: "nonNegative", integer: true },
};

const DEFAULT_LIMIT = 10;

export async function indexifyCreatorsHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const username = str(p, "username").trim();
  if (username) {
    // The atMostOne groups already refused username+ranking combinations at
    // the boundary; this branch is pure profile read.
    try {
      const client = getIndexifyClient();
      const [profile, metrics] = await Promise.all([
        client.publicProfile(username, { signal: context.abortSignal }),
        client.profileMetrics(username, { signal: context.abortSignal }),
      ]);
      return ok({
        creator: {
          username: profile.username,
          bio: profile.bio,
          joinedAt: profile.created_at,
          twitter: profile.twitter,
          telegram: profile.telegram,
        },
        metrics: {
          bestStackAthPercent: metrics.best_stack_ath ?? null,
          hitRate: metrics.hit_rate ?? null,
          combinedPnl: metrics.combined_pnl ?? null,
          followers: metrics.followers ?? null,
          stackCount: metrics.stack_count ?? null,
          points: metrics.points ?? null,
        },
      });
    } catch (err) {
      return fail(`Indexify creator profile unavailable (${indexifyFailureDetail("indexify__creators_list", err)})`);
    }
  }

  const metricRead = readEnum<IndexifyLeaderboardSort>(p, "metric", INDEXIFY_LEADERBOARD_SORTS, "points");
  if (!metricRead.ok) return fail(metricRead.reason);
  const periodRead = readEnum<IndexifyLeaderboardPeriod>(p, "period", INDEXIFY_LEADERBOARD_PERIODS, "7d");
  if (!periodRead.ok) return fail(periodRead.reason);
  const limitRead = readNumber(p, "limit", CREATORS_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const offsetRead = readNumber(p, "offset", CREATORS_NUMERIC_PARAMS);
  if (!offsetRead.ok) return fail(offsetRead.reason);

  try {
    const rows = await getIndexifyClient().leaderboard(
      {
        period: periodRead.value,
        sortBy: metricRead.value,
        limit: limitRead.value ?? DEFAULT_LIMIT,
        offset: offsetRead.value ?? 0,
      },
      { signal: context.abortSignal },
    );
    return ok({
      metric: metricRead.value,
      period: periodRead.value,
      count: rows.length,
      creators: rows.map((row) => ({
        rank: row.rank ?? null,
        username: row.username,
        points: row.points ?? null,
        combinedPnl: row.combined_pnl ?? null,
        stacksCreated: row.stacks_created ?? null,
        stackTrades: row.stack_trades ?? null,
        followers: row.follower_count ?? null,
      })),
    });
  } catch (err) {
    return fail(`Indexify leaderboard unavailable (${indexifyFailureDetail("indexify__creators_list", err)})`);
  }
}
