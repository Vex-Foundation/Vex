/**
 * Pre-tx graph plan build (D-ORDER — the LLM never holds locks): extraction →
 * defensive redaction → `$`-canonicalization → identity dedupe → active-entity
 * probe → embedding for new identities.
 *
 * Alias discipline (F2) is the load-bearing rule here: entities merge ONLY on
 * the identical normalized identity `(type, normalizeEntityName(name))` plus
 * aliases the LLM explicitly emitted. ZERO embedding-similarity fuzzy-merge —
 * scam tokens prey on look-alike names, and auto-merging them would poison the
 * graph.
 *
 * D-FAIL-OPEN: ANY failure yields `null` (audited via
 * `memory.manager.graph_extraction_failed`) and the lesson promotes WITHOUT a
 * graph. The graph is HELP, not a source of truth; knowledge > graph, and the
 * asymmetry is deliberate.
 */

import { embedDocument } from "@vex-agent/embeddings/client.js";
import {
  findActiveEntity,
  type MemoryEntityType,
} from "@vex-agent/db/repos/memory-entities/index.js";
import { normalizeEntityName } from "@vex-agent/memory/schema/memory-entity.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";

import type { JudgeProvider } from "../judge.js";
import { extractEntities } from "./extract-call.js";
import type {
  GraphLessonCandidate,
  GraphPlan,
  GraphPlanDeps,
  GraphPlanEdge,
  GraphPlanEntity,
} from "./types.js";

// ── $-symbol canonicalization (pure — D-WRITE / critique L3) ───────

/**
 * Deterministic guard behind the prompt instruction: a name that still starts
 * with `$` is stripped to its canonical form and the original `$XXX` surface
 * form joins the aliases (so recall via the ticker still resolves). A name that
 * is NOTHING but `$`/whitespace yields `null` — the entity is dropped.
 * Non-`$` names pass through unchanged. Pure function; the S1d substrate's
 * `normalizeEntityName` stays untouched.
 */
export function canonicalizeDollarName(
  name: string,
  aliases: readonly string[],
): { name: string; aliases: string[] } | null {
  if (!name.startsWith("$")) return { name, aliases: [...aliases] };
  const stripped = name.replace(/^\$+/, "").trim();
  if (normalizeEntityName(stripped).length === 0) return null;
  return { name: stripped, aliases: dedupeStrings([...aliases, name]) };
}

function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

// ── Injectable IO wiring ───────────────────────────────────────────

/** Production wiring. `makeProvider` is forwarded to the extraction call. */
export function defaultGraphPlanDeps(
  makeProvider?: () => Promise<JudgeProvider>,
): GraphPlanDeps {
  return {
    extractEntities: (lesson) =>
      makeProvider ? extractEntities(lesson, makeProvider) : extractEntities(lesson),
    findActiveEntity: (entityType, normalizedName) =>
      findActiveEntity(entityType, normalizedName),
    embedEntityName: (name, summary) => embedDocument(name, summary),
  };
}

// ── buildGraphPlan (pre-tx; FAIL-OPEN → null) ──────────────────────

/** Working aggregation of one canonical entity before identity resolution. */
interface WorkingEntity {
  entityType: MemoryEntityType;
  name: string;
  aliases: string[];
  summary: string;
}

/**
 * Build the graph write-plan for ONE promoted/superseded candidate (pre-tx,
 * D-WRITE): extraction (LLM) → defensive `redact()` on every output field →
 * `$`-canonicalization → identity dedupe (F2 — identical normalized key ONLY)
 * → `findActiveEntity` probe (skip-embed) → `embedDocument(name, summary)` for
 * NEW entities (model + dim stamped from the response).
 *
 * Returns `null` on ANY error (LLM / embedding / validation — D-FAIL-OPEN,
 * audited via `graph_extraction_failed`) and on an empty extraction (nothing
 * to assert). The caller carries the plan into `applyDecisionAtomically`.
 */
