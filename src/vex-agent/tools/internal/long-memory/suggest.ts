/**
 * MemorySuggest handler - the agent's ONLY write-door into long-term
 * memory (memory-system/s2-plan.md §2). It STAGES a candidate + enqueues a
 * consolidate job; it never writes long-term memory directly. The async manager
 * (S4) reviews, dedupes, and decides promotion.
 *
 * Ordered, fail-loud, deterministic core with IO only at the edges:
 *   1. read snake_case params → map to the camelCase candidate schema → validate.
 *   2. redact EVERY persisted free-text field (title/summary/contentMd/entities/
 *      tags); a Tier-1 secret ANYWHERE → reject (no row). hard-SCAN-reject the
 *      pointer/key strings (sourceRefs.toolCallIds, evidenceRefs.instrumentKey/
 *      positionKey) without masking them (FIX-1 anchors must stay intact).
 *   3. live-state reject on the redacted free-text aggregate, then the
 *      English-by-contract check (§10.4) on the redacted persisted text.
 *   4. content_hash from the REDACTED text.
 *   5. loop-prevention across BOTH stores (knowledge_entries + terminal candidates).
 *   6. embed AFTER redaction (fail-loud, no non-embedded fallback).
 *   7. derive deterministic system fields (source floor, sensitivity, TTL).
 *   8. insert + enqueue ATOMICALLY in one transaction (enqueue on inserted true
 *      AND false).
 *   9. return concise (default) or detailed per `response_format`.
 *
 * Boundary discipline: this handler imports the memory module + repos only -
 * never the renderer, wallet, or signing authority. `fail(msg)` IS the agent's
 * steering channel; reject messages teach the agent to re-suggest the durable
 * lesson without secrets / live values.
 */

import { ZodError } from "zod";

import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";
import {
  insertCandidate,
  findLatestCandidateByContentHash,
} from "@vex-agent/db/repos/memory-candidates/index.js";
import { enqueueConsolidateJob } from "@vex-agent/db/repos/memory-jobs/index.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { embedDocument } from "@vex-agent/embeddings/client.js";
import { loadEmbeddingConfig } from "@vex-agent/embeddings/config.js";
import { computeContentHash } from "@vex-agent/knowledge/content-hash.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { scanLiveState } from "@vex-agent/memory/exclusion-rules.js";
import { checkLongMemorySuggestEnglish } from "@vex-agent/memory/english-check.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import {
  candidateSuggestInputSchema,
  type CandidateSuggestInput,
} from "@vex-agent/memory/schema/memory-candidate.js";
import {
  deriveCandidateSource,
  deriveCandidateSensitivity,
  computeRetrievalUntil,
} from "@vex-agent/memory/long-memory-suggest-policy.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { str, num, ok, fail } from "../types.js";
import { readResponseFormat, type ResponseFormat } from "@vex-agent/response-format.js";

// ── Steering messages (D-A - advertised, agent-facing) ───────────

const SECRET_REJECT_MESSAGE =
  "A secret (key/seed/token) was detected and memory never stores secrets. Remove it and re-suggest the durable lesson only.";
const LIVE_STATE_REJECT_MESSAGE =
  "This reads as live state (balances/prices/amounts), which goes stale. Record the durable LESSON, not the live values.";
const ENGLISH_REJECT_MESSAGE =
  "This doesn't read as English, and persisted memory is English-only (embedding retrieval). Rewrite the durable lesson in English and re-suggest - entities/tags may keep tickers and protocol ids.";

// ── Redaction of free-text fields ────────────────────────────────

interface RedactedFreeText {
  title: string;
  summary: string;
  contentMd: string;
  entities: string[];
  tags: string[];
  hardRedactCount: number;
  maskCount: number;
}

/**
 * Redact (hard-redact + mask) every persisted free-text field and aggregate the
 * counts across ALL of them (R1 gate - a secret in any stored string must not
 * survive). Returns the redacted values plus the aggregate Tier-1 / Tier-2
 * counts the caller uses for the reject decision and sensitivity derivation.
 */
function redactFreeText(input: CandidateSuggestInput): RedactedFreeText {
  let hardRedactCount = 0;
  let maskCount = 0;

  const apply = (value: string): string => {
    const r = redact(value);
    hardRedactCount += r.hardRedactCount;
    maskCount += r.maskCount;
    return r.text;
  };

  const title = apply(input.title);
  const summary = apply(input.summary);
  const contentMd = apply(input.contentMd);
  const entities = input.entities.map(apply);
  const tags = input.tags.map(apply);

  return { title, summary, contentMd, entities, tags, hardRedactCount, maskCount };
}

/**
 * Hard-SCAN (Tier-1 only) every persisted string that is NOT free-text-masked:
 * `kind` (a snake_case label that can itself spell a credential like
 * `sk_live_…`), plus the pointer/key strings `sourceRefs.toolCallIds` and
 * `evidenceRefs.instrumentKey` / `positionKey`. These pass the schema regex but
 * can carry a secret-shaped token, so they are SCANNED-and-rejected, never masked
 * (FIX-1 anchors AND the kind label must stay byte-intact). Returns true iff any
 * contains a Tier-1 secret.
 */
