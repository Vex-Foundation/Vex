/**
 * Integration (real pgvector): S8 graph v1 end-to-end — promotion-time
 * extraction writes (entities / aliases / links / edges in the SAME tx as the
 * lesson), the F2 alias-merge on a second promotion (uniq_me_active_identity),
 * the D-SAVEPOINT seatbelt (an in-tx graph error never takes the promotion
 * down), D-SUPERSEDE-WIRING (predecessor edge retraction on supersede), and
 * the 1-hop `expandViaGraph` read path over the REAL repos. The extraction LLM
 * is ALWAYS stubbed (deterministic `EntityExtraction` or a thrown error —
 * D-FAIL-OPEN); entity-name embeddings are synthetic (`randVector` — no
 * embeddings endpoint, the _s1d precedent).
 *
 * Drives the decision pipeline at the repo level (enqueue → claim → reserve →
 * markProcessing → consolidate → applyDecisionAtomically → markItemDone)
 * exactly as the executor does — the memory-manager-consolidate.int.test.ts
 * harness, extended with the S8 graphPlan seam.
 *
 * NOTE (Agent Scan W4): this file previously ALSO covered
 * D-SUPERSEDE-WIRING's edge-retraction path via reconcile-invalidate (the S7
 * reconcile worker). That worker (`engine/memory-manager/reconcile.ts`),
 * `memory/ledger-wake.ts`, and `memory/manager/reconcile-{policy,judge}.ts`
 * are deleted this phase; the reconcile-invalidate test case + its dedicated
 * seeders were removed. Supersede-path edge retraction (the OTHER
 * D-SUPERSEDE-WIRING trigger) is untouched and still covered below.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import {
  enqueueConsolidateJob,
  claimNextDueJob,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import {
  reserveCandidatesForJob,
  listItemsByJob,
  markItemProcessing,
  markItemDone,
} from "@vex-agent/db/repos/memory-job-items/index.js";
import {
  getCandidateById,
  getCandidateEmbedding,
} from "@vex-agent/db/repos/memory-candidates/index.js";
import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";
import { findActiveEntity } from "@vex-agent/db/repos/memory-entities/index.js";
import {
  linkEntryEntity,
  listEntitiesForEntry,
} from "@vex-agent/db/repos/memory-entry-entities/index.js";
import { invalidateEdgesForOrigin } from "@vex-agent/db/repos/memory-edges/index.js";
import {
  consolidateCandidate,
  applyDecisionAtomically,
  defaultConsolidateDeps,
  buildGraphPlan,
  ClaimLostError,
  type ConsolidateDeps,
  type EntityExtraction,
  type GraphPlan,
  type GraphPlanDeps,
} from "@vex-agent/memory/manager/index.js";
import type { JudgeVerdict } from "@vex-agent/memory/manager/judge-schema.js";
import { expandViaGraph } from "@vex-agent/tools/internal/long-memory/search.js";
import type { LongMemoryKnowledgeResult } from "@vex-agent/memory/long-memory-retrieval-policy.js";
import { resetDb, randVector } from "../setup/fixtures.js";
import {
  makeSession,
  seedExecution,
  seedCandidate,
  stubJudge,
  PROMOTE_VERDICT,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
} from "./_s4-fixtures.js";
import { seedEntity, seedEdge, seedKnowledgeEntry } from "./_s1d-fixtures.js";

const WORKER = "graph-w";

// ── Stub extraction → graph-plan deps (LLM stubbed, repos REAL) ────

const WIF_EXTRACTION: EntityExtraction = {
  entities: [
    { name: "WIF", type: "token", aliases: ["dogwifhat"], summary: "Solana memecoin" },
    { name: "Jupiter", type: "protocol", aliases: [], summary: "Solana DEX aggregator" },
  ],
  edges: [
    { source: "WIF", target: "Jupiter", relation: "traded_on", fact: "WIF routed on Jupiter" },
  ],
};

/** Same WIF identity, NEW alias — drives the F2 alias-merge on promote #2. */
const WIF_ALIAS_EXTRACTION: EntityExtraction = {
  entities: [{ name: "WIF", type: "token", aliases: ["$WIF"], summary: "memecoin" }],
  edges: [],
};

