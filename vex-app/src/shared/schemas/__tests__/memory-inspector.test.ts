/**
 * memory-inspector schema tests (memory-system S10) — boundary validation for
 * the read-only memory-manager inspector.
 *
 * Pins: bounded input limits, the engine-mirrored enum sets (imported
 * DIRECTLY from `src/vex-agent` — allowed in test files only, never in shared
 * source), and the DTOs' SANITIZATION contract: strict objects, so a raw
 * `content_md` / `evidence_refs` / `decision_hash` / embedding field fails
 * the parse instead of leaking through — and the job DTO REJECTS
 * `lastError` / `lastErrorCode` (the omission of `memory_jobs.last_error`
 * is deliberate and pinned here).
 */

import { describe, expect, it } from "vitest";
import {
  CANDIDATE_EVIDENCE_STRENGTH,
  CANDIDATE_RETRIEVAL_VISIBILITY,
  CANDIDATE_SENSITIVITY,
  CANDIDATE_STATUS,
} from "../../../../../src/vex-agent/memory/schema/memory-candidate-enums.js";
import {
  MEMORY_DECISION_ACTOR,
  MEMORY_DECISION_REJECT_REASON,
  MEMORY_DECISION_TYPE,
} from "../../../../../src/vex-agent/memory/schema/memory-decision-enums.js";
import {
  MEMORY_JOB_KIND,
  MEMORY_JOB_STATUS,
} from "../../../../../src/vex-agent/memory/schema/memory-job-enums.js";
import { KNOWLEDGE_SOURCES } from "../../../../../src/vex-agent/memory/long-memory-source-policy.js";
import { LONG_MEMORY_SOURCES } from "../long-memory.js";
import {
  MEMORY_CANDIDATE_EVIDENCE_STRENGTHS,
  MEMORY_CANDIDATE_RETRIEVAL_VISIBILITIES,
  MEMORY_CANDIDATE_SENSITIVITIES,
  MEMORY_CANDIDATE_STATUSES,
  MEMORY_DECISION_ACTORS,
  MEMORY_DECISION_REJECT_REASONS,
  MEMORY_DECISION_TYPES,
  MEMORY_INSPECTOR_LIST_DEFAULT_LIMIT,
  MEMORY_INSPECTOR_LIST_MAX_LIMIT,
  MEMORY_INSPECTOR_RECENT_JOBS_DEFAULT_LIMIT,
  MEMORY_INSPECTOR_RECENT_JOBS_MAX_LIMIT,
  MEMORY_JOB_KINDS,
  MEMORY_JOB_STATUSES,
  memoryCandidateDtoSchema,
  memoryDecisionDtoSchema,
  memoryInspectorJobsSummaryInputSchema,
  memoryInspectorListCandidatesInputSchema,
  memoryInspectorListDecisionsInputSchema,
  memoryJobDtoSchema,
  memoryJobsSummaryDtoSchema,
} from "../memory-inspector.js";

const ISO = "2026-05-21T10:00:00.000Z";
const UUID = "00000000-0000-4000-8000-0000000000c1";

function validCandidate(): Record<string, unknown> {
  return {
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
  };
}

function validDecision(): Record<string, unknown> {
  return {
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
    inferenceModel: "some/model",
    costUsd: 0.01,
    decidedBy: "manager",
    decidedAt: ISO,
  };
}

function validJob(): Record<string, unknown> {
  return {
    id: 3,
    jobKind: "consolidate",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    wakePending: false,
    nextAttemptAt: ISO,
    itemsDone: 2,
    itemsFailed: 0,
    itemsTotal: 5,
    costUsd: null,
    llmCallCount: 1,
    createdAt: ISO,
    startedAt: ISO,
    completedAt: null,
  };
}

