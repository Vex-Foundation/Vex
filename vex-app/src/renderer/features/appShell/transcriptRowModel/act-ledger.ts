/**
 * S5: THE ACT LEDGER - post-pass grouping over the transcript row list.
 *
 * The transcript registers tool work as ACTS: a call plus (when it landed in
 * the same uninterrupted tool run) its output. Long chains of acts collapse
 * into one aggregation entry so the document stays readable. This is a pure
 * post-pass over `toTranscriptRows` output - every existing variant passes
 * through untouched; only `variant === "tool"` rows are restructured.
 * Public surface is re-exported by the `transcriptRowModel.ts` facade.
 */

import type {
  ExplorerRef,
  ToolDisplayStatus,
} from "@shared/schemas/messages.js";
import type { TranscriptRowModel } from "../transcriptRowModel.js";

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
  /**
   * DISPLAY status merged from this act's paired `tool_result` row.
   * `"pending"` ONLY for an ambiguous broadcast; absent/`null` otherwise. Read
   * only alongside `success === false` — it splits "failed" from "broadcast,
   * not yet confirmed" and never claims more than `success` supports.
   */
  readonly displayStatus?: ToolDisplayStatus | null;
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
   * The persisted reasoning of EVERY PROSE-LESS call row folded into this
   * group, in turn order (contract C1). Aggregation may drop the call/result
   * interleaving, it must never drop the turn's thinking: a prose-less call
   * row has no other row to carry its reasoning once it is folded in, so the
   * group carries them ALL and renders one collapsible block per trace, in
   * order, above the ledger line — keeping only the first silently discarded
   * every later trace in the same group. Call rows that DO have prose keep
   * their own document row (emitted above the group) and their own reasoning
   * with it, which is why only prose-less rows are harvested here and no trace
   * can render twice for one turn. Empty when no folded row carried a trace.
   */
  readonly reasonings?: readonly string[];
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
  displayStatus?: ToolDisplayStatus | null;
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
        if (row.displayStatus !== null && row.displayStatus !== undefined) {
          act.displayStatus = row.displayStatus;
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
  const foldedReasonings = grouped ? proselessReasonings(run) : [];
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
          reasonings: foldedReasonings,
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
 * The reasoning a grouped run would otherwise LOSE: EVERY call row that
 * carries a trace but no prose of its own, in turn order. Prose-bearing rows
 * survive the fold as their own document row (which renders their reasoning),
 * so harvesting them here would double-render one turn's thinking.
 */
function proselessReasonings(run: readonly TranscriptRowModel[]): string[] {
  const traces: string[] = [];
  for (const row of run) {
    if (row.toolKind !== "call" || row.content.length > 0) continue;
    const reasoning = row.reasoning;
    if (reasoning !== null && reasoning !== undefined && reasoning.length > 0) {
      traces.push(reasoning);
    }
  }
  return traces;
}

function dedupeToolNames(acts: readonly MutableAct[]): string[] {
  const names: string[] = [];
  for (const act of acts) {
    if (!names.includes(act.toolName)) names.push(act.toolName);
  }
  return names;
}