/** Deterministic graph deps: stub extraction + synthetic embed, REAL findActiveEntity. */
function graphDeps(extraction: EntityExtraction | Error): GraphPlanDeps {
  return {
    extractEntities: async () => {
      if (extraction instanceof Error) throw extraction;
      return extraction;
    },
    findActiveEntity: (entityType, normalizedName) => findActiveEntity(entityType, normalizedName),
    embedEntityName: async (name) => ({
      embedding: randVector(EMBEDDING_DIM, `entity-${name}`),
      providerModel: EMBEDDING_MODEL,
    }),
  };
}

/**
 * Consolidate deps: REAL recall/deref against pgvector, STUB judge, and the S8
 * graph seam wired to a deterministic extraction (`null` = no extraction call).
 */
function depsWithGraph(
  verdict: JudgeVerdict,
  extraction: EntityExtraction | Error | null,
): ConsolidateDeps {
  return {
    ...defaultConsolidateDeps(),
    judge: stubJudge(verdict),
    buildGraphPlan: (candidate, plan) =>
      extraction === null
        ? Promise.resolve(null)
        : buildGraphPlan(candidate, plan, graphDeps(extraction)),
  };
}

// ── Executor-shaped item driver (S4 harness + graphPlan seam) ──────

async function reserveAll(workerId: string): Promise<number> {
  await enqueueConsolidateJob();
  const job = await claimNextDueJob(workerId);
  if (!job) throw new Error("no consolidate job");
  await reserveCandidatesForJob(job.id, workerId, 16);
  return job.id;
}

async function decideItem(args: {
  jobId: number;
  workerId: string;
  candidateId: string;
  verdict: JudgeVerdict;
  extraction: EntityExtraction | Error | null;
}): Promise<{ decisionType: string; entryId: number | null }> {
  const items = await listItemsByJob(args.jobId, "reserved");
  const item = items.find((i) => i.candidateId === args.candidateId);
  if (!item) throw new Error("candidate not reserved");
  const ok = await markItemProcessing(item.id, args.jobId, args.workerId);
  if (!ok) throw new Error("markItemProcessing failed");

  const candidate = await getCandidateById(args.candidateId);
  const embedding = await getCandidateEmbedding(args.candidateId);
  if (!candidate || !embedding) throw new Error("candidate/embedding missing");

  const decision = await consolidateCandidate(
    candidate,
    embedding,
    depsWithGraph(args.verdict, args.extraction),
  );
  const applied = await applyDecisionAtomically({
    candidate,
    plan: decision.plan,
    jobId: args.jobId,
    workerId: args.workerId,
    outcome: decision.outcome,
    availableAtDecisionTime: decision.availableAtDecisionTime,
    reinforce: decision.reinforce,
    graphPlan: decision.graphPlan,
  });
  await markItemDone(item.id, args.jobId, args.workerId, applied.decisionId);

  const after = await getCandidateById(args.candidateId);
  return { decisionType: applied.decisionType, entryId: after?.promotedKnowledgeId ?? null };
}

/** Seed a promotable generalization: a cluster sibling + the main candidate. */
async function seedPromotable(sessionId: string, seed: string): Promise<string> {
  const execA = await seedExecution(sessionId);
  const execB = await seedExecution(sessionId);
  await seedCandidate(sessionId, `${seed}-sib`, {
    executionIds: [execB],
    vectorSeed: `shared-${seed}`,
  });
  return seedCandidate(sessionId, `${seed}-main`, {
    executionIds: [execA],
    vectorSeed: `shared-${seed}`,
  });
}

// ── Row probes ─────────────────────────────────────────────────────

