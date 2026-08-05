/**
 * promote() / applyDecision input-mapping unit tests. The DB repos are MOCKED so
 * this pins the MAPPING (not the persistence): a promoted candidate becomes a
 * probationary, advisory, activation<1 entry whose `source` is the judge's tier,
 * reuses the candidate's content_hash + embedding (no re-embed), nests FIX-1
 * anchors under source_refs.evidence, and produces a recordDecision input with
 * NO decisionHash / decidedBy and decisionVersion 0.
 *
 * Defense-in-depth: a promote whose redaction trips is converted to a reject.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

const insertEntry = vi.fn();
const getCandidateEmbedding = vi.fn();
const updateCandidateStatus = vi.fn();
const supersedeEntry = vi.fn();

vi.mock("@vex-agent/db/repos/knowledge.js", () => ({
  insertEntry: (...args: unknown[]) => insertEntry(...args),
}));
vi.mock("@vex-agent/db/repos/knowledge-lifecycle.js", () => ({
  supersedeEntry: (...args: unknown[]) => supersedeEntry(...args),
}));
vi.mock("@vex-agent/db/repos/memory-candidates/index.js", () => ({
  getCandidateEmbedding: (...args: unknown[]) => getCandidateEmbedding(...args),
  updateCandidateStatus: (...args: unknown[]) => updateCandidateStatus(...args),
}));

const { applyDecision } = await import("@vex-agent/memory/manager/promote.js");
const { PROBATION_ACTIVATION } = await import("@vex-agent/engine/memory-manager/policy.js");
const { makeCandidate } = await import("./_fixtures.js");

const fakeTx = {} as PoolClient;

beforeEach(() => {
  vi.clearAllMocks();
  getCandidateEmbedding.mockResolvedValue({
    embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    embeddingModel: "test-model",
    embeddingDim: 8,
  });
  insertEntry.mockResolvedValue({ entry: { id: 1234 }, inserted: true });
  updateCandidateStatus.mockResolvedValue({ ok: true, candidate: { id: "c" } });
  supersedeEntry.mockResolvedValue({ successor: { id: 5678 }, predecessor: { id: 99 } });
});

describe("applyDecision — promote mapping", () => {
  it("inserts a probationary, advisory, activation<1 entry sourced from the judge tier", async () => {
    const candidate = makeCandidate();
    await applyDecision(
      candidate,
      {
        type: "promote",
        sourceTier: "observed",
        regimeTags: ["bull"],
        inferenceProvider: "openrouter",
        inferenceModel: "test/model",
        costUsd: 0.002,
      },
      77,
      fakeTx,
    );

    expect(insertEntry).toHaveBeenCalledTimes(1);
    const input = insertEntry.mock.calls[0][0];
    expect(input.maturityState).toBe("probationary");
    expect(input.influenceScope).toBe("advisory");
    expect(input.activationStrength).toBe(PROBATION_ACTIVATION);
    expect(input.activationStrength).toBeLessThan(1);
    expect(input.source).toBe("observed");
    expect(input.regimeTags).toEqual(["bull"]);
  });

  it("reuses the candidate embedding (no re-embed) and content-hash", async () => {
    const candidate = makeCandidate();
    await applyDecision(
      candidate,
      { type: "promote", sourceTier: "observed", regimeTags: [], inferenceProvider: null, inferenceModel: null, costUsd: null },
      77,
      fakeTx,
    );
    const input = insertEntry.mock.calls[0][0];
    expect(input.embedding).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(input.embeddingModel).toBe("test-model");
    expect(input.embeddingDim).toBe(8);
    expect(input.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("nests FIX-1 anchors under source_refs.evidence and transcript pointers separately", async () => {
    const candidate = makeCandidate({
      evidenceRefs: [{ executionId: 5, instrumentKey: "BONK" }],
      sourceRefs: { messageIds: [1, 2] },
    });
    await applyDecision(
      candidate,
      { type: "promote", sourceTier: "observed", regimeTags: [], inferenceProvider: null, inferenceModel: null, costUsd: null },
      77,
      fakeTx,
    );
    const input = insertEntry.mock.calls[0][0];
    expect(input.sourceRefs.evidence).toEqual([{ executionId: 5, instrumentKey: "BONK" }]);
    expect(input.sourceRefs.transcript).toEqual({ messageIds: [1, 2] });
  });

  it("produces a recordDecision input with version 0 and no decisionHash / decidedBy", async () => {
    const candidate = makeCandidate();
    const res = await applyDecision(
      candidate,
      { type: "promote", sourceTier: "observed", regimeTags: [], inferenceProvider: "openrouter", inferenceModel: "m", costUsd: 0.001 },
      77,
      fakeTx,
    );
    const di = res.decisionInput;
    expect(di.decisionType).toBe("promote");
    if (di.decisionType !== "promote") throw new Error("unreachable");
    expect(di.candidateId).toBe(candidate.id);
    expect(di.jobId).toBe(77);
    expect(di.decisionVersion).toBe(0);
    expect(di.promotedKnowledgeId).toBe(1234);
    expect("decisionHash" in di).toBe(false);
    expect("decidedBy" in di).toBe(false);
    expect(di.evidenceRefs).toEqual(candidate.evidenceRefs);
  });

  it("marks the candidate promoted with the new knowledge id", async () => {
    await applyDecision(
      makeCandidate(),
      { type: "promote", sourceTier: "observed", regimeTags: [], inferenceProvider: null, inferenceModel: null, costUsd: null },
      77,
      fakeTx,
    );
    expect(updateCandidateStatus).toHaveBeenCalledWith(
      expect.any(String),
      "promoted",
      { expectedFromStatus: "pending", promotedKnowledgeId: 1234 },
      fakeTx,
    );
  });
});

describe("applyDecision — defense-in-depth", () => {
  it("converts a promote whose redaction trips into a reject(secret_or_live_state)", async () => {
    // A candidate carrying a live private key in the body → redact() trips →
    // PromoteRedactionAnomalyError → reject. insertEntry must NEVER run.
    const candidate = makeCandidate({
      contentMd:
        "private key 0xabc seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
    });
    const res = await applyDecision(
      candidate,
      { type: "promote", sourceTier: "observed", regimeTags: [], inferenceProvider: null, inferenceModel: null, costUsd: null },
      77,
      fakeTx,
    );
    expect(insertEntry).not.toHaveBeenCalled();
    expect(res.decisionInput.decisionType).toBe("reject");
    if (res.decisionInput.decisionType === "reject") {
      expect(res.decisionInput.rejectReason).toBe("secret_or_live_state");
    }
    expect(updateCandidateStatus).toHaveBeenCalledWith(
      expect.any(String),
      "rejected",
      { expectedFromStatus: "pending" },
      fakeTx,
    );
  });
});

describe("applyDecision — supersede mapping", () => {
  it("supersedes the predecessor and records both ids", async () => {
    const candidate = makeCandidate();
    const res = await applyDecision(
      candidate,
      { type: "supersede", previousKnowledgeId: 99, sourceTier: "observed", regimeTags: [], inferenceProvider: null, inferenceModel: null, costUsd: null },
      77,
      fakeTx,
    );
    expect(supersedeEntry).toHaveBeenCalledTimes(1);
    const di = res.decisionInput;
    expect(di.decisionType).toBe("supersede");
    if (di.decisionType === "supersede") {
      expect(di.promotedKnowledgeId).toBe(5678);
      expect(di.supersedesKnowledgeId).toBe(99);
    }
  });
});

describe("applyDecision — terminal mapping", () => {
  it("retain flips the candidate to retained and records a retain decision (no rejectReason)", async () => {
    const res = await applyDecision(makeCandidate(), { type: "retain" }, 77, fakeTx);
    expect(updateCandidateStatus).toHaveBeenCalledWith(
      expect.any(String),
      "retained",
      { expectedFromStatus: "pending" },
      fakeTx,
    );
    expect(res.decisionInput.decisionType).toBe("retain");
    expect("rejectReason" in res.decisionInput).toBe(false);
    expect(insertEntry).not.toHaveBeenCalled();
  });

  it("reject flips to rejected and carries the reject reason", async () => {
    const res = await applyDecision(
      makeCandidate(),
      { type: "reject", reason: "duplicate" },
      77,
      fakeTx,
    );
    expect(res.decisionInput.decisionType).toBe("reject");
    if (res.decisionInput.decisionType === "reject") {
      expect(res.decisionInput.rejectReason).toBe("duplicate");
    }
  });

  it("expire flips to expired with the expired_ttl reason", async () => {
    const res = await applyDecision(
      makeCandidate(),
      { type: "expire", reason: "expired_ttl" },
      77,
      fakeTx,
    );
    expect(res.decisionInput.decisionType).toBe("expire");
    expect(updateCandidateStatus).toHaveBeenCalledWith(
      expect.any(String),
      "expired",
      { expectedFromStatus: "pending" },
      fakeTx,
    );
  });
});
