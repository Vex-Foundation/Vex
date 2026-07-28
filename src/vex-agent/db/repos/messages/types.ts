/**
 * Messages repo — public row + domain types.
 *
 * Extended with engine metadata (source, messageType, visibility,
 * originSessionId) — backwards-compatible, all optional.
 */

export interface MessageRow {
  id: number;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: unknown;
  created_at: string | Date;
  source: string | null;
  message_type: string | null;
  visibility: string | null;
  origin_session_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; command: string; args: Record<string, unknown> }>;
  timestamp: string;
  /**
   * DB primary key — populated by `getLiveMessages` / `getLiveMessagesWithId`
   * / `getAllMessages`. In-memory rows constructed in the turn loop leave this
   * undefined; never trust an undefined id for cutoff computation.
   */
  id?: number;
  /**
   * Engine metadata. `messageType` / `source` / `visibility` come from the
   * dedicated columns (set by the existing `addMessage` contract); `payload`
   * is the free-form JSONB envelope introduced by PR-7 (wake banners carry
   * `{ reason, dueAt }`). LEGACY ONLY: rows written before D-4 may still carry
   * `{ overflow, blobKey, … }` from the removed blob mechanism — tolerated on
   * read, never produced. Every consumer MUST treat `payload` as untrusted.
   */
  metadata?: MessageMetadata | null;
}

/** Message variant with a guaranteed id — returned by `getLiveMessagesWithId`. */
export type MessageWithId = Message & { id: number };

/**
 * Engine metadata — all fields optional for backwards compatibility.
 *
 * `payload` (PR-7) is the free-form envelope persisted into the
 * `messages.metadata` JSONB column. Shape is intentionally loose so new
 * engine-written message kinds (wake banners, legacy overflow stubs, …) can extend
 * without a migration. Every producer MUST define its own shape in code and
 * treat `payload` as untrusted when reading.
 */
export interface MessageMetadata {
  source?: string;
  messageType?: string;
  visibility?: string;
  originSessionId?: string;
  payload?: Record<string, unknown>;
}
