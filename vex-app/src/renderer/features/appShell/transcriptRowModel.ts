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
  ExplorerRef,
  MessageKind,
  MessageRole,
  SessionMessageDto,
  ToolCallDisplay,
} from "@shared/schemas/messages.js";

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

// ── S5: THE ACT LEDGER — post-pass grouping over the row list ───────────────
//
// The transcript registers tool work as ACTS: a call plus (when it landed in
// the same uninterrupted tool run) its output. Long chains of acts collapse
// into one aggregation entry so the document stays readable. This is a pure
// post-pass over `toTranscriptRows` output — every existing variant passes
// through untouched; only `variant === "tool"` rows are restructured.

/**
 * A run only aggregates when it registers at least this many CALLS.
 *
 * Owner decree (session-UI redesign): collapse only ABOVE five calls. At 3 the
 * ledger was hiding ordinary two-and-three-step work behind a disclosure the
 * reader had to open to see what Vex did — the collapse is for long chains,
 * not for a normal turn.
 */
export const TOOL_GROUP_MIN_CALLS = 6;

/**
 * One registered act: the sanitized call display plus its merged output.
 * `output === null` means no result row paired (still running, lost, or the
 * result landed outside the run) — the renderer then shows Args only.
 */
export interface ToolCallActView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolArgs: string | null;
  readonly output: string | null;
  /**
   * Validated explorer refs merged from this act's paired `tool_result` row
   * (S5). Absent/`null` until a result pairs, or when the result carried none —
   * the act renderer then shows no link.
   */
  readonly explorerRefs?: readonly ExplorerRef[] | null;
  /**
   * Measured execution wall clock merged from this act's paired `tool_result`
   * row (contract C1). Absent/`null` until a result pairs, or when the call
   * never actually executed — the card then shows NO duration chip. `null` is
   * not zero; a not-run call must never read as "0 s".
   */
  readonly durationMs?: number | null;
  /**
   * Execution outcome merged from this act's paired `tool_result` row.
   * Absent/`null` until a result pairs or on legacy rows = UNKNOWN — display
   * gated on outcome (e.g. swap/bridge leg lines) must require `true`, never
   * treat null as success.
   */
  readonly success?: boolean | null;
}

/** Aggregation entry replacing a run of ≥TOOL_GROUP_MIN_CALLS calls. */
export interface ToolGroupRowModel {
  readonly variant: "tool_group";
  /** First contributing call row's message id — stable across refetches. */
  readonly id: number;
  readonly calls: readonly ToolCallActView[];
  /** Tool names deduped in first-appearance order (drives the glyph strip). */
  readonly distinctToolNames: readonly string[];
  /** First contributing call row's timestamp. */
  readonly createdAt: string;
  /**
   * The persisted reasoning of the first PROSE-LESS call row folded into this
   * group (contract C1). Aggregation may drop the call/result interleaving, it
   * must never drop the turn's thinking: a prose-less call row has no other
   * row to carry its reasoning once it is folded in, so the group carries it
   * and renders the same collapsible block above the ledger line. Call rows
   * that DO have prose keep their own document row (emitted above the group)
   * and their own reasoning with it — which is why only prose-less rows are
   * harvested here and the block can never render twice for one turn.
   */
  readonly reasoning?: string | null;
}

/** What the transcript actually renders: plain rows plus group entries. */
export type TranscriptEntry = TranscriptRowModel | ToolGroupRowModel;

/**
 * Collapse consecutive runs of tool rows into act entries (S5). "Consecutive"
 * means uninterrupted by any non-tool row — user/assistant/marker/notice rows
 * all break a run. Within a run, each `tool_result` row merges into its call's
 * act (matched by `toolCallId` against calls registered EARLIER in the run);
 * results that cannot pair stay standalone rows exactly as before. Runs whose
 * call count reaches `TOOL_GROUP_MIN_CALLS` emit ONE `tool_group` entry;
 * smaller runs keep individual call rows (with `toolActs` attached).
 */
export function groupTranscriptRows(
  rows: readonly TranscriptRowModel[],
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let run: TranscriptRowModel[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    out.push(...transformToolRun(run));
    run = [];
  };
  for (const row of rows) {
    if (row.variant === "tool") {
      run.push(row);
      continue;
    }
    flushRun();
    out.push(row);
  }
  flushRun();
  return out;
}

