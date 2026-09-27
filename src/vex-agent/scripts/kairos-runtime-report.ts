#!/usr/bin/env tsx
/**
 * kairos-runtime:report - where a turn's time goes, read from the runtime
 * timing tables.
 *
 * Usage: pnpm kairos-runtime:report [--since <ISO date | Nd | Nh>] [--json]
 *
 * WHY THIS EXISTS. Kairos Phase 1 records every inference attempt (including
 * failed, retried and cancelled ones), every tool dispatch and every
 * `runTurnLoop` call into `inference_attempts`, `tool_dispatch_timings` and
 * `turn_run_timings` (migration 171). Rows alone answer nothing; this script
 * turns them into the numbers Phase 2 is calibrated against: how often a round
 * burns its whole budget on reasoning and returns nothing usable, how much of
 * the prompt the provider cache serves, and the latency distribution of each
 * stage of a turn.
 *
 * READ-ONLY. Every statement is a SELECT, parameterised on the window start.
 * It does not run migrations: on a database that predates migration 171 each
 * section reports "table missing" instead of creating anything.
 *
 * WHAT TO READ WITH CARE.
 *
 * - Latency percentiles (section 3) cover COMPLETED attempts only, so a user
 *   cancel or a provider error does not drag a model's p95 around. Failed and
 *   cancelled attempts are counted, with their own median, in section 4.
 * - Section 4 separates `timeout` (a deadline or upstream timeout: the
 *   provider hung) from `aborted` (the user pressed Stop) and `error`. It is
 *   a lower bound for now: a deadline that fires mid-stream is recorded as
 *   'error' (see `MID_STREAM_TIMEOUT_NOTE`, printed with the timeout table).
 * - "By endpoint tag" groups on the OpenRouter endpoint the session was on
 *   when the attempt settled, after any failover switch. `(auto)` means no pin:
 *   OpenRouter chose, and "By serving provider" shows where it went.
 * - Both of those groupings EXCLUDE attempts with a capacity retry. Such an
 *   attempt's `total_ms` includes the time spent failing on earlier endpoints,
 *   and charging that to the endpoint that finally served would make a healthy
 *   fallback look slow. Those attempts get their own "Retry overhead" tables
 *   (any outcome, by retry reason class and by final endpoint).
 * - Section 7's pre-loop setup (`pre_loop_setup_ms`, migration 172) is the
 *   entry point's own work before the loop starts (provider/config load, lease
 *   claim, hydrate), not time spent in a queue. It is NULL for a turn whose
 *   entry point supplies no entry timestamp; its `n` counts only the turns
 *   that did. Persist time is
 *   part of the turn's total, not in addition to it.
 * - The "prompt size" breakdown buckets by absolute `prompt_tokens`. The
 *   engine's context band is relative to each model's context window, which
 *   the tables do not store, so the two are not the same axis.
 * - Every percentile is printed next to its sample count. A p99 over a handful
 *   of rows is noise; read `n` first.
 * - Section 2 prints the cache ratio twice: from `inference_attempts` (only
 *   turns recorded since the timing wiring landed) and from `usage_log` (every
 *   billed call, including compaction and other non-turn calls).
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closePool, query } from "@vex-agent/db/client.js";
import { assertExplicitDbUrl } from "@vex-agent/scripts/_preflight.js";

export const DEFAULT_SINCE = "7d";

const RELATIVE_SINCE = /^(\d+)([dh])$/;
/** Date-only or date-time ISO 8601, optionally with a zone. */
const ISO_SINCE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Resolves `--since` to the window start. Accepts `Nd` / `Nh` relative to
 * `now`, or an ISO 8601 date / date-time. Anything else throws, so a typo
 * cannot silently widen or narrow the window.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  const trimmed = value.trim();
  const relative = RELATIVE_SINCE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`--since must be a positive duration, got "${value}"`);
    }
    const unitMs = relative[2] === "d" ? 86_400_000 : 3_600_000;
    return new Date(now.getTime() - amount * unitMs);
  }
  if (ISO_SINCE.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`--since expects an ISO date or a duration like 7d or 12h, got "${value}"`);
}

export interface ReportArgs {
  readonly since: Date;
  readonly sinceLabel: string;
  readonly json: boolean;
}

