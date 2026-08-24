/**
 * memory-inspector-db tests (memory-system S10) — sanitization + filters +
 * bounded queries + the missing-table error contract.
 *
 * `pg.Client` + `buildPoolConfig` are mocked. Critical pins:
 *  - the SELECTs never reference a sanitized column (`content_md`,
 *    `evidence_refs`, `decision_hash`, embeddings, `last_error`,
 *    `locked_by`/`locked_at`/`heartbeat_at`) so those never leave main;
 *  - a missing table (42P01, pre-migration) maps to the redacted RETRYABLE
 *    "Database unavailable" error — NEVER ok([]).
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

const { listInspectorCandidates, listInspectorDecisions, getJobsSummary } =
  await import("../memory-inspector-db.js");

const ISO = "2026-05-21T10:00:00.000Z";
const UUID = "00000000-0000-4000-8000-0000000000c1";

const FORBIDDEN_CANDIDATE_COLUMNS = [
  "content_md",
  "source_refs",
  "evidence_refs",
  "outcome",
  "content_hash",
  "embedding",
  "session_id",
  "proposed_by",
  "retain_until",
  "retrieval_until",
];
const FORBIDDEN_DECISION_COLUMNS = ["evidence_refs", "decision_hash"];
const FORBIDDEN_JOB_COLUMNS = [
  "last_error",
  "locked_by",
  "locked_at",
  "heartbeat_at",
];

function undefinedTableError(): Error & { code: string } {
  const e = new Error('relation "memory_candidates" does not exist') as Error & {
    code: string;
  };
  e.code = "42P01";
  return e;
}

afterEach(() => {
  connectMock.mockReset();
  queryMock.mockReset();
  endMock.mockReset();
});

describe("listInspectorCandidates", () => {
  it("never SELECTs a sanitized column and maps a row", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: UUID,
          kind: "risk_rule",
          title: "Avoid X",
          summary: "Short summary",
          tags: ["risk"],
          source: "observed",
          confidence: 0.8,
          importance: 5,
          sensitivity: "normal",
          evidence_strength: "weak",
          retrieval_visibility: "not_consolidated",
          status: "pending",
          recorded_at: ISO,
          promoted_knowledge_id: null,
          created_at: ISO,
          updated_at: ISO,
        },
      ],
    });
    endMock.mockResolvedValue(undefined);

    const res = await listInspectorCandidates({ limit: 100 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toEqual({
        id: UUID,
        kind: "risk_rule",
        title: "Avoid X",
        summary: "Short summary",
        tags: ["risk"],
        source: "observed",
        confidence: 0.8,
        importance: 5,
        sensitivity: "normal",
        evidenceStrength: "weak",
        retrievalVisibility: "not_consolidated",
        status: "pending",
        recordedAt: ISO,
        promotedKnowledgeId: null,
        createdAt: ISO,
        updatedAt: ISO,
      });
    }

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    for (const col of FORBIDDEN_CANDIDATE_COLUMNS) {
      expect(sql, col).not.toContain(col);
    }
    expect(sql).toContain("FROM memory_candidates");
    // Inspector view: newest-first by ingestion time, NOT the worker FIFO.
    expect(sql).toContain("ORDER BY recorded_at DESC, id DESC");
  });

  it("applies the status filter as a bound parameter", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [] });
    endMock.mockResolvedValue(undefined);

    await listInspectorCandidates({ status: "promoted", limit: 50 });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE status = $1");
    expect(params).toEqual(["promoted", 50]);
  });

  it("coerces an unknown source to null and defaults null tags to []", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: UUID,
          kind: "k",
          title: "t",
          summary: "s",
          tags: null,
          source: "weird_legacy_value",
          confidence: null,
          importance: 5,
          sensitivity: "normal",
          evidence_strength: "none",
          retrieval_visibility: "not_consolidated",
          status: "pending",
          recorded_at: ISO,
          promoted_knowledge_id: 9,
          created_at: ISO,
          updated_at: ISO,
        },
      ],
    });
    endMock.mockResolvedValue(undefined);

    const res = await listInspectorCandidates({ limit: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.source).toBeNull();
      expect(res.data[0]?.tags).toEqual([]);
      expect(res.data[0]?.promotedKnowledgeId).toBe(9);
    }
  });

  it("maps a missing table (42P01) to the retryable dbUnavailable error - never ok([])", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockRejectedValueOnce(undefinedTableError());
    endMock.mockResolvedValue(undefined);

    const res = await listInspectorCandidates({ limit: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal.unexpected");
      expect(res.error.domain).toBe("memory");
      expect(res.error.retryable).toBe(true);
      expect(res.error.message).toContain("Database unavailable");
    }
  });
});

describe("listInspectorDecisions", () => {
  it("never SELECTs evidence_refs/decision_hash and maps a row (bigint id stays a string)", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "42",
          candidate_id: UUID,
          reconcile_entry_id: null,
          job_id: 7,
          decision_version: 0,
          decision_type: "promote",
          reject_reason: null,
          promoted_knowledge_id: 12,
          supersedes_knowledge_id: null,
          merge_target_knowledge_id: null,
          outcome_version: null,
          inference_provider: "openrouter",
          inference_model: "m",
          cost_usd: "0.0100",
          decided_by: "manager",
          decided_at: ISO,
        },
      ],
    });
    endMock.mockResolvedValue(undefined);

    const res = await listInspectorDecisions({ limit: 100 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toEqual({
        id: "42",
        candidateId: UUID,
        reconcileEntryId: null,
        jobId: 7,
        decisionVersion: 0,
        decisionType: "promote",
        rejectReason: null,
        promotedKnowledgeId: 12,
        supersedesKnowledgeId: null,
        mergeTargetKnowledgeId: null,
        outcomeVersion: null,
        inferenceProvider: "openrouter",
        inferenceModel: "m",
        costUsd: 0.01,
        decidedBy: "manager",
        decidedAt: ISO,
      });
    }

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    for (const col of FORBIDDEN_DECISION_COLUMNS) {
      expect(sql, col).not.toContain(col);
    }
    expect(sql).toContain("FROM memory_decisions");
  });

  it("applies candidateId + decisionType filters as bound parameters", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [] });
    endMock.mockResolvedValue(undefined);

    await listInspectorDecisions({
      candidateId: UUID,
      decisionType: "reject",
      limit: 25,
    });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE candidate_id = $1 AND decision_type = $2");
    expect(params).toEqual([UUID, "reject", 25]);
  });

  it("maps a missing table (42P01) to the retryable dbUnavailable error", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockRejectedValueOnce(undefinedTableError());
    endMock.mockResolvedValue(undefined);

    const res = await listInspectorDecisions({ limit: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.retryable).toBe(true);
      expect(res.error.message).toContain("Database unavailable");
    }
  });
});

describe("getJobsSummary", () => {
  it("derives item progress in one aggregate, fills absent statuses with 0, and never selects worker-lock/last_error columns", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { status: "pending", count: 2 },
          { status: "completed", count: 5 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 3,
            job_kind: "consolidate",
            status: "running",
            attempt_count: 1,
            max_attempts: 3,
            wake_pending: false,
            next_attempt_at: ISO,
            cost_usd: "0.0200",
            llm_call_count: 1,
            created_at: ISO,
            started_at: ISO,
            completed_at: null,
            items_done: 2,
            items_failed: 1,
            items_total: 5,
          },
        ],
      });
    endMock.mockResolvedValue(undefined);

    const res = await getJobsSummary({ recentLimit: 20 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.countsByStatus).toEqual({
        pending: 2,
        running: 0,
        completed: 5,
        failed: 0,
        permanently_failed: 0,
        retired: 0,
      });
      expect(res.data.recentJobs[0]).toEqual({
        id: 3,
        jobKind: "consolidate",
        status: "running",
        attemptCount: 1,
        maxAttempts: 3,
        wakePending: false,
        nextAttemptAt: ISO,
        itemsDone: 2,
        itemsFailed: 1,
        itemsTotal: 5,
        costUsd: 0.02,
        llmCallCount: 1,
        createdAt: ISO,
        startedAt: ISO,
        completedAt: null,
      });
    }

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [jobsSql, jobsParams] = queryMock.mock.calls[1] as [
      string,
      unknown[],
    ];
    for (const col of FORBIDDEN_JOB_COLUMNS) {
      expect(jobsSql, col).not.toContain(col);
    }
    // One bounded LEFT JOIN aggregate over memory_job_items — no N+1.
    expect(jobsSql).toContain("LEFT JOIN memory_job_items");
    expect(jobsParams).toEqual([20]);
  });

  it("maps a missing table (42P01) to the retryable dbUnavailable error - never an empty summary", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockRejectedValueOnce(undefinedTableError());
    endMock.mockResolvedValue(undefined);

    const res = await getJobsSummary({ recentLimit: 20 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal.unexpected");
      expect(res.error.retryable).toBe(true);
      expect(res.error.message).toContain("Database unavailable");
    }
  });

  it("maps a generic query failure to internal.unexpected on the memory domain", async () => {
    connectMock.mockResolvedValue(undefined);
    queryMock.mockRejectedValueOnce(new Error("boom"));
    endMock.mockResolvedValue(undefined);

    const res = await getJobsSummary({ recentLimit: 20 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal.unexpected");
      expect(res.error.domain).toBe("memory");
    }
  });
});
