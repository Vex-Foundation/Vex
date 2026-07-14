/**
 * Row → DTO mapping for the messages DB repository.
 *
 * `toDto` is the *only* place where `tool_calls` / `metadata` JSONB get
 * reduced to the allow-listed `SessionMessageDto`, and is the single mapper
 * shared by all three query paths (`getMessageTail`, `listMessages`,
 * `getMessageAround`). Raw `metadata` JSONB is deliberately never selected in
 * full; the ONLY narrow projection off that column is the validated
 * `metadata -> 'explorerRefs'` sub-key (see `MESSAGE_ROW_COLUMNS` +
 * `extractExplorerRefs`). The `message_type` top-level column remains the
 * discriminator for row kind.
 */

import {
  explorerRefsSchema,
  type ExplorerRef,
  type MessageCursor,
  type MessageKind,
  type MessageRole,
  type SessionMessageDto,
  type ToolCallDisplay,
} from "@shared/schemas/messages.js";
import {
  hyperliquidDisplayBlockSchema,
  type HyperliquidDisplayBlock,
} from "@shared/schemas/hyperliquid.js";
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
}

// Raw `metadata` JSONB is still deliberately NOT selected in full — the strict
// "metadata completely omitted" posture stands. `explorerRefs` is the FIRST
// narrowly allow-listed projection off that column: the SELECT reaches ONLY the
// `metadata -> 'explorerRefs'` sub-key (nothing else in `metadata` is exposed),
// and the mapper zod-validates it before it reaches the DTO (JSONB is untrusted
// at this boundary). The `message_type` column (migration 002) remains the
// engine's authoritative marker discriminator.
export const MESSAGE_ROW_COLUMNS =
  "id, session_id, role, content, tool_call_id, tool_calls, created_at, source, message_type, metadata -> 'explorerRefs' AS explorer_refs";

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
  if (cmd !== null) return cmd;
  const name = typeof rec["name"] === "string" ? rec["name"] : null;
  return name;
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
    const toolName = ns !== null && cmd !== null ? `${ns}:${cmd}` : (cmd ?? name);
    if (id === null || toolName === null) continue; // skip malformed — no coercion
    out.push({
      toolCallId: id.slice(0, 200),
      toolName: toolName.slice(0, 120),
      toolArgs: sanitizeToolArgs(rec["args"]),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Tool output is normally plain text. Only a bounded JSON payload containing
 * a strict shared display block may render in the Hyperliquid protocol frame.
 * Model prose and malformed values remain ordinary text.
 */
function extractHyperliquidDisplayBlock(
  content: string | null,
): HyperliquidDisplayBlock | null {
  if (content === null || content.length === 0 || content.length > 20_000) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result = hyperliquidDisplayBlockSchema.safeParse(
      (parsed as Record<string, unknown>)["_displayBlock"],
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
  if (row.message_type !== null && row.message_type !== "chat") {
    // Other engine markers (wake banners, overflow stubs, runtime
    // notices) surface as the catch-all "runtime_notice" kind.
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
    toolDisplayBlock:
      row.role === "tool" ? extractHyperliquidDisplayBlock(row.content) : null,
    explorerRefs: extractExplorerRefs(row),
  };
}

export function nextCursorFor(items: readonly SessionMessageDto[]): MessageCursor | null {
  if (items.length === 0) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return { createdAt: last.createdAt, id: last.id };
}