export function parseArgs(argv: readonly string[], now: Date = new Date()): ReportArgs {
  let sinceLabel = DEFAULT_SINCE;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--since") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--since needs a value, e.g. --since 7d");
      }
      sinceLabel = next;
      i += 1;
    } else if (arg.startsWith("--since=")) {
      sinceLabel = arg.slice("--since=".length);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { since: parseSince(sinceLabel, now), sinceLabel, json };
}

// ── Queries ──────────────────────────────────────────────────────────

export type ColumnFormat = "text" | "int" | "ms" | "pct";

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
  readonly format: ColumnFormat;
}

export interface ReportQuery {
  readonly key: string;
  readonly section: number;
  readonly title: string;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly columns: readonly ReportColumn[];
  /** A caveat printed above the table (and carried in `--json`), whatever the result. */
  readonly note?: string;
}

/**
 * Deadline breaches that fire AFTER the first chunk are not yet recorded as
 * 'timeout': the mid-stream error path rebuilds the error through
 * `normalizeOpenRouterError`, which drops the `TimeoutError` name, so those
 * attempts land under outcome 'error'. Printed until Phase 2B fixes the
 * classification, so nobody reads the timeout count as complete.
 */
export const MID_STREAM_TIMEOUT_NOTE =
  "Deadlines that fire mid-stream (after the first chunk) are currently recorded as outcome 'error', "
  + "not 'timeout': normalizeOpenRouterError drops the TimeoutError name on that path. "
  + "Timeout counts here are a lower bound until Phase 2B.";

export const SECTION_TITLES: Readonly<Record<number, string>> = {
  1: "Empty length-capped rounds",
  2: "Prompt cache hit ratio",
  3: "Inference latency (completed attempts) and retry overhead",
  4: "Outcomes, errors and retries",
  5: "Pre-inference and prompt-stack time",
  6: "Tool dispatch duration (top 20 tools by count)",
  7: "Turn runs",
};

const col = (key: string, label: string, format: ColumnFormat): ReportColumn => ({ key, label, format });

/** The inference latency metrics, in reporting order. Fixed identifiers, never user input. */
const LATENCY_METRICS = [
  "first_chunk_ms",
  "first_semantic_ms",
  "reasoning_only_ms",
  "max_inter_chunk_gap_ms",
  "total_ms",
] as const;

const LATENCY_VALUES = LATENCY_METRICS
  .map((metric, index) => `(${index + 1}, '${metric}', a.${metric})`)
  .join(",\n        ");

/** Absolute prompt-size buckets; see the header for why this is not the context band. */
const PROMPT_SIZE_ORDER = `CASE
      WHEN a.prompt_tokens IS NULL THEN 9
      WHEN a.prompt_tokens < 16000 THEN 1
      WHEN a.prompt_tokens < 32000 THEN 2
      WHEN a.prompt_tokens < 64000 THEN 3
      WHEN a.prompt_tokens < 128000 THEN 4
      ELSE 5 END`;
const PROMPT_SIZE_LABEL = `CASE
      WHEN a.prompt_tokens IS NULL THEN 'unknown'
      WHEN a.prompt_tokens < 16000 THEN '<16k'
      WHEN a.prompt_tokens < 32000 THEN '16k-32k'
      WHEN a.prompt_tokens < 64000 THEN '32k-64k'
      WHEN a.prompt_tokens < 128000 THEN '64k-128k'
      ELSE '>=128k' END`;

const LATENCY_COLUMNS = (groupLabel: string): readonly ReportColumn[] => [
  col("grp", groupLabel, "text"),
  col("metric", "Metric", "text"),
  col("n", "n", "int"),
  col("p50", "p50", "ms"),
  col("p95", "p95", "ms"),
  col("p99", "p99", "ms"),
];

/**
 * Endpoint and serving-provider groupings drop attempts that needed a capacity
 * retry: their `total_ms` includes the time spent failing on earlier endpoints,
 * which would otherwise be charged to the endpoint that finally served. Those
 * attempts are reported on their own under "Retry overhead".
 */
const NO_CAPACITY_RETRY = " AND a.capacity_retries = 0";

