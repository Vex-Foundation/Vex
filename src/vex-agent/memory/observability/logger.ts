/**
 * Memory-scoped structured logger primitive.
 *
 * Wraps `createChildLogger` from `@utils/logger.js` to emit memory-domain
 * telemetry under a stable, namespaced event name: `memory.<area>.<event>`.
 *
 * This is a STRUCTURAL safety primitive, not a convenience wrapper. The memory
 * subsystem handles candidate payloads, transcripts, and wallet-adjacent
 * context, so the logger MUST make it impossible to leak raw content or secrets
 * through a stray meta field. Guarantees enforced by `filterMemoryLogMeta`:
 *
 * - Event-name tokens (`area`, `event`) must match `^[a-z][a-z0-9_]*$`. An
 *   invalid token is a programmer error at our own call sites, so it THROWS
 *   rather than emitting a malformed event name.
 * - Only the keys in `META_KEY_CATEGORY` survive; every other key is DROPPED.
 *   By design there is NO free-text / content / secret key (`content`,
 *   `errorMessage`, `summary`, `title`, `body`, `text`, `params`, `result`,
 *   `query`, `prompt`, `payload`, `raw`, `secret`, …). Errors are reported as
 *   bounded `errorCode` / `errorKind`, never as a free-text message.
 * - Only scalar `string | number` values survive (no boolean), and each
 *   allowlisted key has a fixed CATEGORY that further constrains its value:
 *     • `num`  (count, attempt, durationMs, redactionCount, embeddingDim,
 *               similarity, queueDepth): kept ONLY if a finite number.
 *     • `enum` (decision, status, statusFrom, statusTo, rejectReason, kind,
 *               insertResult, errorCode, errorKind): a string is kept only if it matches
 *               `^[A-Za-z][A-Za-z0-9_]*$` AND is ≤ MEMORY_LOG_MAX_ENUM (64)
 *               chars. This rejects free-text (spaces/punctuation) and most
 *               secret tokens.
 *     • `id`   (correlationId, candidateId, jobId, sessionId, conversationId,
 *               promotedKnowledgeId, embeddingModel): a string is kept only if
 *               it matches the bounded id charset `^[A-Za-z0-9._:/-]+$`
 *               (UUIDs, nanoids, model ids like `ai/embeddinggemma:300M-Q8_0`);
 *               whitespace/free-text is rejected.
 *   A finite NUMBER cannot encode free-text or a secret: `num` keys accept ONLY
 *   a finite number, and `id` keys also accept one (numeric DB ids, e.g.
 *   `promotedKnowledgeId`). `enum` keys are string tokens, so a number on an
 *   enum key is DROPPED. Non-finite numbers (NaN / ±Infinity) and every
 *   non-scalar (boolean, object, array, null, undefined) are DROPPED.
 * - SECRET-PATTERN GUARD: every kept STRING value must survive TWO complementary,
 *   fail-closed checks; numbers skip both.
 *     (1) CREDENTIAL-PREFIX guard — the trimmed value must NOT begin with a
 *         well-known credential token (`CREDENTIAL_PREFIX`: `sk-`/`sk_`/`pk_`/
 *         `rk_`, GitHub `ghp_`/`gho_`/`ghs_`/`github_pat_`, Slack `xox[baprs]-`,
 *         AWS `AKIA`/`ASIA`, Google `AIza`/`ya29.`, JWT `eyJ`, PEM `-----BEGIN`).
 *         This drops credential-prefixed strings REGARDLESS of length, so it is
 *         an EQUIVALENT secret-pattern guard COMPLEMENTING the canonical redactor,
 *         whose API-key rule has a 20-char length threshold. It closes the case of
 *         a short token like `sk-live-do-not-leak` (only 16 chars after `sk-`,
 *         below that threshold, so `redact` returns 0/0 and the id charset — which
 *         must keep accepting `-` for real ids — cannot reject it).
 *     (2) CANONICAL REDACTOR — the value is run through `redact` (the two-tier
 *         redactor). If it detects ANYTHING — `hardRedactCount > 0` (mnemonic /
 *         labelled private key / API key / JWT) or `maskCount > 0` (EVM/Solana
 *         address / tx hash) — the key is DROPPED ENTIRELY. A detected secret is
 *         never logged, not even masked, in a structured field.
 *   The id charset itself is deliberately NOT narrowed to chase secret-looking
 *   tokens — doing so would reject legitimate UUIDs/ids; secret coverage belongs
 *   in these two guards (prefix + redactor), not in the charset.
 * - Per-value order: type check → category shape gate → credential-prefix drop →
 *   redact() drop → defense-in-depth ≤ MEMORY_LOG_MAX_STRING (200) length cap.
 *   Enum tokens are already ≤ 64; an id string longer than 200 is TRUNCATED
 *   (199 chars + a trailing "…"), never dropped or emitted unbounded.
 *
 * Behavior note (S0): this is a primitive only. It is intentionally NOT wired
 * into any handler yet (`InternalToolContext` has no correlationId/toolCallId
 * and we do not fabricate ids); the first real consumers arrive in S1.
 */

