/**
 * Pure presentation model for one transcript row (stage 8-1).
 *
 * Maps the sanitized `SessionMessageDto` (role + kind) to a render variant the
 * `TranscriptMessage` component switches on. Kept pure + exhaustive so row
 * styling has one source of truth and a new `MessageKind`/`MessageRole` fails
 * the build until it is handled here. No JSX, no hooks — trivially testable.
 *
 * `content` is passed through verbatim; the renderer prints it as a React text
 * node (never HTML). Rich markdown rendering is a later, dedicated slice.
 */

import type {
  BoardProjection,
  ExplorerRef,
  MessageKind,
  MessageRole,
  SessionMessageDto,
  ToolCallDisplay,
  ToolDisplayStatus,
} from "@shared/schemas/messages.js";
// Type-only circular pair with the sibling: erased at runtime.
import type { ToolCallActView } from "./transcriptRowModel/act-ledger.js";

/** How a row is laid out + styled. */
export type TranscriptRowVariant =
  | "user" // right-aligned operator card + "You · HH:MM" caption (S3)
  | "assistant" // full-width countersigned document flow (S3)
  | "assistant_stopped" // assistant document + "Stopped" line (9-5b)
  | "tool" // compact mono tool call/result
  | "notice" // centered muted system/runtime/error line
  | "compaction" // centered static "conversation compacted" marker (8-4)
  | "recall"; // static session/long-memory recall indicator (8-4)