function latencyQuery(
  since: Date,
  key: string,
  title: string,
  groupLabel: string,
  groupExpr: string,
  orderExpr: string,
  extraFilter = "",
): ReportQuery {
  return {
    key,
    section: 3,
    title,
    params: [since],
    columns: LATENCY_COLUMNS(groupLabel),
    sql: `SELECT grp, metric, n, pcts[1] AS p50, pcts[2] AS p95, pcts[3] AS p99
FROM (
  SELECT ${groupExpr} AS grp,
         MIN(${orderExpr}) AS grp_order,
         m.ord,
         m.metric,
         COUNT(m.v)::int AS n,
         percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY m.v) AS pcts
  FROM inference_attempts a
  CROSS JOIN LATERAL (VALUES
        ${LATENCY_VALUES}
  ) AS m(ord, metric, v)
  WHERE a.created_at >= $1 AND a.outcome = 'completed' AND m.v IS NOT NULL${extraFilter}
  GROUP BY 1, m.ord, m.metric
) s
ORDER BY grp_order, grp, ord`,
  };
}

const RETRY_OVERHEAD_COLUMNS = (groupLabel: string): readonly ReportColumn[] => [
  col("grp", groupLabel, "text"),
  col("n", "Attempts", "int"),
  col("completed", "Completed", "int"),
  col("p50", "p50 total", "ms"),
  col("p95", "p95 total", "ms"),
];

/**
 * Every statement the report runs. The window start is the only input and it
 * is always bound as `$1`; nothing from the command line is spliced into SQL.
 */
