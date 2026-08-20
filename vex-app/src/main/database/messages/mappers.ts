/**
 * Row → DTO mapping for the messages DB repository.
 *
 * `toDto` is the *only* place where `tool_calls` / `metadata` JSONB get
 * reduced to the allow-listed `SessionMessageDto`, and is the single mapper
 * shared by all three query paths (`getMessageTail`, `listMessages`,
 * `getMessageAround`). Raw `metadata` JSONB is deliberately never selected in
 * full; every read off that column is a NARROW, individually validated sub-key
 * projection (see `MESSAGE_ROW_COLUMNS`): `explorerRefs`, `success`,
 * `reasoning`, `durationMs`, and `displayStatus` — five of them today, each
 * with its own fail-to-null schema. The `message_type` top-level column remains the
 * discriminator for row kind.
 *
 * TOOL NAMES ARE CANONICALIZED HERE. A discovered protocol manifest is called
 * by the model under its OpenAI-legal wire name (`kyberswap__swap__quote`), and
 * the persisted row keeps that name. The DTO carries the dotted `toolId` the
 * human-facing surfaces speak (`canonicalToolName`); a name the live catalog
 * cannot resolve is passed through verbatim, so nothing can borrow a venue's
 * identity downstream. No schema field and no bound changes.
 */

import {
  explorerRefsSchema,
  reasoningProjectionSchema,
  toolDurationMsProjectionSchema,
  toolDisplayStatusProjectionSchema,
  toolSuccessProjectionSchema,
  type ExplorerRef,
  type MessageCursor,
  type MessageKind,
  type MessageRole,
  type SessionMessageDto,
  type ToolCallDisplay,
  type ToolDisplayStatus,
} from "@shared/schemas/messages.js";
import { canonicalToolName } from "../../agent/tool-name-canonical.js";
import { sanitizeToolArgs } from "./redaction.js";

export interface MessageRow {
  readonly id: number;
  readonly session_id: string;
  readonly role: string;
  readonly content: string | null;
  readonly tool_call_id: string | null;
  readonly tool_calls: unknown;
  readonly created_at: string | Date;
  readonly source: string | null;
  readonly message_type: string | null;
  /** ONLY the `explorerRefs` sub-key of `messages.metadata` (never raw metadata). */
  readonly explorer_refs: unknown;
  /** ONLY the `reasoning` sub-key of `messages.metadata` (assistant rows). */
  readonly reasoning: unknown;
  /** ONLY the `durationMs` sub-key of `messages.metadata` (tool-result rows). */
  readonly duration_ms: unknown;
  /** ONLY the `success` sub-key of `messages.metadata` (tool-result rows). */
  readonly success: unknown;
  /** ONLY the `displayStatus` sub-key of `messages.metadata` (tool-result rows). */
  readonly display_status: unknown;
}

// Raw `metadata` JSONB is still deliberately NOT selected in full — the strict
// "metadata completely omitted" posture stands. Exactly FOUR narrowly
// allow-listed sub-key projections exist (`explorerRefs`, `reasoning`,
// `durationMs`, `success`); the SELECT reaches only those sub-keys and the mapper
// zod-validates each before it reaches the DTO (JSONB is untrusted at this
// boundary). The `message_type` column (migration 002) remains the engine's
// authoritative marker discriminator.
export const MESSAGE_ROW_COLUMNS =
  "id, session_id, role, content, tool_call_id, tool_calls, created_at, source, message_type, metadata -> 'explorerRefs' AS explorer_refs, metadata -> 'reasoning' AS reasoning, metadata -> 'durationMs' AS duration_ms, metadata -> 'success' AS success, metadata -> 'displayStatus' AS display_status";

export function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normaliseRole(raw: string): MessageRole {
  if (raw === "user" || raw === "assistant" || raw === "tool") return raw;
  return "system";
}

/**
 * Best-effort tool identifier extraction from `messages.tool_calls`
 * JSONB. Allow-listed: only string-typed fields ever feed back into the
 * DTO. Anything else (numbers, arrays, nested objects) is treated as
 * absent so a malicious payload can't smuggle data past the boundary.
 *
 * Preference order: `namespace:command` (when both are strings) →
 * `command` → `name` → `null`.
 */
