/**
 * Shared DTO builders for the `transcriptRowModel` suites.
 *
 * Extracted when the single suite crossed the 550-line hard limit and split by
 * responsibility (variant mapping / act-ledger grouping / DTO-field
 * propagation). The builders are the ONE place a new `SessionMessageDto` field
 * has to be defaulted, so the three suites can never drift apart on shape.
 */

import type {
  MessageKind,
  MessageRole,
  SessionMessageDto,
} from "@shared/schemas/messages.js";
import type {
  ToolGroupRowModel,
  TranscriptEntry,
} from "../../transcriptRowModel.js";

export const FIXTURE_ISO = "2026-05-26T10:00:00.000Z";

export function dto(p: {
  readonly role: MessageRole;
  readonly kind: MessageKind;
  readonly content?: string;
  readonly toolName?: string | null;
  readonly toolCallId?: string | null;
  readonly toolCalls?: SessionMessageDto["toolCalls"];
  readonly explorerRefs?: SessionMessageDto["explorerRefs"];
  readonly reasoning?: SessionMessageDto["reasoning"];
  readonly durationMs?: SessionMessageDto["durationMs"];
  readonly success?: SessionMessageDto["success"];
  readonly board?: SessionMessageDto["board"];
  readonly interruptDisposition?: SessionMessageDto["interruptDisposition"];
  readonly id?: number;
}): SessionMessageDto {
  return {
    id: p.id ?? 1,
    sessionId: "00000000-0000-4000-8000-000000000001",
    role: p.role,
    kind: p.kind,
    content: p.content ?? "x",
    createdAt: FIXTURE_ISO,
    toolCallId: p.toolCallId ?? null,
    toolName: p.toolName ?? null,
    toolCalls: p.toolCalls ?? null,
    explorerRefs: p.explorerRefs ?? null,
    reasoning: p.reasoning ?? null,
    durationMs: p.durationMs ?? null,
    success: p.success ?? null,
    displayStatus: null,
    board: p.board ?? null,
    // M6: the engine's record of what it did with an operator instruction.
    // Overridable so a fixture can build each of the three steering rows.
    interruptDisposition: p.interruptDisposition ?? null,
  };
}

/** Tool CALL dto with one act per name (call ids default to `c<id>-<i>`). */
export function callDto(
  id: number,
  names: readonly string[],
  content = "",
  reasoning: string | null = null,
): SessionMessageDto {
  return dto({
    id,
    role: "assistant",
    kind: "tool_call",
    content,
    reasoning,
    toolCalls: names.map((toolName, i) => ({
      toolCallId: `c${id}-${i}`,
      toolName,
      toolArgs: `{"n":${i}}`,
    })),
  });
}

export function resultDto(
  id: number,
  toolCallId: string,
  content: string,
): SessionMessageDto {
  return dto({ id, role: "tool", kind: "tool_result", content, toolCallId });
}

/** The single aggregation entry in a grouped run, if one was emitted. */
export function group(
  entries: readonly TranscriptEntry[],
): ToolGroupRowModel | undefined {
  return entries.find(
    (e): e is ToolGroupRowModel => e.variant === "tool_group",
  );
}