export function buildReportQueries(since: Date): ReportQuery[] {
  const p = [since] as const;
  return [
    {
      key: "empty_length_rounds",
      section: 1,
      title: "finish_reason = 'length', empty content, no valid tool call, by model",
      params: p,
      columns: [
        col("model", "Model", "text"),
        col("completed", "Completed", "int"),
        col("empty_length", "Empty length rounds", "int"),
        col("share", "Share of completed", "pct"),
      ],
      sql: `SELECT model, completed, empty_length,
       empty_length::float8 / NULLIF(completed, 0) AS share
FROM (
  SELECT COALESCE(model, '(unknown)') AS model,
         COUNT(*) FILTER (WHERE outcome = 'completed')::int AS completed,
         COUNT(*) FILTER (
           WHERE outcome = 'completed'
             AND finish_reason = 'length'
             AND content_empty IS TRUE
             AND valid_tool_call_count = 0
         )::int AS empty_length
  FROM inference_attempts
  WHERE created_at >= $1
  GROUP BY 1
) s
WHERE completed > 0
ORDER BY empty_length DESC, completed DESC, model`,
    },
    {
      key: "cache_ratio_attempts",
      section: 2,
      title: "From inference_attempts, by model",
      params: p,
      columns: [
        col("model", "Model", "text"),
        col("n", "n", "int"),
        col("prompt_tokens", "Prompt tokens", "int"),
        col("cached_tokens", "Cached tokens", "int"),
        col("ratio", "Hit ratio", "pct"),
      ],
      sql: `SELECT COALESCE(model, '(unknown)') AS model,
       COUNT(*)::int AS n,
       SUM(prompt_tokens)::float8 AS prompt_tokens,
       SUM(COALESCE(cached_tokens, 0))::float8 AS cached_tokens,
       SUM(COALESCE(cached_tokens, 0))::float8 / NULLIF(SUM(prompt_tokens), 0) AS ratio
FROM inference_attempts
WHERE created_at >= $1 AND prompt_tokens IS NOT NULL
GROUP BY 1
ORDER BY prompt_tokens DESC, model`,
    },
    {
      key: "cache_ratio_usage_log",
      section: 2,
      title: "From usage_log (every billed call), by model",
      params: p,
      columns: [
        col("model", "Model", "text"),
        col("n", "n", "int"),
        col("prompt_tokens", "Prompt tokens", "int"),
        col("cached_tokens", "Cached tokens", "int"),
        col("ratio", "Hit ratio", "pct"),
      ],
      sql: `SELECT COALESCE(model, '(unknown)') AS model,
       COUNT(*)::int AS n,
       SUM(prompt_tokens)::float8 AS prompt_tokens,
       SUM(COALESCE(cached_tokens, 0))::float8 AS cached_tokens,
       SUM(COALESCE(cached_tokens, 0))::float8 / NULLIF(SUM(prompt_tokens), 0) AS ratio
FROM usage_log
WHERE created_at >= $1
GROUP BY 1
ORDER BY prompt_tokens DESC, model`,
    },
    latencyQuery(since, "latency_by_model", "By model", "Model", "COALESCE(a.model, '(unknown)')", "0"),
    latencyQuery(
      since, "latency_by_endpoint", "By endpoint tag (attempts without capacity retries)", "Endpoint tag",
      "COALESCE(a.endpoint_tag, '(auto)')", "0", NO_CAPACITY_RETRY,
    ),
    latencyQuery(
      since, "latency_by_serving_provider", "By serving provider (attempts without capacity retries)", "Serving provider",
      "COALESCE(a.serving_provider, '(unknown)')", "0", NO_CAPACITY_RETRY,
    ),
    latencyQuery(since, "latency_by_prompt_size", "By prompt size (prompt_tokens)", "Prompt size", PROMPT_SIZE_LABEL, PROMPT_SIZE_ORDER),
    {
      key: "retry_overhead_by_class",
      section: 3,
      title: "Retry overhead by retry reason class (attempts with capacity retries, any outcome)",
      params: p,
      columns: RETRY_OVERHEAD_COLUMNS("Reason class"),
      // An attempt counts once under each DISTINCT class it retried on, so the
      // rows can sum to more than the number of attempts with retries.
      sql: `SELECT grp, n, completed, pcts[1] AS p50, pcts[2] AS p95
FROM (
  SELECT r.reason_class AS grp,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE a.outcome = 'completed')::int AS completed,
         percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY a.total_ms) AS pcts
  FROM inference_attempts a
  CROSS JOIN LATERAL (
    SELECT DISTINCT c
    FROM unnest(COALESCE(NULLIF(a.capacity_retry_classes, '{}'), ARRAY['(unknown)'])) AS u(c)
  ) AS r(reason_class)
  WHERE a.created_at >= $1 AND a.capacity_retries > 0
  GROUP BY 1
) s
ORDER BY n DESC, grp`,
    },
    {
      key: "retry_overhead_by_endpoint",
      section: 3,
      title: "Retry overhead by final endpoint tag (attempts with capacity retries, any outcome)",
      params: p,
      columns: RETRY_OVERHEAD_COLUMNS("Final endpoint tag"),
      sql: `SELECT grp, n, completed, pcts[1] AS p50, pcts[2] AS p95
FROM (
  SELECT COALESCE(a.endpoint_tag, '(auto)') AS grp,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE a.outcome = 'completed')::int AS completed,
         percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY a.total_ms) AS pcts
  FROM inference_attempts a
  WHERE a.created_at >= $1 AND a.capacity_retries > 0
  GROUP BY 1
) s
ORDER BY n DESC, grp`,
    },
    {
      key: "outcomes",
      section: 4,
      title: "Attempts by outcome and error class",
      params: p,
      columns: [
        col("outcome", "Outcome", "text"),
        col("error_class", "Error class", "text"),
        col("n", "n", "int"),
        col("p50_total_ms", "p50 total", "ms"),
      ],
      sql: `SELECT outcome,
       COALESCE(error_class, '-') AS error_class,
       COUNT(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50_total_ms
FROM inference_attempts
WHERE created_at >= $1
GROUP BY 1, 2
ORDER BY n DESC, outcome, error_class`,
    },
    {
      key: "fallback_retry_totals",
      section: 4,
      title: "Buffered fallbacks and capacity retries",
      params: p,
      columns: [
        col("attempts", "Attempts", "int"),
        col("timeouts", "Timeouts", "int"),
        col("buffered_fallbacks", "Buffered fallbacks", "int"),
        col("attempts_with_capacity_retry", "Attempts with capacity retry", "int"),
        col("capacity_retries", "Capacity retries", "int"),
      ],
      sql: `SELECT COUNT(*)::int AS attempts,
       COUNT(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts,
       COUNT(*) FILTER (WHERE buffered_fallback)::int AS buffered_fallbacks,
       COUNT(*) FILTER (WHERE capacity_retries > 0)::int AS attempts_with_capacity_retry,
       COALESCE(SUM(capacity_retries), 0)::int AS capacity_retries
FROM inference_attempts
WHERE created_at >= $1
HAVING COUNT(*) > 0`,
    },
    {
      key: "timeouts_by_endpoint",
      section: 4,
      title: "Timeouts by model and endpoint tag",
      note: MID_STREAM_TIMEOUT_NOTE,
      params: p,
      columns: [
        col("model", "Model", "text"),
        col("endpoint_tag", "Endpoint tag", "text"),
        col("attempts", "Attempts", "int"),
        col("timeouts", "Timeouts", "int"),
        col("share", "Share of attempts", "pct"),
        col("p50_timeout_ms", "p50 time to timeout", "ms"),
      ],
      sql: `SELECT model, endpoint_tag, attempts, timeouts,
       timeouts::float8 / NULLIF(attempts, 0) AS share,
       p50_timeout_ms
FROM (
  SELECT COALESCE(model, '(unknown)') AS model,
         COALESCE(endpoint_tag, '(auto)') AS endpoint_tag,
         COUNT(*)::int AS attempts,
         COUNT(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)
           FILTER (WHERE outcome = 'timeout') AS p50_timeout_ms
  FROM inference_attempts
  WHERE created_at >= $1
  GROUP BY 1, 2
) s
WHERE timeouts > 0
ORDER BY timeouts DESC, model, endpoint_tag`,
    },
    {
      key: "fallback_reasons",
      section: 4,
      title: "Buffered fallback reasons",
      params: p,
      columns: [
        col("fallback_reason", "Reason", "text"),
        col("n", "n", "int"),
      ],
      sql: `SELECT COALESCE(fallback_reason, '(unknown)') AS fallback_reason, COUNT(*)::int AS n
FROM inference_attempts
WHERE created_at >= $1 AND buffered_fallback
GROUP BY 1
ORDER BY n DESC, fallback_reason`,
    },
    {
      key: "capacity_retry_classes",
      section: 4,
      title: "Capacity retries by reason class",
      params: p,
      columns: [
        col("reason_class", "Reason class", "text"),
        col("n", "n", "int"),
      ],
      sql: `SELECT c.reason_class, COUNT(*)::int AS n
FROM inference_attempts a
CROSS JOIN LATERAL unnest(a.capacity_retry_classes) AS c(reason_class)
WHERE a.created_at >= $1
GROUP BY 1
ORDER BY n DESC, reason_class`,
    },
    {
      key: "pre_inference",
      section: 5,
      title: "All recorded attempts",
      params: p,
      columns: [
        col("metric", "Metric", "text"),
        col("n", "n", "int"),
        col("p50", "p50", "ms"),
        col("p95", "p95", "ms"),
      ],
      sql: `SELECT metric, n, pcts[1] AS p50, pcts[2] AS p95
FROM (
  SELECT m.ord, m.metric,
         COUNT(m.v)::int AS n,
         percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY m.v) AS pcts
  FROM inference_attempts a
  CROSS JOIN LATERAL (VALUES
        (1, 'pre_inference_ms', a.pre_inference_ms),
        (2, 'prompt_stack_ms', a.prompt_stack_ms)
  ) AS m(ord, metric, v)
  WHERE a.created_at >= $1 AND m.v IS NOT NULL
  GROUP BY m.ord, m.metric
) s
ORDER BY ord`,
    },
    {
      key: "tool_durations",
      section: 6,
      title: "By tool name",
      params: p,
      columns: [
        col("tool_name", "Tool", "text"),
        col("n", "n", "int"),
        col("not_success", "Failure/error", "int"),
        col("p50", "p50", "ms"),
        col("p95", "p95", "ms"),
      ],
      sql: `SELECT tool_name, n, not_success, pcts[1] AS p50, pcts[2] AS p95
FROM (
  SELECT tool_name,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE outcome <> 'success')::int AS not_success,
         percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY duration_ms) AS pcts
  FROM tool_dispatch_timings
  WHERE created_at >= $1
  GROUP BY tool_name
) s
ORDER BY n DESC, tool_name
LIMIT 20`,
    },
    {
      key: "turn_stop_reasons",
      section: 7,
      title: "By outcome and stop reason",
      params: p,
      columns: [
        col("outcome", "Outcome", "text"),
        col("stop_reason", "Stop reason", "text"),
        col("error_class", "Error class", "text"),
        col("n", "n", "int"),
      ],
      sql: `SELECT outcome,
       COALESCE(stop_reason, '-') AS stop_reason,
       COALESCE(error_class, '-') AS error_class,
       COUNT(*)::int AS n
FROM turn_run_timings
WHERE created_at >= $1
GROUP BY 1, 2, 3
ORDER BY n DESC, outcome, stop_reason, error_class`,
    },
    {
      key: "turn_totals_by_kind",
      section: 7,
      title: "Total time by session kind",
      params: p,
      columns: [
        col("session_kind", "Session kind", "text"),
        col("n", "n", "int"),
        col("p50", "p50 total", "ms"),
        col("p95", "p95 total", "ms"),
        col("p50_iterations", "p50 iterations", "int"),
      ],
      sql: `SELECT session_kind, n, pcts[1] AS p50, pcts[2] AS p95, p50_iterations
FROM (
  SELECT COALESCE(session_kind, '(unknown)') AS session_kind,
         COUNT(*)::int AS n,
         percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY total_ms) AS pcts,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY iterations) AS p50_iterations
  FROM turn_run_timings
  WHERE created_at >= $1
  GROUP BY 1
) s
ORDER BY n DESC, session_kind`,
    },
    {
      key: "turn_overheads_by_kind",
      section: 7,
      title: "Pre-loop setup and transcript persistence by session kind",
      params: p,
      columns: [
        col("session_kind", "Session kind", "text"),
        col("metric", "Metric", "text"),
        col("n", "n", "int"),
        col("p50", "p50", "ms"),
        col("p95", "p95", "ms"),
      ],
      sql: `SELECT session_kind, metric, n, pcts[1] AS p50, pcts[2] AS p95
FROM (
  SELECT COALESCE(t.session_kind, '(unknown)') AS session_kind,
         m.ord, m.metric,
         COUNT(m.v)::int AS n,
         percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY m.v) AS pcts
  FROM turn_run_timings t
  CROSS JOIN LATERAL (VALUES
        (1, 'pre_loop_setup_ms', t.pre_loop_setup_ms),
        (2, 'persist_ms', t.persist_ms)
  ) AS m(ord, metric, v)
  WHERE t.created_at >= $1 AND m.v IS NOT NULL
  GROUP BY 1, m.ord, m.metric
) s
ORDER BY session_kind, ord`,
    },
  ];
}