function scannedStringsContainSecret(input: CandidateSuggestInput): boolean {
  const strings: string[] = [input.kind];
  for (const id of input.sourceRefs.toolCallIds ?? []) strings.push(id);
  for (const anchor of input.evidenceRefs) {
    if (anchor.instrumentKey !== undefined) strings.push(anchor.instrumentKey);
    if (anchor.positionKey !== undefined) strings.push(anchor.positionKey);
  }
  return strings.some((s) => redact(s).hardRedactCount > 0);
}

// ── snake_case → camelCase param mapping ─────────────────────────

/**
 * Map the snake_case tool params to the camelCase `candidateSuggestInputSchema`
 * shape and validate. `response_format` is a tool-only param (read separately by
 * the caller) and is intentionally NOT mapped - it is not a candidate field.
 * Returns the parsed input or a typed Zod error for a readable steering message.
 *
 * Only keys the agent actually supplied are forwarded; the schema applies its
 * own defaults (`.strict()` rejects any unknown key). Optional point-in-time
 * fields stay as ISO strings here - the caller converts them to `Date | null`.
 */
function mapAndValidate(
  params: Record<string, unknown>,
):
  | { ok: true; input: CandidateSuggestInput }
  | { ok: false; error: ZodError } {
  const mapped: Record<string, unknown> = {
    kind: params["kind"],
    title: params["title"],
    summary: params["summary"],
  };
  // Forward optional fields only when present so schema defaults apply otherwise.
  if (params["content_md"] !== undefined) mapped["contentMd"] = params["content_md"];
  if (params["entities"] !== undefined) mapped["entities"] = params["entities"];
  if (params["tags"] !== undefined) mapped["tags"] = params["tags"];
  if (params["source_refs"] !== undefined) mapped["sourceRefs"] = params["source_refs"];
  if (params["evidence_refs"] !== undefined) mapped["evidenceRefs"] = params["evidence_refs"];
  if (params["confidence"] !== undefined) mapped["confidence"] = params["confidence"];
  if (params["importance"] !== undefined) mapped["importance"] = params["importance"];
  if (params["event_time"] !== undefined) mapped["eventTime"] = params["event_time"];
  if (params["observed_at"] !== undefined) mapped["observedAt"] = params["observed_at"];

  const parsed = candidateSuggestInputSchema.safeParse(mapped);
  if (!parsed.success) return { ok: false, error: parsed.error };
  return { ok: true, input: parsed.data };
}

/** First Zod issue rendered as a readable field/message steering hint. */
function firstIssueMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid input";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

/** ISO 8601 string → Date, or null when absent (InsertCandidateInput shape). */
function isoToDateOrNull(iso: string | undefined): Date | null {
  return iso !== undefined ? new Date(iso) : null;
}

// ── Handler ──────────────────────────────────────────────────────