export interface TranscriptRowModel {
  readonly id: number;
  readonly variant: TranscriptRowVariant;
  /** Short tag for compact rows (tool name); `null` for prose bubbles. */
  readonly label: string | null;
  readonly content: string;
  /**
   * ISO timestamp threaded from `SessionMessageDto.createdAt` (S3): the
   * persistent "You · 14:32" / "Vex · 14:32" register captions print it.
   */
  readonly createdAt: string;
  /**
   * Notice rows only (S3): `error`-kind notices keep the destructive tone;
   * everything else that lands on the notice variant stays neutral.
   */
  readonly noticeTone?: "runtime" | "error";
  /**
   * User rows only (A33): the message was steered into a LIVE turn
   * (`operator_interrupt`) and is delivered at the loop's next tool-batch
   * boundary - the row wears a register mark saying so in words.
   */
  readonly steering?: true;
  /**
   * Tool rows only. `"call"` → `content` is assistant prose and `toolCalls`
   * carries the per-call param disclosures; `"result"` → `content` is the
   * tool output and `label` is `<toolName>_output`. Undefined elsewhere.
   */
  readonly toolKind?: "call" | "result";
  /** Tool CALL rows: one disclosure per executed tool in the batch. */
  readonly toolCalls?: readonly ToolCallDisplay[];
  /**
   * Tool RESULT rows only (S5): the provider call id from the DTO, kept so
   * the act-ledger post-pass can merge a result's output into its call's
   * view entry. `null` when the engine wrote no correlation id.
   */
  readonly toolCallId?: string | null;
  /**
   * Tool RESULT rows only: validated explorer refs from the DTO, carried so an
   * ORPHAN result (no call paired in its run) can still render explorer links.
   * Paired results instead deposit their refs onto the matching act during the
   * S5 grouping pass. `null`/absent when the row has none.
   */
  readonly explorerRefs?: readonly ExplorerRef[] | null;
  /**
   * Tool CALL rows after the act-ledger post-pass (S5): one entry per
   * executed call, each carrying its merged output when the matching
   * `tool_result` landed in the same uninterrupted tool run. Absent on rows
   * that never went through `groupTranscriptRows` — renderers fall back to
   * `toolCalls` with no output.
   */
  readonly toolActs?: readonly ToolCallActView[];
  /**
   * Assistant rows: the PERSISTED model reasoning for this turn (contract C1,
   * `SessionMessageDto.reasoning`). `null` on every non-assistant row, on
   * legacy rows written before the engine persisted it, and whenever the
   * provider emitted none — the renderer shows NOTHING in that case rather
   * than an empty "Reasoned" affordance. When a `tool_call` DTO splits into a
   * prose row + a tool row (`splitToolCallProse`), the reasoning rides the
   * PROSE row when there is one and the tool row otherwise — never both, even
   * though the two rows share `dto.id`.
   */
  readonly reasoning?: string | null;
  /**
   * Tool RESULT rows: measured execution wall clock (contract C1). `null` for
   * never-executed / auto-rejected / synthetic / legacy rows — and `null` is
   * NOT zero: the renderer must print no chip at all rather than "0 s".
   */
  readonly durationMs?: number | null;
  /**
   * Tool RESULT rows: engine-persisted execution outcome (contract C1
   * `success` projection). `null` = UNKNOWN (legacy row) — callers must never
   * treat it as success.
   */
  readonly success?: boolean | null;
  /**
   * Tool RESULT rows: engine-persisted DISPLAY status. `"pending"` marks an
   * ambiguous broadcast (persisted `success: false` on purpose); `null` on
   * every unambiguous result and on legacy rows. Read only together with
   * `success === false`.
   */
  readonly displayStatus?: ToolDisplayStatus | null;
  /**
   * ASSISTANT rows: the composed board persisted with this turn
   * (`SessionMessageDto.board`). A board is NOT its own row variant - it is a
   * projection of the assistant row that already carries the turn's prose, so
   * the reader sees one message, not a message plus a detached panel, and the
   * prose stays the standalone carrier of the finding when the board is
   * missing, refused, or exported to Markdown.
   *
   * `null` on non-assistant rows, on legacy rows written before the projection
   * existed, on turns that composed no board, and on a board the mapper
   * refused. Every one of those degrades to the ordinary assistant document.
   */
  readonly board?: BoardProjection | null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript discriminant: ${String(value)}`);
}

function resolveTextVariant(role: MessageRole): TranscriptRowVariant {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "system":
      return "notice";
    default:
      return assertNever(role);
  }
}

/**
 * Resolve the row variant. `kind` is the primary signal (tool/notice rows
 * exist regardless of role); plain `text` rows fall back to role-based layout.
 */
function resolveVariant(
  role: MessageRole,
  kind: MessageKind,
): TranscriptRowVariant {
  switch (kind) {
    case "tool_call":
    case "tool_result":
      return "tool";
    case "runtime_notice":
    case "error":
      return "notice";
    case "compaction":
      return "compaction";
    case "recall":
      return "recall";
    case "assistant_stopped":
      return "assistant_stopped";
    case "steering":
      return "user";
    case "text":
      return resolveTextVariant(role);
    default:
      return assertNever(kind);
  }
}

/**
 * Map a whole transcript page to row models. A single pass first indexes every
 * tool call's `toolCallId → toolName` so each `tool_result` row can be labeled
 * `<toolName>_output` even though the result row itself carries no tool name
 * (the engine writes only `toolCallId` on result rows). Falls back to "tool"
 * when a result can't be correlated (e.g. its call scrolled out of the page).
 *
 * A `tool_call` DTO that carries assistant prose (`content`) is SPLIT into two
 * rows — the standalone prose row first, then the prose-less tool row (see
 * `splitToolCallProse`). The backend persists each agentic step as one
 * assistant message holding BOTH that step's prose AND its tool calls; left
 * unsplit, the prose-bearing tool row never breaks a run, so every step's tools
 * collapse into one group and the per-step tool↔text order is lost. Emitting the
 * prose as its own non-tool row restores the chronological interleaving (the
 * prose row breaks the run in `groupTranscriptRows`, scoping grouping to each
 * step's own tools).
 */
export function toTranscriptRows(
  dtos: readonly SessionMessageDto[],
): TranscriptRowModel[] {
  const nameByCallId = new Map<string, string>();
  for (const dto of dtos) {
    if (dto.toolCalls === null || dto.toolCalls === undefined) continue;
    for (const call of dto.toolCalls) {
      nameByCallId.set(call.toolCallId, call.toolName);
    }
  }
  return dtos.flatMap((dto) => splitToolCallProse(dto, nameByCallId));
}

/**
 * One DTO → one or two rows. A `tool_call` row carrying non-empty prose splits
 * into a standalone assistant-text row (the prose) followed by the prose-less
 * tool row, so the text and tools render in chronological order. Every other
 * DTO — including a `tool_call` with empty/whitespace-only content — maps to a
 * single row exactly as before.
 *
 * The persisted `reasoning` follows the PROSE row when a split happens (that
 * is where the turn's words live, and it is the row the reader associates with
 * the thinking); the tool row is then emitted reasoning-free so the collapsible
 * block can never render twice for one `dto.id`.
 */
function splitToolCallProse(
  dto: SessionMessageDto,
  nameByCallId: ReadonlyMap<string, string>,
): TranscriptRowModel[] {
  if (dto.kind === "tool_call" && dto.content.trim().length > 0) {
    return [
      {
        id: dto.id,
        variant: resolveTextVariant(dto.role),
        label: null,
        content: dto.content,
        createdAt: dto.createdAt,
        reasoning: dto.reasoning,
      },
      toTranscriptRow({ ...dto, content: "", reasoning: null }, nameByCallId),
    ];
  }
  return [toTranscriptRow(dto, nameByCallId)];
}

export function toTranscriptRow(
  dto: SessionMessageDto,
  nameByCallId?: ReadonlyMap<string, string>,
): TranscriptRowModel {
  const variant = resolveVariant(dto.role, dto.kind);
  if (variant === "tool") {
    if (dto.kind === "tool_result") {
      const correlated =
        dto.toolCallId !== null ? nameByCallId?.get(dto.toolCallId) : undefined;
      const name = correlated ?? dto.toolName ?? "tool";
      return {
        id: dto.id,
        variant,
        toolKind: "result",
        label: `${name}_output`,
        content: dto.content,
        createdAt: dto.createdAt,
        // Correlation id survives into the row model so the S5 post-pass can
        // pair this output with its call inside the same tool run.
        toolCallId: dto.toolCallId,
        explorerRefs: dto.explorerRefs,
        // Measured wall clock; merges onto the paired act in the S5 post-pass.
        durationMs: dto.durationMs,
        success: dto.success,
        displayStatus: dto.displayStatus,
      };
    }
    // tool_call row: prose (content) + one disclosure per executed tool.
    return {
      id: dto.id,
      variant,
      toolKind: "call",
      label: dto.toolName,
      content: dto.content,
      createdAt: dto.createdAt,
      toolCalls: dto.toolCalls ?? [],
      reasoning: dto.reasoning,
    };
  }
  if (variant === "notice") {
    return {
      id: dto.id,
      variant,
      label: null,
      content: dto.content,
      createdAt: dto.createdAt,
      noticeTone: dto.kind === "error" ? "error" : "runtime",
    };
  }
  return {
    id: dto.id,
    variant,
    label: resolveLabel(variant, dto.toolName),
    content: dto.content,
    createdAt: dto.createdAt,
    reasoning: dto.reasoning,
    // The composed board rides the assistant text row it was committed with.
    // Passed through verbatim: the mapper is the validating boundary, and the
    // DTO already carries `null` for every non-assistant row.
    board: dto.board,
    // A33: the steered mark survives into the row so the user row can wear
    // its "read at the agent's next step" register stamp.
    ...(dto.kind === "steering" ? { steering: true as const } : {}),
  };
}

/**
 * Compact rows carry a short tag. `tool` rows show the tool name (or a
 * generic fallback); `recall` rows carry the raw tool name so the marker can
 * pick accurate copy (session vs long-term memory); everything else has no label.
 */
function resolveLabel(
  variant: TranscriptRowVariant,
  toolName: string | null,
): string | null {
  if (variant === "tool") return toolName ?? "tool";
  if (variant === "recall") return toolName;
  return null;
}

// S5 act-ledger grouping lives in the same-named sibling folder; the facade
// keeps the public surface stable for every consumer.
export {
  TOOL_GROUP_MIN_CALLS,
  groupTranscriptRows,
  type ToolCallActView,
  type ToolGroupRowModel,
  type TranscriptEntry,
} from "./transcriptRowModel/act-ledger.js";