// ── Execution ────────────────────────────────────────────────────────

export type ResultStatus = "ok" | "missing_table" | "error";

export interface QueryResult {
  readonly key: string;
  readonly section: number;
  readonly title: string;
  readonly status: ResultStatus;
  readonly error: string | null;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly Record<string, unknown>[];
  readonly note?: string;
}

type Runner = (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>;

/** Postgres `undefined_table`: the database predates the migration. */
const PG_UNDEFINED_TABLE = "42P01";

function errorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/**
 * Runs each query independently: one failing section (a missing table, a
 * column a newer migration added) reports its own status and never stops the
 * rest of the report.
 */
export async function runReportQueries(queries: readonly ReportQuery[], run: Runner): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  for (const q of queries) {
    const base = {
      key: q.key, section: q.section, title: q.title, columns: q.columns,
      ...(q.note === undefined ? {} : { note: q.note }),
    };
    try {
      const rows = await run(q.sql, q.params);
      results.push({ ...base, status: "ok", error: null, rows });
    } catch (err) {
      const code = errorCode(err);
      if (code === PG_UNDEFINED_TABLE) {
        results.push({ ...base, status: "missing_table", error: null, rows: [] });
      } else {
        const name = err instanceof Error ? err.name : "Error";
        results.push({ ...base, status: "error", error: code ? `${name} (${code})` : name, rows: [] });
      }
    }
  }
  return results;
}

