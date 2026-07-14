/**
 * Messages schemas — paginated transcript reads for the chat panel.
 *
 * Renderer never receives raw DB JSONB. The main-side mapper in
 * `vex-app/src/main/database/messages-db.ts` is the single place where
 * `tool_calls` / `metadata` get reduced to allow-listed, type-safe DTO
 * fields. Field names match the canonical refs vocabulary in
 * `BUG-REPORTING.md §3` so Phase 2 BugReportSink can stamp refs without
 * a mapper (`sessionId`, `toolCallId`, `toolName`).
 *
 * Live-only by default. Archive rows are reachable later through the
 * restore/history flow that lands in puzzle 04.
 */

import { z } from "zod";
import { hyperliquidDisplayBlockSchema } from "./hyperliquid.js";

export const MESSAGES_TAIL_DEFAULT_LIMIT = 50;
export const MESSAGES_TAIL_MAX_LIMIT = 100;
export const MESSAGES_AROUND_DEFAULT_WINDOW = 10;
export const MESSAGES_AROUND_MAX_WINDOW = 50;

export const messageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * Renderer-visible message kind. Discriminator derived in the mapper
 * from `role` + `tool_calls` + `message_type`. Stage 8-4 adds the two
 * inline-marker kinds:
 *   - `compaction`: an engine-written `compaction_committed` marker row
 *     (a Track-1 compaction checkpoint), rendered as a static timeline
 *     marker — distinct from the live SessionRuntimeBar compaction chip.
 *   - `recall`: an assistant tool-call row invoking `session_memory_search`
 *     (per-session) or a `long_memory_*` read (cross-session), rendered as a
 *     static recall indicator that still shows any assistant prose.
 * Stage 9-5b adds:
 *   - `assistant_stopped`: an assistant prose row whose streaming turn was
 *     cancelled mid-response (engine `message_type` "chat_stopped"),
 *     rendered as the normal assistant bubble plus a "Stopped" badge.
 */
export const messageKindSchema = z.enum([
  "text",
  "tool_call",
  "tool_result",
  "runtime_notice",
  "error",
  "compaction",
  "recall",
  "assistant_stopped",
]);
export type MessageKind = z.infer<typeof messageKindSchema>;

/**
 * Stable cursor for forward/backward pagination over live messages.
 * Encoded as `(createdAt ISO, id)` so order is total even when two
 * messages share `created_at` (collisions are rare but possible under
 * batched writes; the SERIAL `id` is the tiebreaker).
 */
export const messageCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.number().int().positive(),
  })
  .strict();
export type MessageCursor = z.infer<typeof messageCursorSchema>;

/**
 * One displayable tool call extracted from a `tool_call` row's
 * `messages.tool_calls` JSONB. The mapper in `messages-db.ts` is the only
 * place this is built — `toolArgs` is a SANITIZED, pre-serialized JSON string
 * (secret-like keys dropped, secret-shaped values hard-redacted, size-capped)
 * so the untrusted renderer receives strings only, never raw JSONB. The
 * `.max()` bounds below are enforced at the IPC boundary by the read handlers'
 * `outputSchema: messagePageSchema`, so an oversize mapper output is rejected
 * rather than shipped.
 */
export const toolCallDisplaySchema = z
  .object({
    /** Provider tool-call id — correlates a `tool_result` back to its call. */
    toolCallId: z.string().min(1).max(200),
    /** `namespace:command` (or `command`/`name`) — string fields only. */
    toolName: z.string().min(1).max(120),
    /** Sanitized JSON string of the call args; `null` when there were none. */
    toolArgs: z.string().max(2000).nullable(),
  })
  .strict();
export type ToolCallDisplay = z.infer<typeof toolCallDisplaySchema>;

/**
 * One validated block-explorer reference projected from a tool-result row's
 * `messages.metadata -> 'explorerRefs'` (derived in the ROOT engine at
 * persistence time from the tool's structured capture). The renderer resolves
 * `{ chain, txRef }` through the shared `explorerTxUrl` builder to a deep link;
 * an unknown chain simply renders no link. Bounds mirror the engine's
 * `deriveExplorerRefs` caps so an oversize/malformed JSONB projection is
 * rejected at the mapper boundary rather than shipped.
 */
export const explorerRefSchema = z
  .object({
    chain: z.string().min(1).max(64),
    txRef: z.string().min(1).max(128),
  })
  .strict();
export type ExplorerRef = z.infer<typeof explorerRefSchema>;

/** Bounded list of explorer refs for one tool-result row (max mirrors engine). */
export const explorerRefsSchema = z.array(explorerRefSchema).max(8);

/**
 * Renderer-visible message DTO. Raw `messages.metadata` JSONB is still never
 * shipped wholesale; `explorerRefs` is the FIRST narrowly allow-listed,
 * mapper-validated projection off that column (tool-result rows only). Other
 * engine markers continue to arrive via the top-level `message_type` column —
 * the mapper collapses `runtime_notice`-shaped rows into `kind: "runtime_notice"`
 * with `content` carrying the user-visible banner only.
 */
