/**
 * Judge context builder (S4 §4/§7). Assembles what the LLM judge sees: the
 * REDACTED candidate + a REDACTED transcript window dereferenced from the
 * candidate's `source_refs.messageIds`, plus the deterministic signals.
 *
 * The transcript is re-redacted here even though the source messages may pre-date
 * the memory layer's redaction (same discipline as the chunker's
 * `renderRedactedArchivedTranscript`): wallet ids, tx hashes, and key material in
 * a live/archived message must NOT reach the remote judge provider. Messages are
 * read from BOTH `messages` and `messages_archive` (a candidate's source messages
 * may have been compacted into the archive after it was suggested).
 *
 * IO at the edge: the message read is a single bounded SELECT; the rest is pure
 * string assembly. The candidate fields are already redacted (S2 stored them
 * redacted), so they are passed through; a defense-in-depth redact runs on the
 * transcript only.
 */

import { getPool, queryWith, type Executor } from "@vex-agent/db/client.js";
import type { PoolClient } from "pg";
import type { MemoryCandidate } from "@vex-agent/db/repos/memory-candidates/index.js";
import type { KnownKind } from "@vex-agent/db/repos/knowledge.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import { JUDGE_TRANSCRIPT_CHARS_CAP } from "@vex-agent/engine/memory-manager/policy.js";
import { redact } from "@vex-agent/memory/redaction.js";
import type { EscalationSignals } from "./deterministic-stage.js";

/** Max transcript messages dereferenced for the judge (bounded context). */
const MAX_TRANSCRIPT_MESSAGES = 40;

/**
 * Truncate to `max` chars with a trailing ellipsis when over (the result never
 * exceeds `max`). Shared by the judge excerpt mappings (consolidate.ts) and
 * the prompt renderer's defensive re-truncation (judge-prompt.ts).
 */