// ── Formatting ───────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatCell(value: unknown, format: ColumnFormat): string {
  if (format === "text") {
    return value === null || value === undefined ? "-" : String(value).replace(/\|/g, "\\|");
  }
  const n = toNumber(value);
  if (n === null) return "-";
  switch (format) {
    case "int":
      return Math.round(n).toLocaleString("en-US");
    case "ms":
      return `${Math.round(n).toLocaleString("en-US")} ms`;
    case "pct":
      return `${(n * 100).toFixed(1)}%`;
  }
}

/** Renders one result as a markdown table, or a one-line status when there is nothing to show. */
export function renderResult(result: QueryResult): string[] {
  const lines = [`### ${result.title}`, ""];
  if (result.note !== undefined) lines.push(`> Note: ${result.note}`, "");
  if (result.status === "missing_table") {
    lines.push("table missing (migrations not applied to this database)");
  } else if (result.status === "error") {
    lines.push(`query failed: ${result.error ?? "unknown error"}`);
  } else if (result.rows.length === 0) {
    lines.push("no data");
  } else {
    lines.push(`| ${result.columns.map((c) => c.label).join(" | ")} |`);
    lines.push(`| ${result.columns.map((c) => (c.format === "text" ? "---" : "---:")).join(" | ")} |`);
    for (const row of result.rows) {
      lines.push(`| ${result.columns.map((c) => formatCell(row[c.key], c.format)).join(" | ")} |`);
    }
  }
  lines.push("");
  return lines;
}