export const sessionMessageDtoSchema = z
  .object({
    id: z.number().int().positive(),
    sessionId: z.string().uuid(),
    role: messageRoleSchema,
    kind: messageKindSchema,
    content: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    /** From `messages.tool_call_id` — present on assistant→tool replies. */
    toolCallId: z.string().nullable(),
    /**
     * Best-effort tool identifier extracted from `messages.tool_calls`
     * (first entry's `namespace:command` when both are strings, else
     * `command`, else `name`, else `"unknown"`). Refined when tool
     * registry metadata is wired in puzzle 05.
     */
    toolName: z.string().nullable(),
    /**
     * Per-call display rows for a `tool_call` row (one entry per executed
     * tool in the batch); `null` on every non-call row. Carries the
     * sanitized args the renderer reveals in its collapsible tool disclosure,
     * and the per-call id the renderer uses to label the matching
     * `tool_result` row `<toolName>_output`.
     */
    toolCalls: z.array(toolCallDisplaySchema).max(32).nullable(),
    /** Main-validated card data; renderer never brands model-authored text. */
    toolDisplayBlock: hyperliquidDisplayBlockSchema.nullable().optional(),
    /**
     * Validated block-explorer refs for a `tool_result` row (the first
     * narrowly allow-listed projection of `messages.metadata`). Required and
     * `null` on every non-tool row / when no valid refs were persisted; the
     * mapper never throws on malformed JSONB — it collapses to `null`.
     */
    explorerRefs: explorerRefsSchema.nullable(),
  })
  .strict();
export type SessionMessageDto = z.infer<typeof sessionMessageDtoSchema>;

export const messagePageSchema = z
  .object({
    items: z.array(sessionMessageDtoSchema),
    /** Cursor for the next older page; `null` when no more live history. */
    nextCursor: messageCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type MessagePage = z.infer<typeof messagePageSchema>;

export const messagesGetTailInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MESSAGES_TAIL_MAX_LIMIT)
      .default(MESSAGES_TAIL_DEFAULT_LIMIT),
  })
  .strict();
export type MessagesGetTailInput = z.infer<typeof messagesGetTailInputSchema>;

export const messagesListInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    /**
     * Cursor returned by a previous `getTail`/`list`. When omitted the
     * handler returns the same tail page that `getTail` would.
     */
    cursor: messageCursorSchema.nullable().default(null),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MESSAGES_TAIL_MAX_LIMIT)
      .default(MESSAGES_TAIL_DEFAULT_LIMIT),
  })
  .strict();
export type MessagesListInput = z.infer<typeof messagesListInputSchema>;

export const messagesGetAroundInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    messageId: z.number().int().positive(),
    before: z
      .number()
      .int()
      .min(0)
      .max(MESSAGES_AROUND_MAX_WINDOW)
      .default(MESSAGES_AROUND_DEFAULT_WINDOW),
    after: z
      .number()
      .int()
      .min(0)
      .max(MESSAGES_AROUND_MAX_WINDOW)
      .default(MESSAGES_AROUND_DEFAULT_WINDOW),
  })
  .strict();
export type MessagesGetAroundInput = z.infer<
  typeof messagesGetAroundInputSchema
>;

// ── Live event spine (agent integration puzzle 2) ─────────────────────
// `transcript-bus.ts` in `src/vex-agent/engine/events` emits a
// `TranscriptAppendEvent` after every committed `messages` INSERT. The
// main-process bridge revalidates the payload through this schema before
// `broadcastToAllWindows` — the preload re-validates per event so the
// renderer never trusts a malformed payload.
//
// Event = signal. DB stays source of truth. Renderer must fetch the DTO
// through `messages.getTail` after invalidation; it must NOT reconstruct
// the message row from the event payload.

/** Literal kept in sync with the engine `TRANSCRIPT_APPEND_EVENT_TYPE`. */
export const TRANSCRIPT_APPEND_EVENT_TYPE = "engine.transcript.append" as const;

export const transcriptAppendEventSchema = z
  .object({
    type: z.literal(TRANSCRIPT_APPEND_EVENT_TYPE),
    sessionId: z.string().uuid(),
    /** Inserted `messages.id` SERIAL PK — stable across restarts. */
    messageId: z.number().int().positive(),
    role: messageRoleSchema,
    /** Canonical ISO timestamp returned by the INSERT RETURNING clause. */
    createdAt: z.string().datetime({ offset: true }),
    /**
     * Engine marker discriminator — mirrors `messages.message_type`.
     * `null` means a plain chat row.
     */
    messageType: z.string().nullable(),
    /** Optional caller correlation id (chat turn, mission run, wake job). */
    correlationId: z.string().nullable(),
  })
  .strict();
export type TranscriptAppendEvent = z.infer<typeof transcriptAppendEventSchema>;