import { createChildLogger } from "@utils/logger.js";
import { redact } from "../redaction.js";

/** Token shape for the `area` and `event` segments of the event name. */
const EVENT_TOKEN_RE = /^[a-z][a-z0-9_]*$/;

/** Maximum length of any string meta value before defensive truncation. */
export const MEMORY_LOG_MAX_STRING = 200;

/** Maximum length of an enum-token string value (enum tokens are short). */
const MEMORY_LOG_MAX_ENUM = 64;

/**
 * Enum-token shape: a leading letter then letters/digits/underscores. Rejects
 * whitespace, punctuation, and leading digits — i.e. free-text and most secrets.
 */
const ENUM_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Id charset: letters, digits, and `. _ : / -`. Accepts UUIDs, nanoids, and
 * model ids (`ai/embeddinggemma:300M-Q8_0`); rejects whitespace/free-text.
 * Length is intentionally unbounded here and enforced by the truncation cap so
 * an over-long id is bounded (not dropped); see `filterMemoryLogMeta`.
 */
const ID_TOKEN_RE = /^[A-Za-z0-9._:/-]+$/;

/**
 * Credential-prefix guard. A string meta value whose trimmed form BEGINS with a
 * well-known credential token is dropped regardless of length — an equivalent
 * secret-pattern guard that COMPLEMENTS the canonical redactor (whose API-key
 * rule has a 20-char threshold) rather than replacing it. It closes the gap
 * where `redact` returns 0/0 for a short token like `sk-live-do-not-leak`
 * (only 16 chars after `sk-`) that still satisfies the id charset. Covers
 * OpenAI/Stripe-style keys (`sk-`/`sk_`/`pk_`/`rk_`), GitHub tokens
 * (`ghp_`/`gho_`/`ghs_`/`github_pat_`), Slack tokens (`xox[baprs]-`), AWS access
 * keys (`AKIA`/`ASIA`), Google API keys (`AIza`) / OAuth tokens (`ya29.`), JWTs
 * (`eyJ`), and PEM blocks (`-----BEGIN`).
 */
const CREDENTIAL_PREFIX =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|eyJ|-----BEGIN)/;

/** Severity levels supported by the memory logger. */
type MemoryLogLevel = "info" | "warn" | "error";

/**
 * Value category for an allowlisted meta key. Drives per-value validation:
 * `num` keys accept only finite numbers; `enum`/`id` keys accept finite numbers
 * or a category-shaped, secret-free string.
 */
type MetaCategory = "num" | "enum" | "id";

/**
 * Allowlisted, structurally-safe meta fields for memory telemetry.
 *
 * Declared as a closed object type (not an interface) so it stays assignable to
 * `Record<string, unknown>` for the runtime guard. Values are intentionally
 * typed `string | number` only — `createChildLogger` accepts
 * `string | number | undefined`, and `filterMemoryLogMeta` is the runtime
 * structural guarantee that nothing else (boolean, object, array, a
 * non-allowlisted key, a wrong-shaped string, or a secret) ever reaches a
 * transport.
 */