export async function handleLongMemorySuggest(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  // 1. Read + map + validate. response_format is tool-only - read separately and
  // never forwarded to the candidate schema.
  const responseFormat: ResponseFormat = readResponseFormat(params, "concise");

  const mapResult = mapAndValidate(params);
  if (!mapResult.ok) {
    return fail(`MemorySuggest rejected the input - ${firstIssueMessage(mapResult.error)}`);
  }
  const input = mapResult.input;

  // 2. Redact EVERY persisted free-text field; aggregate Tier-1/Tier-2 counts.
  const redacted = redactFreeText(input);
  // A Tier-1 secret in free text OR in kind / any pointer/key string → reject (no row).
  if (redacted.hardRedactCount > 0 || scannedStringsContainSecret(input)) {
    memLog("suggest", "rejected", {
      rejectReason: "secret_or_live_state",
      sessionId: context.sessionId,
      kind: input.kind,
    });
    return fail(SECRET_REJECT_MESSAGE);
  }

  // 3. Live-state reject on the redacted free-text aggregate - INCLUDING entities
  // and tags (they are persisted too, so live state must not be smuggled there).
  const liveStateText = [
    redacted.title,
    redacted.summary,
    redacted.contentMd,
    ...redacted.entities,
    ...redacted.tags,
  ].join("\n");
  if (scanLiveState(liveStateText).rejected) {
    memLog("suggest", "rejected", {
      rejectReason: "secret_or_live_state",
      sessionId: context.sessionId,
      kind: input.kind,
    });
    return fail(LIVE_STATE_REJECT_MESSAGE);
  }

  // 3b. English-by-contract (§10.4) on the REDACTED persisted text - embedding
  // retrieval is English-only, so a non-English lesson is steered back to the
  // agent for translation before anything is hashed, embedded, or stored.
  if (
    checkLongMemorySuggestEnglish({
      title: redacted.title,
      summary: redacted.summary,
      contentMd: redacted.contentMd,
      entities: redacted.entities,
      tags: redacted.tags,
    }).rejected
  ) {
    memLog("suggest", "rejected", {
      rejectReason: "non_english",
      sessionId: context.sessionId,
      kind: input.kind,
    });
    return fail(ENGLISH_REJECT_MESSAGE);
  }

  // 4. content_hash from the REDACTED text (a clean candidate's stable identity).
  const contentHash = computeContentHash({
    kind: input.kind,
    title: redacted.title,
    summary: redacted.summary,
    contentMd: redacted.contentMd,
  });

  // 5. Loop-prevention across BOTH stores (genesis §123; the lesson may already
  // be promoted by the manager).
  try {
    const promoted = await knowledgeRepo.findByContentHash(contentHash);
    if (promoted) {
      // Already long-term memory - neither insert nor enqueue.
      memLog("suggest", "duplicate", {
        sessionId: context.sessionId,
        kind: input.kind,
      });
      return ok({ status: "already_known", duplicate: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`MemorySuggest failed: ${msg}`);
  }

  const latestCandidate = await findLatestCandidateByContentHash(contentHash);
  if (latestCandidate && latestCandidate.status !== "pending") {
    // A terminal candidate (promoted/rejected/superseded/merged/expired/retained)
    // for this exact redacted content - short-circuit, no insert/enqueue. A
    // `pending` match is handled by insertCandidate's upsert (inserted:false).
    memLog("suggest", "duplicate", {
      candidateId: latestCandidate.id,
      status: latestCandidate.status,
      sessionId: context.sessionId,
    });
    return ok({
      candidateId: latestCandidate.id,
      status: latestCandidate.status,
      duplicate: true,
    });
  }

  // 6. Embed AFTER redaction (FIX-4). Fail-loud - NO non-embedded fallback.
  let config;
  try {
    config = loadEmbeddingConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`embedding config invalid: ${msg}`);
  }

  let embedding: number[];
  let providerModel: string;
  try {
    const result = await embedDocument(redacted.title, redacted.summary, config);
    embedding = result.embedding;
    providerModel = result.providerModel;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`embedding service unavailable: ${msg}`);
  }

  // 7. Derive deterministic system fields (pure policy).
  const recordedAt = new Date();
  const source = deriveCandidateSource();
  const sensitivity = deriveCandidateSensitivity(redacted.maskCount);
  const retrievalUntil = computeRetrievalUntil(recordedAt);

  // 8. Insert + enqueue ATOMICALLY (R2 gate - never a candidate without a wake,
  // and always wake a pending one). Enqueue runs for inserted true AND false.
  let candidateId: string;
  let inserted: boolean;
  try {
    const result = await withTransaction(async (tx) => {
      const ins = await insertCandidate(
        {
          sessionId: context.sessionId,
          proposedBy: "parent",
          kind: input.kind,
          title: redacted.title,
          summary: redacted.summary,
          contentMd: redacted.contentMd,
          entities: redacted.entities,
          tags: redacted.tags,
          sourceRefs: input.sourceRefs,
          evidenceRefs: input.evidenceRefs,
          source,
          confidence: input.confidence ?? null,
          importance: input.importance,
          sensitivity,
          evidenceStrength: "none",
          retrievalVisibility: "not_consolidated",
          retrievalUntil,
          retainUntil: null,
          embedding,
          // Honest provenance - stamp the model the provider reported + the real
          // vector length (mirror insertEntry in db/repos/knowledge/crud.ts).
          embeddingModel: providerModel,
          embeddingDim: embedding.length,
          contentHash,
          eventTime: isoToDateOrNull(input.eventTime),
          observedAt: isoToDateOrNull(input.observedAt),
          // S5 owns the no-lookahead as-of boundary.
          availableAtDecisionTime: null,
        },
        tx,
      );
      // Wake the manager even on inserted:false - a pending-hash conflict still
      // left a pending candidate that needs consolidation; skipping the wake
      // could strand it if its original job already ran.
      await enqueueConsolidateJob(tx);
      return ins;
    });
    candidateId = result.candidate.id;
    inserted = result.inserted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`MemorySuggest failed: ${msg}`);
  }

  // memLog accepted - ONLY allowlisted keys (NOT `sensitivity`; the logger has
  // no such key and S2 adds none).
  memLog("suggest", "accepted", {
    candidateId,
    kind: input.kind,
    redactionCount: redacted.hardRedactCount + redacted.maskCount,
    insertResult: inserted ? "inserted" : "duplicate",
    sessionId: context.sessionId,
  });

  // 9. Return per response_format.
  const base = {
    candidateId,
    status: "pending" as const,
    duplicate: !inserted,
  };
  if (responseFormat === "detailed") {
    return ok({
      ...base,
      source,
      sensitivity,
      retrievalUntil: retrievalUntil.toISOString(),
      redactions: { hard: redacted.hardRedactCount, masked: redacted.maskCount },
    });
  }
  return ok(base);
}