export function renderText(results: readonly QueryResult[], since: Date, sinceLabel: string): string {
  const lines = [
    "# Kairos runtime report",
    "",
    `Window: since ${since.toISOString()} (--since ${sinceLabel}). Percentiles are printed with their sample count n.`,
    "",
  ];
  const sections = [...new Set(results.map((r) => r.section))].sort((a, b) => a - b);
  for (const section of sections) {
    lines.push(`## ${section}. ${SECTION_TITLES[section] ?? `Section ${section}`}`, "");
    for (const result of results.filter((r) => r.section === section)) {
      lines.push(...renderResult(result));
    }
  }
  return lines.join("\n");
}

/** Numeric columns come back from pg as strings for NUMERIC/BIGINT; normalise so JSON consumers get numbers. */
function normaliseRow(row: Record<string, unknown>, columns: readonly ReportColumn[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    out[c.key] = c.format === "text" ? (row[c.key] ?? null) : toNumber(row[c.key]);
  }
  return out;
}

export interface JsonReport {
  readonly generatedAt: string;
  readonly since: string;
  readonly sinceLabel: string;
  readonly sections: ReadonlyArray<{
    readonly section: number;
    readonly title: string;
    readonly results: ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly status: ResultStatus;
      readonly error: string | null;
      readonly note?: string;
      readonly rows: ReadonlyArray<Record<string, unknown>>;
    }>;
  }>;
}

export function buildJsonReport(results: readonly QueryResult[], since: Date, sinceLabel: string, now: Date = new Date()): JsonReport {
  const sections = [...new Set(results.map((r) => r.section))].sort((a, b) => a - b);
  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    sinceLabel,
    sections: sections.map((section) => ({
      section,
      title: SECTION_TITLES[section] ?? `Section ${section}`,
      results: results
        .filter((r) => r.section === section)
        .map((r) => ({
          key: r.key,
          title: r.title,
          status: r.status,
          error: r.error,
          ...(r.note === undefined ? {} : { note: r.note }),
          rows: r.rows.map((row) => normaliseRow(row, r.columns)),
        })),
    })),
  };
}

// ── Entry point ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: ReportArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`kairos-runtime:report: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  assertExplicitDbUrl("kairos-runtime:report");

  const results = await runReportQueries(
    buildReportQueries(args.since),
    (sql, params) => query<Record<string, unknown>>(sql, [...params]),
  );
  const output = args.json
    ? JSON.stringify(buildJsonReport(results, args.since, args.sinceLabel), null, 2)
    : renderText(results, args.since, args.sinceLabel);
  process.stdout.write(`${output}\n`);
}

const invoked = process.argv[1];
const isDirectInvocation = invoked !== undefined
  && import.meta.url === pathToFileURL(realpathSync(invoked)).href;

if (isDirectInvocation) {
  main()
    .then(async () => {
      await closePool();
    })
    .catch(async (err: unknown) => {
      process.stderr.write(
        `kairos-runtime:report failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