export type MemoryLogMeta = {
  readonly correlationId?: string | number;
  readonly candidateId?: string | number;
  readonly jobId?: string | number;
  readonly sessionId?: string | number;
  readonly conversationId?: string | number;
  /** memory_entities.id (S1d — knowledge-graph node). */
  readonly entityId?: string | number;
  /** memory_edges.id (S1d — knowledge-graph edge). */
  readonly edgeId?: string | number;
  /** knowledge_entries.id (S1d — junction provenance / origin entry). */
  readonly entryId?: string | number;
  /** memory_entities.entity_type (S1d — bounded enum). */
  readonly entityType?: string | number;
  /** memory_edges.relation (S1d — bounded enum). */
  readonly relation?: string | number;
  readonly decision?: string | number;
  /** memory_decisions.decision_type (S4 — bounded enum verdict). */
  readonly decisionType?: string | number;
  /** memory_decisions.decision_version (S4 — re-decision counter; 0 in S4). */
  readonly decisionVersion?: string | number;
  /** memory_decisions.id (S4 — append-only audit row, BIGINT → string). */
  readonly decisionId?: string | number;
  /** knowledge_entries.id superseded by a supersede decision (S4). */
  readonly supersedesKnowledgeId?: string | number;
  /** Candidate evidence-strength ceiling derived by the deref (S4 — bounded enum). */
  readonly evidenceStrength?: string | number;
  /** Resolved outcome lifecycle status (S5 — bounded enum: open|closed|settled|failed|invalidated). */
  readonly outcomeStatus?: string | number;
  /** Outcome lesson direction (S5 — bounded enum: positive|negative|mixed|neutral). */
  readonly lessonSignal?: string | number;
  /** How well the outcome is grounded in ledger facts (S5 — bounded enum: weak|medium|strong). */
  readonly evidenceQuality?: string | number;
  /** No-lookahead gate result (S5 — bool serialized to "true"/"false" by the caller). */
  readonly pointInTimeChecked?: string | number;
  /** Anchored execution product family (S5 — bounded enum: spot|perps|prediction|…). */
  readonly productType?: string | number;
  /** Outcome reconciliation counter (S5 init 0; S7 bumps). */
  readonly outcomeVersion?: string | number;
  /** Reconcile consequence applied (S7 — bounded enum: reinforce|quench|invalidate|retain|bookkeep|tier_raise). */
  readonly reconcileAction?: string | number;
  /** Active entries a ledger wake matched (S7 — number). */
  readonly matchedEntries?: string | number;
  /** Reconcile jobs freshly enqueued by a ledger wake (S7 — number). */
  readonly enqueuedJobs?: string | number;
  /** Distinct-execution recurrence count behind a generalization (S4 — D-REC). */
  readonly recurrenceCount?: string | number;
  /** LLM calls made deciding a candidate / batch (S4 — judge cost telemetry). */
  readonly llmCalls?: string | number;
  /** Accumulated USD cost of a decision's inference (S4). */
  readonly costUsd?: string | number;
  /** knowledge_maturity_events.event (S6a — bounded enum: matured|reinforced|decayed|reactivated). */
  readonly maturityEvent?: string | number;
  /** maturity_state BEFORE a transition (S6a — bounded enum). */
  readonly fromState?: string | number;
  /** maturity_state AFTER a transition (S6a — bounded enum). */
  readonly toState?: string | number;
  /** knowledge_maturity_events.reason_code (S6a — bounded enum). */
  readonly reasonCode?: string | number;
  /** activation_strength BEFORE a transition (S6a — 0..1 number). */
  readonly activationBefore?: string | number;
  /** activation_strength AFTER a transition (S6a — 0..1 number). */
  readonly activationAfter?: string | number;
  /** Days since last reinforcement at a decay step (S6a — number). */
  readonly daysSinceReinforced?: string | number;
  /** regime_snapshots.trend_label (S6b — bounded enum: bull|bear|range|unknown). */
  readonly regimeTrend?: string | number;
  /** regime_snapshots.vol_label (S6b — bounded enum: high|low|unknown). */
  readonly regimeVol?: string | number;
  /** regime_snapshots.confidence (S6b — bounded enum: low|medium|high). */
  readonly regimeConfidence?: string | number;
  /** regime_snapshots.source (S6b — bounded enum: tavily|twitter|hybrid). */
  readonly regimeSource?: string | number;
  /** regime_snapshots.id (S6b — SERIAL, plain number). */
  readonly regimeSnapshotId?: string | number;
  /** Entities asserted by one graph extraction (S8 — number). */
  readonly entityCount?: string | number;
  /** Edges asserted by one graph extraction (S8 — number). */
  readonly edgeCount?: string | number;
  /** entry↔entity links written by one graph extraction (S8 — number). */
  readonly linkCount?: string | number;
  /** Graph-expansion results served by one search (S8 — number). */
  readonly expandedCount?: string | number;
  /** Seed results that fed one graph expansion (S8 — number). */
  readonly seedCount?: string | number;
  readonly status?: string | number;
  readonly statusFrom?: string | number;
  readonly statusTo?: string | number;
  readonly rejectReason?: string | number;
  readonly kind?: string | number;
  /** memory_jobs.job_kind: "consolidate" | "reconcile" (S1c — bounded enum). */
  readonly jobKind?: string | number;
  /** Insert outcome for an idempotent upsert: "inserted" | "duplicate" (MF2 — logged in place of the rejected boolean `inserted`). */
  readonly insertResult?: string | number;
  readonly count?: string | number;
  readonly attempt?: string | number;
  readonly durationMs?: string | number;
  readonly redactionCount?: string | number;
  readonly promotedKnowledgeId?: string | number;
  readonly embeddingModel?: string | number;
  readonly embeddingDim?: string | number;
  readonly similarity?: string | number;
  readonly queueDepth?: string | number;
  readonly errorCode?: string | number;
  readonly errorKind?: string | number;
  /**
   * HTTP status of a failed provider call, read from the own-property
   * `normalizeOpenRouterError` attaches. A number cannot carry free text, which
   * is why this is the ONLY part of a provider rejection that reaches a log
   * line verbatim — the message itself stays out by allowlist design.
   */
  readonly statusCode?: string | number;
  /** errno-shaped transport cause (`ECONNRESET`, …) — bounded token, no text. */
  readonly causeCode?: string | number;
};

