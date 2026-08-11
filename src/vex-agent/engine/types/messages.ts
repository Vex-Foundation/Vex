/**
 * Message taxonomy and the engine metadata attached to messages.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 */

// ── Message taxonomy ────────────────────────────────────────────

export type MessageSource =
  | "user"
  | "assistant"
  | "engine"
  | "tool"
  | "system";

export type MessageType =
  | "chat"
  /** A chat turn whose streaming was stopped mid-response (Stage 9-5a). */
  | "chat_stopped"
  | "mission_setup"
  | "mission_summary"
  | "mission_recovered"
  | "mission_started"
  | "operator_interrupt"
  | "approval_pause"
  | "continue"
  | "checkpoint"
  | "wake_due"
  | "tool_result"
  /**
   * A trusted prepare→execute handoff the engine synthesized itself (never
   * model output — see `dispatchPreparedActionFollowUp`). Paired with
   * `source: "engine"` on the same assistant-role row so an auditor reading
   * `messages` directly can never mistake it for a real model-authored
   * tool_call, even though the row keeps `role: "assistant"` for the
   * provider transcript format.
   */
  | "prepared_action_follow_up"
  /**
   * Engine cue injected when an approval decision has been resolved and its
   * tool result is already in the transcript — the agent is being woken to
   * continue from it. Distinct from `operator_interrupt` (which means the user
   * cut in) and from `approval_pause` (which means the run STOPPED to ask).
   */
  | "approval_resolved";

export type MessageVisibility = "user" | "internal";

// ── Message metadata ────────────────────────────────────────────

/** Engine metadata attached to messages — extends the base message model. */
export interface MessageMetadata {
  source?: MessageSource;
  messageType?: MessageType;
  visibility?: MessageVisibility;
  originSessionId?: string;
  /**
   * Free-form envelope persisted into the `messages.metadata` JSONB column —
   * the ONLY part of this type that reaches it (db/repos/messages/write.ts).
   * Mirrors the repo-level `MessageMetadata.payload`; every producer defines
   * its own shape in code and every reader treats it as untrusted.
   */
  payload?: Record<string, unknown>;
}