export async function buildGraphPlan(
  candidate: GraphLessonCandidate,
  verdictish: { regimeTags: readonly string[] },
  deps: GraphPlanDeps,
): Promise<GraphPlan | null> {
  try {
    const extraction = await deps.extractEntities({
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      contentMd: candidate.contentMd,
      regimeTags: verdictish.regimeTags,
    });

    // Defensive redaction + canonicalization + identity dedupe (F2: merge on
    // the IDENTICAL canonical key only — never on similarity).
    const byKey = new Map<string, WorkingEntity>();
    const keyByDeclaredName = new Map<string, string>();
    for (const raw of extraction.entities) {
      const redactedName = redact(raw.name).text;
      const canon = canonicalizeDollarName(
        redactedName,
        raw.aliases.map((a) => redact(a).text).filter((a) => a.trim().length > 0),
      );
      if (canon === null) continue; // '$'-only name → dropped entity
      const normName = normalizeEntityName(canon.name);
      if (normName.length === 0) continue; // defensive: redaction left whitespace
      const key = `${raw.type}:${normName}`;

      const existing = byKey.get(key);
      if (existing) {
        existing.aliases = dedupeStrings([...existing.aliases, ...canon.aliases]);
      } else {
        byKey.set(key, {
          entityType: raw.type,
          name: canon.name,
          aliases: canon.aliases,
          summary: raw.summary !== undefined ? redact(raw.summary).text : "",
        });
      }
      // Edge endpoints reference DECLARED names — map their normalized,
      // redacted form to the canonical key (first declaration wins).
      const declaredNorm = normalizeEntityName(redactedName);
      if (declaredNorm.length > 0 && !keyByDeclaredName.has(declaredNorm)) {
        keyByDeclaredName.set(declaredNorm, key);
      }
    }
    if (byKey.size === 0) return null; // nothing to assert — not an error

    // Identity resolution: existing active entity → alias growth only (skip
    // embed); new identity → NAME embedding stamped from the response.
    const entities: GraphPlanEntity[] = [];
    for (const [key, w] of byKey) {
      const active = await deps.findActiveEntity(w.entityType, normalizeEntityName(w.name));
      if (active) {
        entities.push({ kind: "existing", key, entityId: active.id, aliases: w.aliases });
      } else {
        const emb = await deps.embedEntityName(w.name, w.summary);
        entities.push({
          kind: "new",
          key,
          entityType: w.entityType,
          name: w.name,
          aliases: w.aliases,
          summary: w.summary,
          embedding: emb.embedding,
          embeddingModel: emb.providerModel,
          embeddingDim: emb.embedding.length,
        });
      }
    }

    // Edges: resolve endpoints through the declared-name map; drop edges whose
    // endpoint was dropped or that became a self-loop after canonicalization
    // ("$SOL" + "SOL" collapsing to one identity). Dedupe on the active-triple
    // arbiter so the plan never asserts the same relation twice.
    const edgeByTriple = new Map<string, GraphPlanEdge>();
    for (const raw of extraction.edges) {
      const sourceKey = keyByDeclaredName.get(normalizeEntityName(redact(raw.source).text));
      const targetKey = keyByDeclaredName.get(normalizeEntityName(redact(raw.target).text));
      if (sourceKey === undefined || targetKey === undefined) continue;
      if (sourceKey === targetKey) continue;
      const triple = `${sourceKey}→${targetKey}:${raw.relation}`;
      if (edgeByTriple.has(triple)) continue;
      edgeByTriple.set(triple, {
        sourceKey,
        targetKey,
        relation: raw.relation,
        fact: raw.fact !== undefined ? redact(raw.fact).text : "",
      });
    }

    return {
      entities,
      links: entities.map((e) => ({ key: e.key, mentionCount: 1 })),
      edges: Array.from(edgeByTriple.values()),
    };
  } catch (err: unknown) {
    // D-FAIL-OPEN: graph is help, not truth — promotion proceeds without it.
    memLog.warn("manager", "graph_extraction_failed", {
      candidateId: candidate.id,
      errorCode: mapExtractionErrorCode(err),
    });
    return null;
  }
}

// ── Error-code mapping (bounded; never a raw message) ──────────────

function mapExtractionErrorCode(err: unknown): string {
  if (!(err instanceof Error)) return "extraction_unknown";
  const msg = err.message;
  if (msg.includes("timeout")) return "extraction_timeout";
  if (msg.includes("malformed")) return "extraction_malformed";
  if (msg.includes("schema_invalid")) return "extraction_schema_invalid";
  if (msg.includes("config")) return "provider_config";
  if (msg.includes("embedding")) return "embed_failed";
  return "extraction_error";
}