/**
 * Single source of truth: every `MemoryLogMeta` key mapped to its value
 * category. `Record<keyof MemoryLogMeta, MetaCategory>` forces this map to list
 * every key (missing one fails compile) and reject any key not on the type
 * (extra one fails compile), and forces a category choice when a key is added —
 * so the runtime allowlist + per-key validation can never drift from the type.
 */
const META_KEY_CATEGORY: Record<keyof MemoryLogMeta, MetaCategory> = {
  correlationId: "id",
  candidateId: "id",
  jobId: "id",
  sessionId: "id",
  conversationId: "id",
  entityId: "id",
  edgeId: "id",
  entryId: "id",
  entityType: "enum",
  relation: "enum",
  decision: "enum",
  decisionType: "enum",
  decisionVersion: "num",
  decisionId: "id",
  supersedesKnowledgeId: "id",
  evidenceStrength: "enum",
  outcomeStatus: "enum",
  lessonSignal: "enum",
  evidenceQuality: "enum",
  pointInTimeChecked: "enum",
  productType: "enum",
  outcomeVersion: "num",
  reconcileAction: "enum",
  matchedEntries: "num",
  enqueuedJobs: "num",
  recurrenceCount: "num",
  llmCalls: "num",
  costUsd: "num",
  maturityEvent: "enum",
  fromState: "enum",
  toState: "enum",
  reasonCode: "enum",
  activationBefore: "num",
  activationAfter: "num",
  daysSinceReinforced: "num",
  regimeTrend: "enum",
  regimeVol: "enum",
  regimeConfidence: "enum",
  regimeSource: "enum",
  regimeSnapshotId: "num",
  entityCount: "num",
  edgeCount: "num",
  linkCount: "num",
  expandedCount: "num",
  seedCount: "num",
  status: "enum",
  statusFrom: "enum",
  statusTo: "enum",
  rejectReason: "enum",
  kind: "enum",
  jobKind: "enum",
  insertResult: "enum",
  count: "num",
  attempt: "num",
  durationMs: "num",
  redactionCount: "num",
  promotedKnowledgeId: "id",
  embeddingModel: "id",
  embeddingDim: "num",
  similarity: "num",
  queueDepth: "num",
  errorCode: "enum",
  errorKind: "enum",
  statusCode: "num",
  causeCode: "enum",
};

/**
 * Runtime allowlist + category lookup, derived from `META_KEY_CATEGORY`. A
 * `Map` keyed by `string` lets us look a raw (untrusted) key up without a type
 * assertion: `.get()` returns the category or `undefined` for non-allowlisted.
 */
const META_CATEGORY_BY_KEY: ReadonlyMap<string, MetaCategory> = new Map(
  Object.entries(META_KEY_CATEGORY),
);

/**
 * Filter untrusted meta down to the allowlisted, scalar, category-validated,
 * secret-free, length-bounded set. Returns a fresh object containing only safe
 * entries. Exported so the structural guard is unit-testable without capturing
 * transport output.
 *
 * Per entry: drop non-allowlisted keys; keep a finite number on `num`/`id` keys
 * (dropped on `enum`); for `enum`/`id` strings apply the category shape gate,
 * then drop the key if its trimmed value begins with a known credential prefix
 * or if `redact` detects any secret / address / tx-hash, then apply the
 * defense-in-depth length cap (id strings over the cap are truncated, never
 * dropped).
 */