function extractToolName(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (first === null || typeof first !== "object") return null;
  const rec = first as Record<string, unknown>;
  const ns = typeof rec["namespace"] === "string" ? rec["namespace"] : null;
  const cmd = typeof rec["command"] === "string" ? rec["command"] : null;
  if (ns !== null && cmd !== null) return `${ns}:${cmd}`;
  if (cmd !== null) return canonicalToolName(cmd);
  const name = typeof rec["name"] === "string" ? rec["name"] : null;
  return name === null ? null : canonicalToolName(name);
}

function hasToolCalls(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
}

/**
 * Per-call display rows from `messages.tool_calls`. String fields only (no
 * coercion); malformed entries are skipped; capped at 32 calls. `null` when
 * the row carries no tool calls.
 */
function extractToolCalls(raw: unknown): ToolCallDisplay[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ToolCallDisplay[] = [];
  for (const entry of raw) {
    if (out.length >= 32) break;
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    // String fields only, AND non-empty: the DTO schema requires min-length 1,
    // so an empty id/name would make the whole page fail IPC output validation.
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    const id = str(rec["id"]);
    const ns = str(rec["namespace"]);
    const cmd = str(rec["command"]);
    const name = str(rec["name"]);
    const rawToolName = ns !== null && cmd !== null ? `${ns}:${cmd}` : (cmd ?? name);
    if (id === null || rawToolName === null) continue; // skip malformed — no coercion
    out.push({
      toolCallId: id.slice(0, 200),
      // Canonical BEFORE the cap: the dotted id is what the renderer and the
      // Markdown export read, and it is never longer than the wire name.
      toolName: canonicalToolName(rawToolName).slice(0, 120),
      toolArgs: sanitizeToolArgs(rec["args"]),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Tool names whose assistant tool-call row renders as a static recall
 * indicator (`kind: "recall"`, stage 8-4 + S9 rename). `session_memory_search`
 * is per-session narrative memory; the `long_memory_*` reads are durable
 * cross-session memory — the renderer keeps the copy distinct.
 */
const RECALL_TOOL_NAMES = new Set([
  "session_memory_search",
  "long_memory_search",
  "long_memory_get",
  "long_memory_history",
]);

/**
 * Engine `message_type` for a Track-1 compaction checkpoint marker
 * (stage 8-4). Matched exactly so other engine markers stay
 * `runtime_notice`.
 */
const COMPACTION_MARKER_MESSAGE_TYPE = "compaction_committed";

/**
 * Engine `message_type` for a chat turn whose streaming was cancelled
 * mid-response (stage 9-5b). Surfaces as the `assistant_stopped` kind.
 */
const CHAT_STOPPED_MESSAGE_TYPE = "chat_stopped";

/**
 * Derive renderer-visible `kind` from row shape using the top-level
 * `message_type` column + the (already allow-list-extracted) tool name.
 * `metadata` JSONB is intentionally never selected.
 */
function deriveKind(row: MessageRow, toolName: string | null): MessageKind {
  if (row.role === "tool") return "tool_result";
  if (hasToolCalls(row.tool_calls)) {
    if (toolName !== null && RECALL_TOOL_NAMES.has(toolName)) return "recall";
    return "tool_call";
  }
  if (row.message_type === COMPACTION_MARKER_MESSAGE_TYPE) return "compaction";
  // A cancelled chat turn (engine `message_type` "chat_stopped", 9-5b) is
  // assistant prose with a "Stopped" badge, not a generic runtime notice.
  // Role-guarded defensively: the engine only ever writes it on an
  // assistant row (partial content, tool_calls null).
  if (row.role === "assistant" && row.message_type === CHAT_STOPPED_MESSAGE_TYPE) {
    return "assistant_stopped";
  }
  // A user's own mission-setup input is their message, not a system marker —
  // surface it as normal text so it renders as a user/assistant turn instead
  // of the centered-uppercase notice styling.
  if (row.message_type === "mission_setup") return "text";
  // A33: a user message steered into a live turn is the user's prose, not a
  // system marker - it renders as a user row with a "steered" register mark.
  if (row.role === "user" && row.message_type === "operator_interrupt") {
    return "steering";
  }
  if (row.message_type !== null && row.message_type !== "chat") {
    // Other engine markers (wake banners, LEGACY pre-D-4 overflow stubs from
    // the removed blob mechanism, runtime notices) surface as the catch-all
    // "runtime_notice" kind.
    return "runtime_notice";
  }
  return "text";
}

/**
 * Validate the `metadata -> 'explorerRefs'` JSONB projection at the DB boundary.
 * ONLY tool-result rows carry refs; every other row → `null`. Malformed,
 * oversize, or wrong-typed JSONB → `null` (never throws) so one bad row cannot
 * poison the page. Empty arrays also collapse to `null` — the renderer treats
 * "no refs" and "no valid refs" identically.
 */
function extractExplorerRefs(row: MessageRow): ExplorerRef[] | null {
  if (row.role !== "tool") return null;
  const parsed = explorerRefsSchema.safeParse(row.explorer_refs);
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data;
}

/**
 * Validate the `metadata -> 'reasoning'` projection. ONLY assistant rows carry
 * reasoning; malformed/oversize/empty JSONB → `null` (never throws), same
 * fail-to-null posture as `extractExplorerRefs`.
 */
function extractReasoning(row: MessageRow): string | null {
  if (row.role !== "assistant") return null;
  const parsed = reasoningProjectionSchema.safeParse(row.reasoning);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate the `metadata -> 'durationMs'` projection. ONLY tool-result rows
 * carry a duration; anything malformed (negative, fractional, > 24h,
 * non-number) → `null`. A synthetic never-executed result persists no
 * duration, so `null` here also means "did not run" — the renderer must not
 * render it as `0`.
 */
function extractDurationMs(row: MessageRow): number | null {
  if (row.role !== "tool") return null;
  const parsed = toolDurationMsProjectionSchema.safeParse(row.duration_ms);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate the `metadata -> 'success'` projection. ONLY tool-result rows carry
 * an outcome; anything non-boolean → `null` = UNKNOWN. Callers must never
 * treat null as success.
 */
function extractSuccess(row: MessageRow): boolean | null {
  if (row.role !== "tool") return null;
  const parsed = toolSuccessProjectionSchema.safeParse(row.success);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate the `metadata -> 'displayStatus'` projection. ONLY tool-result rows
 * carry one; anything that is not the exact `"pending"` literal → `null` =
 * no display status, and the row then renders off `success` exactly as before.
 * This never overrides `success`; it only splits the `false` case in the UI.
 */
function extractDisplayStatus(row: MessageRow): ToolDisplayStatus | null {
  if (row.role !== "tool") return null;
  const parsed = toolDisplayStatusProjectionSchema.safeParse(row.display_status);
  return parsed.success ? parsed.data : null;
}

export function toDto(row: MessageRow): SessionMessageDto {
  // Extract the tool name once: it drives BOTH the recall-kind decision
  // and the DTO's `toolName` field.
  const toolName = extractToolName(row.tool_calls);
  return {
    id: row.id,
    sessionId: row.session_id,
    role: normaliseRole(row.role),
    kind: deriveKind(row, toolName),
    content: row.content ?? "",
    createdAt: toIso(row.created_at),
    toolCallId: row.tool_call_id,
    toolName,
    // Per-call disclosure rows (sanitized args + ids for result correlation).
    // `null` on every non-call row (extractToolCalls returns null for
    // null/empty `tool_calls`).
    toolCalls: extractToolCalls(row.tool_calls),
    explorerRefs: extractExplorerRefs(row),
    reasoning: extractReasoning(row),
    durationMs: extractDurationMs(row),
    success: extractSuccess(row),
    displayStatus: extractDisplayStatus(row),
  };
}

export function nextCursorFor(items: readonly SessionMessageDto[]): MessageCursor | null {
  if (items.length === 0) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return { createdAt: last.createdAt, id: last.id };
}
