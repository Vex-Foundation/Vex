/**
 * compaction-preparation-db tests — app-scope isolation, the column allowlist,
 * and the schema-readiness probe.
 *
 * `pg.Client` and `buildPoolConfig` are mocked (mirroring
 * `compaction-db.test.ts`) so this pins the contract without a live Postgres.
 * The load-bearing assertion is the allowlist: the query must never SELECT the
 * frozen conversation corpus, the model-authored summary, or the free-text
 * error column — readiness crosses as a boolean.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const queryMock = vi.fn();
const endMock = vi.fn();

vi.mock("pg", () => ({
  Client: class {
    connect = connectMock;
    query = queryMock;
    end = endMock;
  },
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: vi.fn(async () => ({
    host: "localhost",
    port: 5432,
    database: "vex",
    user: "vex",
    password: "pw",
  })),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { getCompactionPreparation, probeCompactionPreparationsReady } =
  await import("../compaction-preparation-db.js");
const { VEX_APP_SESSION_SCOPE } = await import("@shared/schemas/sessions.js");

const SESSION = "00000000-0000-4000-8000-00000000bb01";
const CORR = "corr-1";
const ISO = "2026-07-29T10:00:00.000Z";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "summary_ready",
    summary_status: "succeeded",
    chunks_status: "pending",
    summary_attempt_count: 1,
    summary_max_attempts: 3,
    chunks_attempt_count: 0,
    chunks_max_attempts: 3,
    has_summary: true,
    apply_source: null,
    apply_requested_at: null,
    applied_at: null,
    created_at: ISO,
    completed_at: null,
    ...over,
  };
}

afterEach(() => {
  connectMock.mockReset();
  queryMock.mockReset();
  endMock.mockReset();
});

describe("getCompactionPreparation (app-scoped)", () => {
  it("returns null for an unknown/foreign-scope/soft-deleted session and scopes the query", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [] });
    endMock.mockResolvedValue(undefined);

    const res = await getCompactionPreparation(SESSION, CORR);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBeNull();

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("s.scope = $2");
    expect(sql).toContain("s.deleted_at IS NULL");
    expect(params).toEqual([SESSION, VEX_APP_SESSION_SCOPE]);
  });

  it("NEVER selects the corpus, the summary text, or the error prose", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [row()] });
    endMock.mockResolvedValue(undefined);

    await getCompactionPreparation(SESSION, CORR);

    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).not.toContain("*");
    expect(sql).not.toContain("cp.corpus");
    expect(sql).not.toContain("cp.last_error");
    // The only mention of the summary column is the boolean readiness probe.
    expect(sql).toContain("(cp.summary_output IS NOT NULL) AS has_summary");
    expect(sql.match(/summary_output/g)).toHaveLength(1);
  });

  it("maps the allowlisted row to the bounded DTO", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({
      rows: [row({ summary_attempt_count: "2", created_at: new Date(ISO) })],
    });
    endMock.mockResolvedValue(undefined);

    const res = await getCompactionPreparation(SESSION, CORR);
    expect(res.ok).toBe(true);
    if (!res.ok || res.data === null) throw new Error("expected a DTO");
    expect(res.data.sessionId).toBe(SESSION);
    expect(res.data.status).toBe("summary_ready");
    expect(res.data.summaryAttemptCount).toBe(2);
    expect(res.data.hasSummary).toBe(true);
    expect(res.data.createdAt).toBe(ISO);
    expect(Object.keys(res.data)).not.toContain("lastError");
  });

  it("a row with an unknown status is a redacted error, not an unvalidated DTO", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "teleporting" })] });
    endMock.mockResolvedValue(undefined);

    const res = await getCompactionPreparation(SESSION, CORR);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal.unexpected");
      expect(res.error.domain).toBe("compaction");
      expect(res.error.redacted).toBe(true);
      expect(res.error.correlationId).toBe(CORR);
    }
  });
});

describe("probeCompactionPreparationsReady", () => {
  it("is true only when the table exists", async () => {
    connectMock.mockResolvedValue(undefined);
    endMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({
      rows: [{ reg: "compaction_preparations" }],
    });
    expect(await probeCompactionPreparationsReady()).toBe(true);
  });

  it("is false when migration 058 has not been applied", async () => {
    connectMock.mockResolvedValue(undefined);
    endMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [{ reg: null }] });
    expect(await probeCompactionPreparationsReady()).toBe(false);
  });

  it("fails closed when Postgres is unreachable", async () => {
    connectMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await probeCompactionPreparationsReady()).toBe(false);
  });
});