export function filterMemoryLogMeta(
  meta: Readonly<Record<string, unknown>>,
): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(meta)) {
    const category = META_CATEGORY_BY_KEY.get(key);
    if (category === undefined) continue; // not allowlisted → DROP

    // A finite number cannot encode free-text or a secret. `num` keys accept
    // ONLY this; `id` keys also accept it (numeric DB ids, e.g.
    // promotedKnowledgeId). `enum` keys are categorical string tokens — a number
    // is never a valid enum value, so it is dropped here.
    if (typeof value === "number") {
      if (category !== "enum" && Number.isFinite(value)) safe[key] = value;
      continue; // enum-number / NaN / ±Infinity → DROP
    }
    if (category === "num") continue; // numeric key, non-number → DROP

    // Enum/id keys carry strings only; boolean/object/array/null/undefined → DROP.
    if (typeof value !== "string") continue;

    // Category shape gate (fail-closed): rejects whitespace/free-text and, for
    // enum, over-long tokens. id length is enforced by the truncation cap below.
    let shapeOk: boolean;
    switch (category) {
      case "enum":
        shapeOk = ENUM_TOKEN_RE.test(value) && value.length <= MEMORY_LOG_MAX_ENUM;
        break;
      case "id":
        shapeOk = ID_TOKEN_RE.test(value);
        break;
      default:
        shapeOk = false; // unreachable today; fail-closed for any future category
    }
    if (!shapeOk) continue;

    // Secret-pattern guard — two complementary, fail-closed checks; a kept
    // string must survive BOTH.
    // 1. Credential-prefix guard: drop values that look like a credential token,
    //    regardless of length. This catches short secrets the redactor misses
    //    because its API-key rule has a 20-char threshold (e.g.
    //    `sk-live-do-not-leak`). Trim defensively so surrounding whitespace
    //    cannot hide the prefix (the shape gate already rejects whitespace today).
    if (CREDENTIAL_PREFIX.test(value.trim())) continue;
    // 2. Canonical redactor: if it flags ANY secret / address / tx-hash, drop the
    //    key entirely — never emit it, not even masked.
    const { hardRedactCount, maskCount } = redact(value);
    if (hardRedactCount > 0 || maskCount > 0) continue;

    // Defense-in-depth length cap. Enum tokens are already ≤ MEMORY_LOG_MAX_ENUM;
    // an over-long id is TRUNCATED (199 chars + "…"), never dropped or unbounded.
    safe[key] =
      value.length > MEMORY_LOG_MAX_STRING
        ? `${value.slice(0, MEMORY_LOG_MAX_STRING - 1)}…`
        : value;
  }
  return safe;
}

function assertValidToken(kind: "area" | "event", token: string): void {
  if (!EVENT_TOKEN_RE.test(token)) {
    throw new Error(
      `memLog ${kind} token must match ${EVENT_TOKEN_RE.source} (got: "${token}")`,
    );
  }
}

/**
 * Build the namespaced event name `memory.<area>.<event>`. Throws if either
 * token is malformed (programmer error at our own call sites). Exported so the
 * naming contract is unit-testable without a transport.
 */
export function buildMemoryEventName(area: string, event: string): string {
  assertValidToken("area", area);
  assertValidToken("event", event);
  return `memory.${area}.${event}`;
}

function emit(
  level: MemoryLogLevel,
  area: string,
  event: string,
  meta?: MemoryLogMeta,
): void {
  const eventName = buildMemoryEventName(area, event);
  const safeMeta = meta === undefined ? {} : filterMemoryLogMeta(meta);
  const child = createChildLogger(safeMeta);
  if (level === "warn") {
    child.warn(eventName);
  } else if (level === "error") {
    child.error(eventName);
  } else {
    child.info(eventName);
  }
}

interface MemLog {
  /** Emit `memory.<area>.<event>` at info level with filtered meta. */
  (area: string, event: string, meta?: MemoryLogMeta): void;
  /** Emit `memory.<area>.<event>` at warn level with filtered meta. */
  warn(area: string, event: string, meta?: MemoryLogMeta): void;
  /** Emit `memory.<area>.<event>` at error level with filtered meta. */
  error(area: string, event: string, meta?: MemoryLogMeta): void;
}

/**
 * Memory-scoped structured logger. `memLog(area, event, meta)` emits at info;
 * `memLog.warn` / `memLog.error` emit at the matching level. The event name is
 * `memory.<area>.<event>` and `meta` is filtered by `filterMemoryLogMeta`.
 */
export const memLog: MemLog = Object.assign(
  (area: string, event: string, meta?: MemoryLogMeta): void =>
    emit("info", area, event, meta),
  {
    warn: (area: string, event: string, meta?: MemoryLogMeta): void =>
      emit("warn", area, event, meta),
    error: (area: string, event: string, meta?: MemoryLogMeta): void =>
      emit("error", area, event, meta),
  },
);
