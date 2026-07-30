/**
 * Usage repo — inference cost tracking with cache/reasoning token breakdown.
 */

import { queryOne, execute } from "../client.js";

export interface UsageStats {
  sessionTokens: number;
  sessionCost: number;
  sessionRequestCount: number;
  sessionLastRequestAt: string | null;
  lifetimeTokens: number;
  lifetimeCost: number;
  requestCount: number;
  lastRequestAt: string | null;
}

export interface UsageEntry {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  cachedTokens?: number;
  /**
   * NET cache savings for this request (read savings − write surcharge) from
   * `computeRequestCost`. Can be NEGATIVE (write-heavy explicit-cache
   * request) — persisted truthfully. Default 0.
   */
  cachedSavings?: number;
  /** Cache-write tokens (explicit-cache models only; absent ⇒ 0). */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  provider?: string;
  model?: string;
  currency?: string;
  /**
   * Provider's own generation identifier for this request (migration 055) —
   * the only key that ties this row to OpenRouter's activity log. Already
   * length-bounded and shape-checked at the inference boundary
   * (`inference/openrouter/provider-signal.ts`); absent/unreported ⇒ NULL.
   */
  generationId?: string | null;
  /**
   * Provider's terminal reason for the completion (migration 055), e.g.
   * `stop` / `tool_calls` / `length`. An OPEN provider enum carried verbatim —
   * never switched on exhaustively here. Bounded at the inference boundary
   * (see `generationId`); absent/unreported ⇒ NULL.
   */
  finishReason?: string | null;
  /**
   * Upstream provider that actually served the request (migration 059), from
   * OpenRouter routing metadata. `provider` above is the AGGREGATOR and has
   * always been the literal `'openrouter'`, which is why per-request routing
   * was unanswerable before this column. Bounded at the inference boundary
   * (`openrouter/provider-signals.ts`); absent/unreported ⇒ NULL.
   */
  servingProvider?: string | null;
}

export async function logUsage(sessionId: string, entry: UsageEntry): Promise<void> {
  const totalTokens = entry.promptTokens + entry.completionTokens;
  await execute(
    `INSERT INTO usage_log (session_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost, provider, model, currency, cached_savings, cache_write_tokens, generation_id, finish_reason, serving_provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [sessionId, entry.promptTokens, entry.completionTokens, totalTokens,
     entry.cachedTokens ?? 0, entry.reasoningTokens ?? 0, entry.cost,
     entry.provider ?? null, entry.model ?? null, entry.currency ?? "USD",
     entry.cachedSavings ?? 0, entry.cacheWriteTokens ?? 0,
     entry.generationId ?? null, entry.finishReason ?? null,
     entry.servingProvider ?? null],
  );
}

export async function getStats(sessionId?: string, currency?: string): Promise<UsageStats> {
  const currencyClause = currency ? " WHERE currency = $1" : "";
  const currencyParams = currency ? [currency] : [];

  const lifetime = await queryOne<{ tokens: string; cost: string; count: string; last: string | null }>(
    `SELECT COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost),0) AS cost, COUNT(*) AS count, MAX(created_at) AS last FROM usage_log${currencyClause}`,
    currencyParams,
  );

  let sessionTokens = 0;
  let sessionCost = 0;
  let sessionRequestCount = 0;
  let sessionLastRequestAt: string | null = null;
  if (sessionId) {
    const sessionClause = currency ? " AND currency = $2" : "";
    const sessionParams = currency ? [sessionId, currency] : [sessionId];
    const session = await queryOne<{ tokens: string; cost: string; count: string; last: string | null }>(
      `SELECT COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost),0) AS cost, COUNT(*) AS count, MAX(created_at) AS last FROM usage_log WHERE session_id = $1${sessionClause}`,
      sessionParams,
    );
    sessionTokens = parseInt(session?.tokens ?? "0", 10);
    sessionCost = parseFloat(session?.cost ?? "0");
    sessionRequestCount = parseInt(session?.count ?? "0", 10);
    sessionLastRequestAt = session?.last ?? null;
  }

  return {
    sessionTokens,
    sessionCost,
    sessionRequestCount,
    sessionLastRequestAt,
    lifetimeTokens: parseInt(lifetime?.tokens ?? "0", 10),
    lifetimeCost: parseFloat(lifetime?.cost ?? "0"),
    requestCount: parseInt(lifetime?.count ?? "0", 10),
    lastRequestAt: lifetime?.last ?? null,
  };
}