describe("memoryInspector input schemas", () => {
  it("listCandidates defaults the limit and accepts an optional status", () => {
    const parsed = memoryInspectorListCandidatesInputSchema.parse({});
    expect(parsed.limit).toBe(MEMORY_INSPECTOR_LIST_DEFAULT_LIMIT);
    expect(parsed.status).toBeUndefined();
    expect(
      memoryInspectorListCandidatesInputSchema.parse({ status: "promoted" })
        .status,
    ).toBe("promoted");
  });

  it("listCandidates caps the limit and rejects unknown keys/statuses", () => {
    expect(
      memoryInspectorListCandidatesInputSchema.parse({
        limit: MEMORY_INSPECTOR_LIST_MAX_LIMIT,
      }).limit,
    ).toBe(MEMORY_INSPECTOR_LIST_MAX_LIMIT);
    expect(
      memoryInspectorListCandidatesInputSchema.safeParse({
        limit: MEMORY_INSPECTOR_LIST_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(
      memoryInspectorListCandidatesInputSchema.safeParse({ limit: 0 }).success,
    ).toBe(false);
    expect(
      memoryInspectorListCandidatesInputSchema.safeParse({ scope: "all" })
        .success,
    ).toBe(false);
    expect(
      memoryInspectorListCandidatesInputSchema.safeParse({ status: "draft" })
        .success,
    ).toBe(false);
  });

  it("listDecisions validates the candidateId/decisionType filters", () => {
    const parsed = memoryInspectorListDecisionsInputSchema.parse({
      candidateId: UUID,
      decisionType: "reject",
    });
    expect(parsed.candidateId).toBe(UUID);
    expect(parsed.decisionType).toBe("reject");
    expect(parsed.limit).toBe(MEMORY_INSPECTOR_LIST_DEFAULT_LIMIT);
    expect(
      memoryInspectorListDecisionsInputSchema.safeParse({
        candidateId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      memoryInspectorListDecisionsInputSchema.safeParse({
        decisionType: "approve",
      }).success,
    ).toBe(false);
  });

  it("jobsSummary bounds recentLimit", () => {
    expect(memoryInspectorJobsSummaryInputSchema.parse({}).recentLimit).toBe(
      MEMORY_INSPECTOR_RECENT_JOBS_DEFAULT_LIMIT,
    );
    expect(
      memoryInspectorJobsSummaryInputSchema.safeParse({
        recentLimit: MEMORY_INSPECTOR_RECENT_JOBS_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(
      memoryInspectorJobsSummaryInputSchema.safeParse({ recentLimit: 0 })
        .success,
    ).toBe(false);
  });
});

describe("memoryCandidateDtoSchema", () => {
  it("accepts a fully-populated sanitized candidate", () => {
    expect(memoryCandidateDtoSchema.safeParse(validCandidate()).success).toBe(
      true,
    );
  });

  it("accepts null source/confidence/promotedKnowledgeId", () => {
    expect(
      memoryCandidateDtoSchema.safeParse({
        ...validCandidate(),
        source: null,
        confidence: null,
        promotedKnowledgeId: null,
      }).success,
    ).toBe(true);
  });

  it("REJECTS raw narrative/evidence/embedding fields (strict DTO - sanitization pin)", () => {
    for (const forbidden of [
      "content_md",
      "source_refs",
      "evidence_refs",
      "outcome",
      "content_hash",
      "embedding",
      "embedding_model",
      "session_id",
      "proposed_by",
    ]) {
      const result = memoryCandidateDtoSchema.safeParse({
        ...validCandidate(),
        [forbidden]: "RAW",
      });
      expect(result.success, forbidden).toBe(false);
    }
  });

  it("rejects out-of-set status strictly (lifecycle drift fails loudly)", () => {
    expect(
      memoryCandidateDtoSchema.safeParse({
        ...validCandidate(),
        status: "draft",
      }).success,
    ).toBe(false);
    expect(
      memoryCandidateDtoSchema.safeParse({
        ...validCandidate(),
        sensitivity: "secret",
      }).success,
    ).toBe(false);
    expect(
      memoryCandidateDtoSchema.safeParse({
        ...validCandidate(),
        evidenceStrength: "overwhelming",
      }).success,
    ).toBe(false);
    expect(
      memoryCandidateDtoSchema.safeParse({
        ...validCandidate(),
        retrievalVisibility: "hidden",
      }).success,
    ).toBe(false);
  });
});

describe("memoryDecisionDtoSchema", () => {
  it("accepts a sanitized decision (candidate anchor)", () => {
    expect(memoryDecisionDtoSchema.safeParse(validDecision()).success).toBe(
      true,
    );
  });

  it("accepts a reconcile decision (null candidate anchor)", () => {
    expect(
      memoryDecisionDtoSchema.safeParse({
        ...validDecision(),
        candidateId: null,
        reconcileEntryId: 9,
        decisionType: "reconcile",
        outcomeVersion: 2,
      }).success,
    ).toBe(true);
  });

  it("REJECTS evidence_refs / decision_hash (strict DTO - sanitization pin)", () => {
    for (const forbidden of ["evidence_refs", "decision_hash"]) {
      const result = memoryDecisionDtoSchema.safeParse({
        ...validDecision(),
        [forbidden]: "RAW",
      });
      expect(result.success, forbidden).toBe(false);
    }
  });

  it("rejects out-of-set decisionType/rejectReason/decidedBy strictly", () => {
    expect(
      memoryDecisionDtoSchema.safeParse({
        ...validDecision(),
        decisionType: "approve",
      }).success,
    ).toBe(false);
    expect(
      memoryDecisionDtoSchema.safeParse({
        ...validDecision(),
        rejectReason: "vibes",
      }).success,
    ).toBe(false);
    expect(
      memoryDecisionDtoSchema.safeParse({
        ...validDecision(),
        decidedBy: "agent",
      }).success,
    ).toBe(false);
  });
});

describe("memoryJobDtoSchema / memoryJobsSummaryDtoSchema", () => {
  it("accepts a sanitized job row and a full summary", () => {
    expect(memoryJobDtoSchema.safeParse(validJob()).success).toBe(true);
    expect(
      memoryJobsSummaryDtoSchema.safeParse({
        countsByStatus: {
          pending: 1,
          running: 0,
          completed: 2,
          failed: 0,
          permanently_failed: 0,
          retired: 0,
        },
        recentJobs: [validJob()],
      }).success,
    ).toBe(true);
  });

  it("REJECTS lastError AND lastErrorCode on a job row (omission pin)", () => {
    // memory_jobs.last_error is untrusted free TEXT — deliberately omitted.
    // A future slice may expose a finite vetted code allowlist; until then
    // neither the raw text nor a code field may ride on the DTO.
    for (const forbidden of [
      "lastError",
      "lastErrorCode",
      "last_error",
      "locked_by",
      "locked_at",
      "heartbeat_at",
    ]) {
      const result = memoryJobDtoSchema.safeParse({
        ...validJob(),
        [forbidden]: "RAW",
      });
      expect(result.success, forbidden).toBe(false);
    }
  });

  it("rejects out-of-set job status/kind strictly", () => {
    expect(
      memoryJobDtoSchema.safeParse({ ...validJob(), status: "queued" })
        .success,
    ).toBe(false);
    expect(
      memoryJobDtoSchema.safeParse({ ...validJob(), jobKind: "sweep" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown countsByStatus keys and negative counts", () => {
    expect(
      memoryJobsSummaryDtoSchema.safeParse({
        countsByStatus: {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          permanently_failed: 0,
          retired: 0,
          queued: 1,
        },
        recentJobs: [],
      }).success,
    ).toBe(false);
    expect(
      memoryJobsSummaryDtoSchema.safeParse({
        countsByStatus: {
          pending: -1,
          running: 0,
          completed: 0,
          failed: 0,
          permanently_failed: 0,
          retired: 0,
        },
        recentJobs: [],
      }).success,
    ).toBe(false);
  });
});

describe("enum sets mirror the engine (direct agent-enum import - drift pins)", () => {
  it("candidate status", () => {
    expect([...MEMORY_CANDIDATE_STATUSES]).toEqual([...CANDIDATE_STATUS]);
  });

  it("candidate sensitivity / evidence strength / retrieval visibility", () => {
    expect([...MEMORY_CANDIDATE_SENSITIVITIES]).toEqual([
      ...CANDIDATE_SENSITIVITY,
    ]);
    expect([...MEMORY_CANDIDATE_EVIDENCE_STRENGTHS]).toEqual([
      ...CANDIDATE_EVIDENCE_STRENGTH,
    ]);
    expect([...MEMORY_CANDIDATE_RETRIEVAL_VISIBILITIES]).toEqual([
      ...CANDIDATE_RETRIEVAL_VISIBILITY,
    ]);
  });

  it("candidate source reuses the shared long-memory provenance set (mirrors KNOWLEDGE_SOURCES)", () => {
    expect([...LONG_MEMORY_SOURCES]).toEqual([...KNOWLEDGE_SOURCES]);
  });

  it("decision type / reject reason / actor", () => {
    expect([...MEMORY_DECISION_TYPES]).toEqual([...MEMORY_DECISION_TYPE]);
    expect([...MEMORY_DECISION_REJECT_REASONS]).toEqual([
      ...MEMORY_DECISION_REJECT_REASON,
    ]);
    expect([...MEMORY_DECISION_ACTORS]).toEqual([...MEMORY_DECISION_ACTOR]);
  });

  it("job status / kind", () => {
    expect([...MEMORY_JOB_STATUSES]).toEqual([...MEMORY_JOB_STATUS]);
    expect([...MEMORY_JOB_KINDS]).toEqual([...MEMORY_JOB_KIND]);
  });
});
