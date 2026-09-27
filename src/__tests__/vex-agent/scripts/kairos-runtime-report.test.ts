/**
 * Tests for src/vex-agent/scripts/kairos-runtime-report.ts.
 *
 * Coverage focus:
 *   - `--since` parsing: relative durations, ISO dates, rejection of junk
 *   - argument parsing: default window, `--since x` and `--since=x`, `--json`
 *   - query builder: read-only statements, window bound as `$1`, user input
 *     never spliced into SQL, all seven sections present
 *   - retry attribution: capacity-retried attempts stay out of endpoint and
 *     serving-provider latency and are reported as retry overhead
 *   - execution: missing tables and failing queries report per query and do
 *     not stop the rest
 *   - formatting: "no data" for empty results, populated tables, JSON shape
 *   - caveats: the mid-stream timeout note prints in text and rides in JSON
 */

import { describe, it, expect, vi } from "vitest";
import { requireValue } from "../../helpers/require-value.js";

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  closePool: vi.fn(),
  getPool: vi.fn(),
}));

const {
  DEFAULT_SINCE,
  parseSince,
  parseArgs,
  buildReportQueries,
  runReportQueries,
  formatCell,
  renderResult,
  renderText,
  buildJsonReport,
  MID_STREAM_TIMEOUT_NOTE,
} = await import("@vex-agent/scripts/kairos-runtime-report.js");

type QueryResult = Awaited<ReturnType<typeof runReportQueries>>[number];

const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY_MS = 86_400_000;