export function truncateChars(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One similar pending/retained candidate, rendered for the judge as SOFT
 * context (not authoritative). Both excerpts are redacted BEFORE truncation
 * (JUDGE_CANDIDATE_EXCERPT_CHARS) by the consolidate mapping — the `Excerpt`
 * suffix is deliberate so future callers never pass full stored text into
 * prompt context.
 */
export interface JudgeSimilarCandidate {
  id: string;
  kind: string;
  titleExcerpt: string;
  summaryExcerpt: string;
  similarity: number;
  source: KnowledgeSource;
}

/**
 * Judge Context v2 extras computed by consolidate.ts (IO stays injectable
 * there): the active-kind census + the similar-candidate soft context.
 */
export interface JudgeContextExtras {
  knownKinds: KnownKind[];
  similarCandidates: JudgeSimilarCandidate[];
}

/**
 * Lineage note: `signals.nearDupTopK` only ever contains `status='active'`
 * entries, and an active entry IS its chain's head by FSM construction — a
 * supersede flips the predecessor to `status='superseded'` in the same
 * transaction that inserts the successor. No extra lineage queries are needed
 * to give the judge head-status context.
 */
export interface JudgeContext {
  /**
   * Session the candidate was suggested in. NEVER rendered into a prompt — it
   * selects the session's CURRENT effective endpoint for the judge call, the
   * same way a compaction branch does (`branch-provider-call.ts`). Judging on
   * the operator's stale pin would route back to the endpoint the session had
   * already switched away from.
   */
  sessionId: string;
  candidate: Pick<
    MemoryCandidate,
    | "kind"
    | "title"
    | "summary"
    | "contentMd"
    | "importance"
    | "confidence"
    | "eventTime"
    | "observedAt"
    | "recordedAt"
    | "availableAtDecisionTime"
  >;
  /**
   * Redacted, role-tagged transcript window (or empty when no messages
   * resolve), char-capped to JUDGE_TRANSCRIPT_CHARS_CAP after rendering.
   */
  transcript: string;
  signals: EscalationSignals;
  /** Whether the transcript carries an explicit user affirmation (§6 tier hint). */
  userAffirmationDetected: boolean;
  /** Active-kind census (kind=count), capped at JUDGE_KNOWN_KINDS_LIMIT. */
  knownKinds: KnownKind[];
  /** Similar pending/retained candidates — soft context, never authoritative. */
  similarCandidates: JudgeSimilarCandidate[];
}

interface TranscriptRow {
  id: number;
  role: string;
  content: string;
  tool_call_id: string | null;
}

/**
 * Read the candidate's source messages (live + archived) by id, scoped to the
 * candidate's session, ordered by id. Bounded to `MAX_TRANSCRIPT_MESSAGES`.
 */
async function readTranscriptRows(
  sessionId: string,
  messageIds: readonly number[],
  exec: Executor,
): Promise<TranscriptRow[]> {
  if (messageIds.length === 0) return [];
  const ids = messageIds.slice(0, MAX_TRANSCRIPT_MESSAGES);
  return queryWith<TranscriptRow>(
    exec,
    `SELECT id, role, content, tool_call_id
       FROM messages
      WHERE session_id = $1 AND id = ANY($2::int[])
     UNION ALL
     SELECT id, role, content, tool_call_id
       FROM messages_archive
      WHERE session_id = $1 AND id = ANY($2::int[])
      ORDER BY id ASC
      LIMIT $3`,
    [sessionId, ids, MAX_TRANSCRIPT_MESSAGES],
  );
}

// ── User-affirmation heuristic (§6 tier hint, judge confirms) ───────

const USER_AFFIRMATION_RE =
  /\b(i (prefer|want|like|always|never|use|trade|hold)|my (strategy|rule|preference|approach)|please (always|never)|remember that i)\b/i;

function detectUserAffirmation(rows: readonly TranscriptRow[]): boolean {
  return rows.some((r) => r.role === "user" && USER_AFFIRMATION_RE.test(r.content));
}

/**
 * Build the judge context. The candidate is already-redacted (passed through);
 * the transcript is dereferenced + re-redacted. `userAffirmationDetected` is a
 * cheap heuristic the judge uses as the §6 tier hint (it remains authoritative).
 * `extras` (kind census + similar-candidate soft context) is computed by the
 * caller so this builder's IO stays a single bounded message SELECT.
 */
export async function buildJudgeContext(
  candidate: MemoryCandidate,
  signals: EscalationSignals,
  extras: JudgeContextExtras,
  client?: PoolClient,
): Promise<JudgeContext> {
  const exec: Executor = client ?? getPool();
  const messageIds = candidate.sourceRefs.messageIds ?? [];
  const rows = await readTranscriptRows(candidate.sessionId, messageIds, exec);

  const rendered = rows
    .map((r) => {
      const redacted = redact(r.content);
      const tool = r.tool_call_id ? ` tool=${r.tool_call_id}` : "";
      return `[${r.role}${tool}] ${redacted.text}`;
    })
    .join("\n");

  // INVARIANT: affirmation detection operates on the FULL MAX_TRANSCRIPT_MESSAGES
  // row window BEFORE the char cap below — truncating the rendered transcript
  // must never hide an affirmation from the §6 tier hint.
  const userAffirmationDetected = detectUserAffirmation(rows);

  const transcript = truncateChars(rendered, JUDGE_TRANSCRIPT_CHARS_CAP);

  return {
    sessionId: candidate.sessionId,
    candidate: {
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      contentMd: candidate.contentMd,
      importance: candidate.importance,
      confidence: candidate.confidence,
      eventTime: candidate.eventTime,
      observedAt: candidate.observedAt,
      recordedAt: candidate.recordedAt,
      availableAtDecisionTime: candidate.availableAtDecisionTime,
    },
    transcript,
    signals: { ...signals, isUserAffirmed: signals.isUserAffirmed || userAffirmationDetected },
    userAffirmationDetected,
    knownKinds: extras.knownKinds,
    similarCandidates: extras.similarCandidates,
  };
}