/** Internal pairing shape — mutable `output` while the run is scanned. */
interface MutableAct {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolArgs: string | null;
  output: string | null;
  explorerRefs?: readonly ExplorerRef[] | null;
  durationMs?: number | null;
  success?: boolean | null;
}

function transformToolRun(
  run: readonly TranscriptRowModel[],
): TranscriptEntry[] {
  // Pass 1 — register every call as an act, then pair each result forward.
  // Results always postdate their calls, so one chronological scan suffices.
  const actsByRowId = new Map<number, MutableAct[]>();
  const actByCallId = new Map<string, MutableAct>();
  const consumedResultIds = new Set<number>();
  const allActs: MutableAct[] = [];
  for (const row of run) {
    if (row.toolKind === "call") {
      const acts = (row.toolCalls ?? []).map(
        (call): MutableAct => ({ ...call, output: null }),
      );
      actsByRowId.set(row.id, acts);
      for (const act of acts) {
        allActs.push(act);
        // First registration wins on a duplicate id (defensive — provider
        // call ids are unique in practice).
        if (!actByCallId.has(act.toolCallId)) {
          actByCallId.set(act.toolCallId, act);
        }
      }
      continue;
    }
    if (
      row.toolKind === "result" &&
      row.toolCallId !== null &&
      row.toolCallId !== undefined
    ) {
      const act = actByCallId.get(row.toolCallId);
      if (act !== undefined && act.output === null) {
        act.output = row.content;
        if (row.explorerRefs !== null && row.explorerRefs !== undefined) {
          act.explorerRefs = row.explorerRefs;
        }
        // Only a MEASURED duration merges: a null on the result row means the
        // call never executed, and must stay absent rather than become 0.
        if (row.durationMs !== null && row.durationMs !== undefined) {
          act.durationMs = row.durationMs;
        }
        if (row.success !== null && row.success !== undefined) {
          act.success = row.success;
        }
        consumedResultIds.add(row.id);
      }
    }
  }

  // Pass 2 — emit. Grouped runs fold every act into ONE entry placed at the
  // first contributing call row; assistant prose on grouped call rows is
  // preserved as a document-only row ABOVE its acts (aggregation may drop the
  // call/result interleaving, never the words).
  const grouped = allActs.length >= TOOL_GROUP_MIN_CALLS;
  const entries: TranscriptEntry[] = [];
  let groupEmitted = false;
  const foldedReasoning = grouped ? firstProselessReasoning(run) : null;
  for (const row of run) {
    if (row.toolKind === "call") {
      const acts = actsByRowId.get(row.id) ?? [];
      if (!grouped || acts.length === 0) {
        // Stays individual; merged outputs ride along for the act renderer.
        entries.push({ ...row, toolActs: acts });
        continue;
      }
      if (row.content.length > 0) {
        entries.push({ ...row, toolCalls: [], toolActs: [] });
      }
      if (!groupEmitted) {
        entries.push({
          variant: "tool_group",
          id: row.id,
          calls: allActs,
          distinctToolNames: dedupeToolNames(allActs),
          createdAt: row.createdAt,
          reasoning: foldedReasoning,
        });
        groupEmitted = true;
      }
      continue;
    }
    // Result (or defensive unknown) row: merged results disappear into their
    // act; orphans keep today's standalone disclosure rendering.
    if (consumedResultIds.has(row.id)) continue;
    entries.push(row);
  }
  return entries;
}

/**
 * The reasoning a grouped run would otherwise LOSE: the first call row that
 * carries a trace but no prose of its own. Prose-bearing rows survive the fold
 * as their own document row (which renders their reasoning), so harvesting
 * them here would double-render one turn's thinking.
 */
function firstProselessReasoning(
  run: readonly TranscriptRowModel[],
): string | null {
  for (const row of run) {
    if (row.toolKind !== "call" || row.content.length > 0) continue;
    const reasoning = row.reasoning;
    if (reasoning !== null && reasoning !== undefined && reasoning.length > 0) {
      return reasoning;
    }
  }
  return null;
}

function dedupeToolNames(acts: readonly MutableAct[]): string[] {
  const names: string[] = [];
  for (const act of acts) {
    if (!names.includes(act.toolName)) names.push(act.toolName);
  }
  return names;
}