describe("parseSince", () => {
  it("resolves day and hour durations relative to now", () => {
    expect(parseSince("7d", NOW).getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
    expect(parseSince("1d", NOW).getTime()).toBe(NOW.getTime() - DAY_MS);
    expect(parseSince("12h", NOW).getTime()).toBe(NOW.getTime() - 12 * 3_600_000);
  });

  it("accepts ISO dates and date-times", () => {
    expect(parseSince("2026-09-01", NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseSince("2026-09-01T10:30:00Z", NOW).toISOString()).toBe("2026-09-01T10:30:00.000Z");
    expect(parseSince("2026-09-01T10:30:00+02:00", NOW).toISOString()).toBe("2026-09-01T08:30:00.000Z");
  });

  it.each(["", "0d", "7", "7w", "-3d", "yesterday", "2026-13-45", "7d; DROP TABLE sessions", "'; --"])(
    "rejects %j",
    (value) => {
      expect(() => parseSince(value, NOW)).toThrow(/--since/);
    },
  );
});

describe("parseArgs", () => {
  it("defaults to a 7 day text report", () => {
    const args = parseArgs([], NOW);
    expect(DEFAULT_SINCE).toBe("7d");
    expect(args.sinceLabel).toBe("7d");
    expect(args.json).toBe(false);
    expect(args.since.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it("reads --since in both spellings and --json", () => {
    expect(parseArgs(["--since", "2d", "--json"], NOW)).toMatchObject({ sinceLabel: "2d", json: true });
    expect(parseArgs(["--since=2026-09-20"], NOW).since.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("rejects a missing value and unknown flags", () => {
    expect(() => parseArgs(["--since"], NOW)).toThrow(/needs a value/);
    expect(() => parseArgs(["--since", "--json"], NOW)).toThrow(/needs a value/);
    expect(() => parseArgs(["--verbose"], NOW)).toThrow(/unknown argument/);
  });
});

describe("buildReportQueries", () => {
  const since = new Date("2026-09-20T00:00:00.000Z");
  const queries = buildReportQueries(since);

  it("covers all seven sections with unique keys", () => {
    expect([...new Set(queries.map((q) => q.section))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(queries.map((q) => q.key)).size).toBe(queries.length);
  });

  it("only issues read-only statements", () => {
    for (const q of queries) {
      expect(q.sql.trimStart()).toMatch(/^SELECT\b/);
      expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i);
    }
  });

  it("binds the window start as $1 and never interpolates it", () => {
    for (const q of queries) {
      expect(q.params).toEqual([since]);
      expect(q.sql).toMatch(/created_at >= \$1/);
      expect(q.sql).not.toMatch(/\$2/);
      expect(q.sql).not.toContain(since.toISOString());
      expect(q.sql).not.toContain("2026");
    }
  });

  it("produces identical SQL for any window, so only the parameter varies", () => {
    const other = buildReportQueries(new Date("2020-01-01T00:00:00.000Z"));
    expect(other.map((q) => q.sql)).toEqual(queries.map((q) => q.sql));
  });

  it("computes percentiles with percentile_cont over an array and reports sample counts", () => {
    expect(queries.filter((q) => q.section === 3).map((q) => q.key)).toEqual([
      "latency_by_model", "latency_by_endpoint", "latency_by_serving_provider", "latency_by_prompt_size",
      "retry_overhead_by_class", "retry_overhead_by_endpoint",
    ]);
    const latency = queries.filter((q) => q.key.startsWith("latency_by_"));
    for (const q of latency) {
      expect(q.sql).toContain("percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP");
      expect(q.sql).toContain("outcome = 'completed'");
      for (const metric of ["first_chunk_ms", "first_semantic_ms", "reasoning_only_ms", "max_inter_chunk_gap_ms", "total_ms"]) {
        expect(q.sql).toContain(`a.${metric}`);
      }
      expect(q.columns.map((c) => c.key)).toEqual(["grp", "metric", "n", "p50", "p95", "p99"]);
    }
    for (const key of ["pre_inference", "tool_durations", "turn_totals_by_kind", "turn_overheads_by_kind"]) {
      const q = requireValue(queries.find((entry) => entry.key === key));
      expect(q.sql).toContain("percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP");
      expect(q.columns.map((c) => c.key)).toContain("n");
    }
  });

  it("groups endpoint latency on the recorded endpoint tag, NULL reading as auto routing", () => {
    const q = requireValue(queries.find((entry) => entry.key === "latency_by_endpoint"));
    expect(q.sql).toContain("COALESCE(a.endpoint_tag, '(auto)')");
    const serving = requireValue(queries.find((entry) => entry.key === "latency_by_serving_provider"));
    expect(serving.sql).toContain("a.serving_provider");
  });

  it("keeps capacity-retried attempts out of the endpoint and serving-provider latency", () => {
    for (const key of ["latency_by_endpoint", "latency_by_serving_provider"]) {
      const q = requireValue(queries.find((entry) => entry.key === key));
      expect(q.sql).toContain("a.capacity_retries = 0");
      expect(q.title).toMatch(/without capacity retries/);
    }
    for (const key of ["latency_by_model", "latency_by_prompt_size"]) {
      const q = requireValue(queries.find((entry) => entry.key === key));
      expect(q.sql).not.toContain("capacity_retries");
    }
  });

  it("reports retried attempts separately, by reason class and by final endpoint", () => {
    const byClass = requireValue(queries.find((entry) => entry.key === "retry_overhead_by_class"));
    const byEndpoint = requireValue(queries.find((entry) => entry.key === "retry_overhead_by_endpoint"));
    for (const q of [byClass, byEndpoint]) {
      expect(q.section).toBe(3);
      expect(q.title).toMatch(/^Retry overhead/);
      expect(q.sql).toContain("a.capacity_retries > 0");
      // Any outcome: retry time is overhead whether or not the attempt then completed.
      expect(q.sql).not.toContain("a.outcome = 'completed' AND");
      expect(q.sql).toContain("percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY a.total_ms)");
      expect(q.columns.map((c) => c.key)).toEqual(["grp", "n", "completed", "p50", "p95"]);
    }
    // One count per distinct class per attempt; a retry with no recorded class still shows up.
    expect(byClass.sql).toContain("SELECT DISTINCT c");
    expect(byClass.sql).toContain("unnest(COALESCE(NULLIF(a.capacity_retry_classes, '{}'), ARRAY['(unknown)']))");
    expect(byEndpoint.sql).toContain("COALESCE(a.endpoint_tag, '(auto)')");
  });

  it("counts timeouts apart from aborts and errors", () => {
    const totals = requireValue(queries.find((entry) => entry.key === "fallback_retry_totals"));
    expect(totals.sql).toContain("FILTER (WHERE outcome = 'timeout')");
    expect(totals.columns.map((c) => c.key)).toContain("timeouts");
    const byEndpoint = requireValue(queries.find((entry) => entry.key === "timeouts_by_endpoint"));
    expect(byEndpoint.section).toBe(4);
    expect(byEndpoint.sql).toContain("outcome = 'timeout'");
    expect(byEndpoint.sql).toContain("COALESCE(endpoint_tag, '(auto)')");
  });

  it("attaches the mid-stream timeout caveat to the timeout table only", () => {
    const byEndpoint = requireValue(queries.find((entry) => entry.key === "timeouts_by_endpoint"));
    expect(byEndpoint.note).toBe(MID_STREAM_TIMEOUT_NOTE);
    expect(MID_STREAM_TIMEOUT_NOTE).toContain("mid-stream");
    expect(MID_STREAM_TIMEOUT_NOTE).toContain("'error'");
    expect(MID_STREAM_TIMEOUT_NOTE).toContain("normalizeOpenRouterError");
    expect(MID_STREAM_TIMEOUT_NOTE).toContain("TimeoutError");
    expect(MID_STREAM_TIMEOUT_NOTE).toContain("Phase 2B");
    expect(queries.filter((q) => q.note !== undefined).map((q) => q.key)).toEqual(["timeouts_by_endpoint"]);
  });

  it("reports queue wait and persist time percentiles per session kind, skipping NULL queue waits", () => {
    const q = requireValue(queries.find((entry) => entry.key === "turn_overheads_by_kind"));
    expect(q.section).toBe(7);
    expect(q.sql).toContain("t.queue_wait_ms");
    expect(q.sql).toContain("t.persist_ms");
    expect(q.sql).toContain("m.v IS NOT NULL");
    expect(q.columns.map((c) => c.key)).toEqual(["session_kind", "metric", "n", "p50", "p95"]);
  });

  it("limits the tool table to the 20 most frequent tools", () => {
    const q = requireValue(queries.find((entry) => entry.key === "tool_durations"));
    expect(q.sql).toMatch(/ORDER BY n DESC, tool_name\s+LIMIT 20/);
  });

  it("defines the empty length-capped round exactly", () => {
    const q = requireValue(queries.find((entry) => entry.key === "empty_length_rounds"));
    expect(q.sql).toContain("finish_reason = 'length'");
    expect(q.sql).toContain("content_empty IS TRUE");
    expect(q.sql).toContain("valid_tool_call_count = 0");
  });
});

describe("runReportQueries", () => {
  const queries = buildReportQueries(NOW).slice(0, 3);

  it("keeps going when one query fails and classifies the failure", async () => {
    const missing = Object.assign(new Error('relation "inference_attempts" does not exist'), { code: "42P01" });
    const broken = Object.assign(new Error("column secret_value does not exist"), { code: "42703" });
    const run = vi.fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(broken)
      .mockResolvedValueOnce([{ model: "m/a", n: 1, prompt_tokens: "10", cached_tokens: "5", ratio: 0.5 }]);

    const results = await runReportQueries(queries, run);

    expect(run).toHaveBeenCalledTimes(3);
    const first = requireValue(queries[0]);
    expect(run.mock.calls[0]).toEqual([first.sql, first.params]);
    expect(results.map((r) => r.status)).toEqual(["missing_table", "error", "ok"]);
    const broke = requireValue(results[1]);
    expect(broke.error).toBe("Error (42703)");
    expect(broke.error).not.toContain("secret_value");
    expect(requireValue(results[2]).rows).toHaveLength(1);
  });

  it("carries a query's note onto its result, including when the query fails", async () => {
    const timeouts = requireValue(buildReportQueries(NOW).find((q) => q.key === "timeouts_by_endpoint"));
    const missing = Object.assign(new Error("missing"), { code: "42P01" });
    const run = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce([]);
    const [failed, empty] = await runReportQueries([timeouts, timeouts], run);
    expect(requireValue(failed).note).toBe(MID_STREAM_TIMEOUT_NOTE);
    expect(requireValue(empty).note).toBe(MID_STREAM_TIMEOUT_NOTE);
    const [plain] = await runReportQueries(queries.slice(0, 1), vi.fn().mockResolvedValueOnce([]));
    expect(requireValue(plain)).not.toHaveProperty("note");
  });
});

describe("formatting", () => {
  const columns = [
    { key: "model", label: "Model", format: "text" as const },
    { key: "n", label: "n", format: "int" as const },
    { key: "p50", label: "p50", format: "ms" as const },
    { key: "share", label: "Share", format: "pct" as const },
  ];
  const result = (overrides: Partial<QueryResult>): QueryResult => ({
    key: "k",
    section: 1,
    title: "Title",
    status: "ok",
    error: null,
    columns,
    rows: [],
    ...overrides,
  });

  it("formats cells by kind and tolerates null and string numerics", () => {
    expect(formatCell("a|b", "text")).toBe("a\\|b");
    expect(formatCell(null, "text")).toBe("-");
    expect(formatCell("12345", "int")).toBe("12,345");
    expect(formatCell(1234.6, "ms")).toBe("1,235 ms");
    expect(formatCell(0.4666, "pct")).toBe("46.7%");
    expect(formatCell(null, "ms")).toBe("-");
    expect(formatCell("not a number", "int")).toBe("-");
  });

  it("prints a status line instead of a table for empty, missing and failed results", () => {
    expect(renderResult(result({}))).toContain("no data");
    expect(renderResult(result({ status: "missing_table" })).join("\n")).toMatch(/table missing/);
    expect(renderResult(result({ status: "error", error: "Error (42703)" })).join("\n")).toContain("query failed: Error (42703)");
  });

  it("prints a note above the table, and above the status line when there is no data", () => {
    const withData = renderResult(result({ note: "caveat", rows: [{ model: "m/a", n: 1, p50: 1, share: 0 }] }));
    expect(withData.slice(0, 4)).toEqual(["### Title", "", "> Note: caveat", ""]);
    expect(withData).toContain("| Model | n | p50 | Share |");
    const empty = renderResult(result({ note: "caveat" }));
    expect(empty).toEqual(["### Title", "", "> Note: caveat", "", "no data", ""]);
    expect(renderResult(result({ note: "caveat", status: "missing_table" }))).toContain("> Note: caveat");
    expect(renderResult(result({})).join("\n")).not.toContain("Note:");
  });

  it("prints the mid-stream timeout caveat in the full text report", () => {
    const results = buildReportQueries(NOW).map((q) => result({
      key: q.key, section: q.section, title: q.title, columns: q.columns,
      ...(q.note === undefined ? {} : { note: q.note }),
    }));
    const text = renderText(results, NOW, "7d");
    expect(text).toContain(`> Note: ${MID_STREAM_TIMEOUT_NOTE}`);
    const section4 = requireValue(text.split(/^## /m).find((part) => part.startsWith("4. ")));
    expect(section4).toContain(MID_STREAM_TIMEOUT_NOTE);
  });

  it("renders populated rows as a markdown table", () => {
    const lines = renderResult(result({ rows: [{ model: "m/a", n: 22, p50: 130.4, share: 0.25 }] }));
    expect(lines).toContain("| Model | n | p50 | Share |");
    expect(lines).toContain("| --- | ---: | ---: | ---: |");
    expect(lines).toContain("| m/a | 22 | 130 ms | 25.0% |");
  });

  it("renders every section of an all-empty report without throwing", () => {
    const results = buildReportQueries(NOW).map((q) => result({
      key: q.key, section: q.section, title: q.title, columns: q.columns,
    }));
    const text = renderText(results, NOW, "7d");
    for (let section = 1; section <= 7; section += 1) {
      expect(text).toMatch(new RegExp(`^## ${section}\\. `, "m"));
    }
    expect(text.match(/^no data$/gm)).toHaveLength(results.length);
    expect(text).toContain("--since 7d");
  });

  it("builds the JSON report grouped by section with numeric values", () => {
    const results: QueryResult[] = [
      result({ rows: [{ model: "m/a", n: "3", p50: 10.5, share: null, extra: "dropped" }] }),
      result({ key: "k2", section: 6, title: "Tools", status: "missing_table" }),
    ];
    const json = buildJsonReport(results, NOW, "7d", NOW);
    expect(json).toEqual({
      generatedAt: NOW.toISOString(),
      since: NOW.toISOString(),
      sinceLabel: "7d",
      sections: [
        {
          section: 1,
          title: "Empty length-capped rounds",
          results: [{ key: "k", title: "Title", status: "ok", error: null, rows: [{ model: "m/a", n: 3, p50: 10.5, share: null }] }],
        },
        {
          section: 6,
          title: "Tool dispatch duration (top 20 tools by count)",
          results: [{ key: "k2", title: "Tools", status: "missing_table", error: null, rows: [] }],
        },
      ],
    });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it("includes a result's note in the JSON report", () => {
    const json = buildJsonReport(
      [result({ key: "timeouts_by_endpoint", section: 4, note: MID_STREAM_TIMEOUT_NOTE })],
      NOW, "7d", NOW,
    );
    const entry = requireValue(requireValue(json.sections[0]).results[0]);
    expect(entry.note).toBe(MID_STREAM_TIMEOUT_NOTE);
    expect(JSON.parse(JSON.stringify(json)).sections[0].results[0].note).toBe(MID_STREAM_TIMEOUT_NOTE);
  });
});