async function countActiveIdentity(entityType: string, normalizedName: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memory_entities
      WHERE entity_type = $1 AND normalized_name = $2 AND valid_until IS NULL`,
    [entityType, normalizedName],
  );
  return Number(rows[0]!.n);
}

interface EdgeProbeRow {
  relation: string;
  invalidated_at: string | null;
  source_entity_id: string;
  target_entity_id: string;
}

async function edgesForOrigin(entryId: number): Promise<EdgeProbeRow[]> {
  return query<EdgeProbeRow>(
    `SELECT relation, invalidated_at, source_entity_id, target_entity_id
       FROM memory_edges WHERE origin_entry_id = $1 ORDER BY created_at ASC`,
    [entryId],
  );
}

async function tableCount(table: "memory_entities" | "memory_entry_entities" | "memory_edges"): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

// ── Expansion seed builder ─────────────────────────────────────────

function seedResult(id: number, score: number): LongMemoryKnowledgeResult {
  return {
    source: "long_memory",
    id,
    kind: "trade_lesson",
    title: `Seed ${id}`,
    summary: "s",
    contentMd: "",
    similarity: 0.8,
    score,
    sourceTier: "observed",
    maturityState: "established",
    activationStrength: 1,
    tags: [],
    validUntil: null,
    evidenceRefs: {},
    rerankScore: score,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("S8 graph v1 (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── Promote → entities + aliases + links + edges, atomic ─────────

  it("promote with stubbed extraction writes entities/aliases/links/edges with the lesson", async () => {
    const sid = await makeSession();
    const candidateId = await seedPromotable(sid, "p1");
    const jobId = await reserveAll(WORKER);

    const { decisionType, entryId } = await decideItem({
      jobId,
      workerId: WORKER,
      candidateId,
      verdict: PROMOTE_VERDICT,
      extraction: WIF_EXTRACTION,
    });
    expect(decisionType).toBe("promote");
    expect(entryId).not.toBeNull();

    // Entities: both identities active, the LLM aliases stored.
    const wif = await findActiveEntity("token", "wif");
    const jup = await findActiveEntity("protocol", "jupiter");
    expect(wif).not.toBeNull();
    expect(wif!.aliases).toContain("dogwifhat");
    expect(jup).not.toBeNull();

    // Links: the promoted entry mentions BOTH entities.
    const links = await listEntitiesForEntry(entryId!);
    expect(links.map((l) => l.entityId).sort()).toEqual([wif!.id, jup!.id].sort());

    // Edge: origin = the promoted entry, active, no fact embedding (D-EMB).
    const edges = await edgesForOrigin(entryId!);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("traded_on");
    expect(edges[0]!.invalidated_at).toBeNull();
    expect(edges[0]!.source_entity_id).toBe(wif!.id);
    expect(edges[0]!.target_entity_id).toBe(jup!.id);
  });

  it("second promote asserting the same entity merges aliases — no duplicate active identity (F2)", async () => {
    const sid = await makeSession();
    const candA = await seedPromotable(sid, "m1");
    const candB = await seedPromotable(sid, "m2");
    const jobId = await reserveAll(WORKER);

    const first = await decideItem({
      jobId,
      workerId: WORKER,
      candidateId: candA,
      verdict: PROMOTE_VERDICT,
      extraction: WIF_EXTRACTION,
    });
    const second = await decideItem({
      jobId,
      workerId: WORKER,
      candidateId: candB,
      verdict: PROMOTE_VERDICT,
      extraction: WIF_ALIAS_EXTRACTION,
    });
    expect(first.decisionType).toBe("promote");
    expect(second.decisionType).toBe("promote");

    // uniq_me_active_identity: still EXACTLY ONE active token:wif row.
    expect(await countActiveIdentity("token", "wif")).toBe(1);

    // Aliases merged deterministically (F2): both promotions' aliases coexist.
    const wif = await findActiveEntity("token", "wif");
    expect(wif!.aliases).toEqual(expect.arrayContaining(["dogwifhat", "$WIF"]));

    // Both entries link to the SAME entity row.
    const linksA = await listEntitiesForEntry(first.entryId!);
    const linksB = await listEntitiesForEntry(second.entryId!);
    expect(linksA.map((l) => l.entityId)).toContain(wif!.id);
    expect(linksB.map((l) => l.entityId)).toContain(wif!.id);
  });

  it("atomicity: a lost claim writes NEITHER the lesson NOR any graph row", async () => {
    const sid = await makeSession();
    const candidateId = await seedPromotable(sid, "a1");
    const jobId = await reserveAll("w-owner");
    const items = await listItemsByJob(jobId, "reserved");
    const item = items.find((i) => i.candidateId === candidateId);
    expect(item).toBeDefined();
    await markItemProcessing(item!.id, jobId, "w-owner");

    const candidate = await getCandidateById(candidateId);
    const embedding = await getCandidateEmbedding(candidateId);
    const decision = await consolidateCandidate(
      candidate!,
      embedding!,
      depsWithGraph(PROMOTE_VERDICT, WIF_EXTRACTION),
    );
    expect(decision.graphPlan).not.toBeNull();

    await expect(
      applyDecisionAtomically({
        candidate: candidate!,
        plan: decision.plan,
        jobId,
        workerId: "w-thief",
        graphPlan: decision.graphPlan,
      }),
    ).rejects.toBeInstanceOf(ClaimLostError);

    const entries = await query<{ n: string }>(`SELECT count(*)::text AS n FROM knowledge_entries`);
    expect(Number(entries[0]!.n)).toBe(0);
    expect(await tableCount("memory_entities")).toBe(0);
    expect(await tableCount("memory_entry_entities")).toBe(0);
    expect(await tableCount("memory_edges")).toBe(0);
  });

  // ── Fail-open: extraction error → promoted WITHOUT a graph ───────

  it("extraction failure fails OPEN: the lesson promotes with zero graph rows", async () => {
    const sid = await makeSession();
    const candidateId = await seedPromotable(sid, "f1");
    const jobId = await reserveAll(WORKER);

    const { decisionType, entryId } = await decideItem({
      jobId,
      workerId: WORKER,
      candidateId,
      verdict: PROMOTE_VERDICT,
      extraction: new Error("memory_extraction_timeout"),
    });
    expect(decisionType).toBe("promote");
    expect(entryId).not.toBeNull();

    const entry = await knowledgeRepo.getById(entryId!);
    expect(entry!.status).toBe("active");
    expect(await tableCount("memory_entities")).toBe(0);
    expect(await tableCount("memory_entry_entities")).toBe(0);
    expect(await tableCount("memory_edges")).toBe(0);
  });

  // ── D-SAVEPOINT: an in-tx graph error never blocks the promotion ──

  it("SAVEPOINT seatbelt: an aborted graph statement (FK violation) rolls back ONLY the graph — promotion commits", async () => {
    const sid = await makeSession();
    const candidateId = await seedPromotable(sid, "s1");
    const jobId = await reserveAll(WORKER);
    const items = await listItemsByJob(jobId, "reserved");
    const item = items.find((i) => i.candidateId === candidateId);
    await markItemProcessing(item!.id, jobId, WORKER);

    const candidate = await getCandidateById(candidateId);
    const embedding = await getCandidateEmbedding(candidateId);
    const decision = await consolidateCandidate(
      candidate!,
      embedding!,
      depsWithGraph(PROMOTE_VERDICT, null),
    );

    // An "existing" entity whose id does NOT exist (the pre-tx-probe race taken
    // to its worst case): linkEntryEntity hits the FK → the STATEMENT aborts →
    // only `ROLLBACK TO SAVEPOINT graph_plan` can save the tx.
    const ghostPlan: GraphPlan = {
      entities: [
        {
          kind: "existing",
          key: "token:ghost",
          entityId: "00000000-0000-0000-0000-000000000001",
          aliases: [],
        },
      ],
      links: [{ key: "token:ghost", mentionCount: 1 }],
      edges: [],
    };
    const applied = await applyDecisionAtomically({
      candidate: candidate!,
      plan: decision.plan,
      jobId,
      workerId: WORKER,
      graphPlan: ghostPlan,
    });
    await markItemDone(item!.id, jobId, WORKER, applied.decisionId);
    expect(applied.decisionType).toBe("promote");

    // The promotion COMMITTED (decision + entry + candidate status)…
    const after = await getCandidateById(candidateId);
    expect(after!.status).toBe("promoted");
    const entry = await knowledgeRepo.getById(after!.promotedKnowledgeId!);
    expect(entry!.status).toBe("active");
    // …and the graph writes rolled back to the savepoint.
    expect(await tableCount("memory_entry_entities")).toBe(0);
  });

  it("SAVEPOINT seatbelt: a pre-SQL repo guard (embedding-dim mismatch) is absorbed the same way", async () => {
    const sid = await makeSession();
    const candidateId = await seedPromotable(sid, "s2");
    const jobId = await reserveAll(WORKER);
    const items = await listItemsByJob(jobId, "reserved");
    const item = items.find((i) => i.candidateId === candidateId);
    await markItemProcessing(item!.id, jobId, WORKER);

    const candidate = await getCandidateById(candidateId);
    const embedding = await getCandidateEmbedding(candidateId);
    const decision = await consolidateCandidate(
      candidate!,
      embedding!,
      depsWithGraph(PROMOTE_VERDICT, null),
    );

    // Bad dim: upsertEntity's TS guard throws BEFORE SQL — same catch path.
    const badDimPlan: GraphPlan = {
      entities: [
        {
          kind: "new",
          key: "token:bad",
          entityType: "token",
          name: "Bad",
          aliases: [],
          summary: "",
          embedding: randVector(EMBEDDING_DIM, "bad-entity"),
          embeddingModel: EMBEDDING_MODEL,
          embeddingDim: EMBEDDING_DIM + 1,
        },
      ],
      links: [{ key: "token:bad", mentionCount: 1 }],
      edges: [],
    };
    const applied = await applyDecisionAtomically({
      candidate: candidate!,
      plan: decision.plan,
      jobId,
      workerId: WORKER,
      graphPlan: badDimPlan,
    });
    await markItemDone(item!.id, jobId, WORKER, applied.decisionId);
    expect(applied.decisionType).toBe("promote");

    const after = await getCandidateById(candidateId);
    expect(after!.status).toBe("promoted");
    expect(await tableCount("memory_entities")).toBe(0);
    expect(await tableCount("memory_entry_entities")).toBe(0);
  });

  // ── Supersede retracts the PREDECESSOR's edges, successor fresh ──

  it("supersede invalidates the predecessor's origin edges; the successor re-asserts fresh; links survive", async () => {
    const sid = await makeSession();
    const candA = await seedPromotable(sid, "sup-a");
    const candB = await seedPromotable(sid, "sup-b");
    const jobId = await reserveAll(WORKER);

    const first = await decideItem({
      jobId,
      workerId: WORKER,
      candidateId: candA,
      verdict: PROMOTE_VERDICT,
      extraction: WIF_EXTRACTION,
    });
    expect(first.decisionType).toBe("promote");
    const predecessorId = first.entryId!;
    expect((await edgesForOrigin(predecessorId))[0]!.invalidated_at).toBeNull();

    const supersedeVerdict: JudgeVerdict = {
      verdict: "supersede",
      rubric: { grounding: 4, durability: 4, novelty: 3, generalizability: 3, processNotOutcome: 3 },
      sourceTier: "observed",
      regimeTags: ["bull"],
      previousKnowledgeId: predecessorId,
    };
    const second = await decideItem({
      jobId,
      workerId: WORKER,
      candidateId: candB,
      verdict: supersedeVerdict,
      extraction: WIF_EXTRACTION, // fresh extraction re-asserts the relation
    });
    expect(second.decisionType).toBe("supersede");
    const successorId = second.entryId!;

    // Predecessor: superseded; its asserted edges retracted (bi-temporal, not deleted).
    const predecessor = await knowledgeRepo.getById(predecessorId);
    expect(predecessor!.status).toBe("superseded");
    const oldEdges = await edgesForOrigin(predecessorId);
    expect(oldEdges).toHaveLength(1);
    expect(oldEdges[0]!.invalidated_at).not.toBeNull();

    // Successor: a FRESH active edge with its own origin.
    const newEdges = await edgesForOrigin(successorId);
    expect(newEdges).toHaveLength(1);
    expect(newEdges[0]!.invalidated_at).toBeNull();

    // The predecessor's entry↔entity links STAY (historical record).
    const predecessorLinks = await listEntitiesForEntry(predecessorId);
    expect(predecessorLinks.length).toBeGreaterThan(0);
  });

  // ── Expansion read path (REAL repos, 1 hop) ──────────────────────

  it("expansion e2e: seed → entity → edge → neighbor entry, marked + scored below the seed", async () => {
    // Lesson A mentions WIF; WIF —traded_on→ Jupiter; lesson B mentions Jupiter.
    const entryA = await seedKnowledgeEntry("exp-a");
    const entryB = await seedKnowledgeEntry("exp-b");
    const wifId = await seedEntity("exp-wif", { entityType: "token", name: "WIF" });
    const jupId = await seedEntity("exp-jup", { entityType: "protocol", name: "Jupiter" });
    await linkEntryEntity(entryA, wifId);
    await linkEntryEntity(entryB, jupId);
    await seedEdge(wifId, jupId, "exp-edge", { relation: "traded_on", originEntryId: entryA });

    const out = await expandViaGraph([seedResult(entryA, 0.8)], new Set([entryA]), 5);
    expect(out.seedCount).toBe(1);
    expect(out.results).toHaveLength(1);
    const neighbor = out.results[0]!;
    expect(neighbor.id).toBe(entryB);
    expect(neighbor.via).toBe("graph");
    expect(neighbor.viaEntity).toBe("Jupiter");
    expect(neighbor.score).toBeGreaterThan(0);
    expect(neighbor.score).toBeLessThan(0.8); // strictly below the seed
    expect(neighbor.contentMd).toBe(""); // bounded pointer

    // Never evicts: zero free slots → no expansion at all.
    const none = await expandViaGraph([seedResult(entryA, 0.8)], new Set([entryA]), 0);
    expect(none.results).toEqual([]);
  });

  it("expansion e2e: an invalidated edge and an inactive neighbor never surface", async () => {
    const entryA = await seedKnowledgeEntry("gone-a");
    const entryB = await seedKnowledgeEntry("gone-b");
    const wifId = await seedEntity("gone-wif", { entityType: "token", name: "WIF2" });
    const jupId = await seedEntity("gone-jup", { entityType: "protocol", name: "Jupiter2" });
    await linkEntryEntity(entryA, wifId);
    await linkEntryEntity(entryB, jupId);
    await seedEdge(wifId, jupId, "gone-edge", { relation: "traded_on", originEntryId: entryA });

    // Retract the edge → the hop disappears.
    await invalidateEdgesForOrigin(entryA);
    const afterRetract = await expandViaGraph([seedResult(entryA, 0.8)], new Set([entryA]), 5);
    expect(afterRetract.results).toEqual([]);

    // Re-assert the edge but kill the neighbor entry → still nothing surfaces.
    await seedEdge(wifId, jupId, "gone-edge-2", { relation: "uses", originEntryId: entryA });
    await execute(`UPDATE knowledge_entries SET status = 'invalidated' WHERE id = $1`, [entryB]);
    const afterKill = await expandViaGraph([seedResult(entryA, 0.8)], new Set([entryA]), 5);
    expect(afterKill.results).toEqual([]);
  });

  it("expansion e2e: an empty graph returns [] (pre-S8 behavior preserved)", async () => {
    const entryA = await seedKnowledgeEntry("empty-a");
    const out = await expandViaGraph([seedResult(entryA, 0.8)], new Set([entryA]), 5);
    expect(out).toEqual({ results: [], dropped: 0, seedCount: 1 });
  });
});
