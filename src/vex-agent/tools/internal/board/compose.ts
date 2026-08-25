/**
 * `BoardCompose` - the agent's presentation tool for market analysis.
 *
 * WHAT IT IS. The model chooses pools, writes its own captions, notes and
 * chart annotations, and calls this once. The tool validates that authorship
 * against the frozen v1 contract, fetches every market fact itself, and STAGES
 * the finished document for the turn's final reply. It returns the word
 * "staged", never "attached": nothing is durable until the assistant row
 * carrying the model's final prose commits, and that row is written by the
 * turn loop, not here.
 *
 * WHY IT IS TERMINAL. A board is a presentation of an analysis that is already
 * finished. Allowing a batch sibling, or any tool call after it, would let the
 * facts on the board diverge from the reply beside it, and would open the
 * approval and user-form parking paths on a turn whose only remaining job is
 * to write prose. The two pre-dispatch rules that enforce this live in the
 * engine (`engine/core/turn-loop-tool-batch/presentation-gate.ts`); this
 * handler defends the same invariant a second time at the staging call, so a
 * compose reached from anywhere but a live turn fails closed.
 *
 * WHAT THE MODEL CANNOT SEND. No URL, HTML, markdown, colour, CSS, chart
 * option, fee or destination field exists in the schema, and unknown keys are
 * refused BY NAME rather than dropped. Prices, times and labels are the
 * model's analytical coordinates and are legal; every displayed measurement is
 * runtime-authored (`./hydrate.ts`).
 *
 * CLASSIFICATION. `mutating: false`, `actionKind: "local_write"`: it moves no
 * funds, touches no external state, and writes only in-process presentation
 * state that a later transcript INSERT makes durable. `pressureSafety:
 * "safe_at_barrier"` deliberately: the tool's model-visible output is a short
 * confirmation (the hydration never enters the context window), and dropping
 * it at barrier would strip the agent of its ability to PRESENT exactly when
 * context pressure means the turn must conclude. Nothing about it is a
 * fund-moving action the barrier exists to hold back.
 */

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail } from "../types.js";
import { formatZodIssuesForModel } from "../arg-validation.js";
import {
  boardComposeInputSchema,
  boardSpecV1Schema,
  checkBoardSpecByteBudget,
  describeBoardByteBudgetFailure,
  type BoardSpecV1,
} from "../../../../lib/board/index.js";
import { stagePresentation } from "@vex-agent/engine/core/board-presentation.js";
import { hydrateBoard } from "./hydrate.js";
import { isDexScreenerSiteError } from "@tools/dexscreener/site-errors.js";
import logger from "@utils/logger.js";

/** Model-visible confirmation. It says STAGED, because that is what happened. */
function stagedOutput(spec: BoardSpecV1, byteLength: number): string {
  const chart =
    spec.chart === undefined
      ? "no chart"
      : `a ${spec.chart.resolution} chart on pool ${spec.chart.poolIndex + 1} with ${spec.chart.annotations?.length ?? 0} annotation(s)`;
  const rows = spec.hydration.rows
    .map((row, index) => {
      const symbol = row.baseTokenSymbol ?? "unknown token";
      const price = row.priceUsd === null ? "no price reported" : `$${row.priceUsd}`;
      return `${index + 1}. ${symbol} (${price})`;
    })
    .join("; ");
  return (
    `staged: the board "${spec.title}" is prepared with ${spec.hydration.rows.length} pool card(s), `
    + `${spec.notes?.length ?? 0} note(s) and ${chart}. It is ${byteLength} bytes and is NOT shown yet. `
    + "Write your final reply now, as plain prose with no further tool calls: the board is attached to "
    + `that message. Market data as fetched: ${rows}.`
  );
}

export async function handleBoardCompose(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = boardComposeInputSchema.safeParse(args);
  if (!parsed.success) {
    // Issue messages name the field and, for text, the forbidden CLASS. None
    // of them echoes the offending bytes: an error message is model-visible
    // and reader-visible text, and echoing an injected bidi run into it would
    // carry the payload into the surface the check defends.
    return fail(`BoardCompose: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }

  const nowMs = Date.now();
  let hydration;
  try {
    hydration = await hydrateBoard({
      input: parsed.data,
      nowMs,
      ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
    });
  } catch (err) {
    // A provider refusal states its real cause and remedy (the surface's own
    // site errors carry both). Nothing is staged, so the turn continues with
    // its ordinary tool set.
    if (isDexScreenerSiteError(err)) {
      return fail(
        `BoardCompose: the board was not staged because its market data could not be read. ${err.message}${err.hint === undefined ? "" : ` ${err.hint}`}`,
      );
    }
    logger.warn("board.compose.hydration_failed", {
      sessionId: context.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(
      "BoardCompose: the board was not staged because its market data could not be read. "
      + "The DexScreener surface did not answer. Retry once, or present your analysis as prose.",
    );
  }

  const candidate = {
    version: 1 as const,
    ...parsed.data,
    hydration,
  };

  // Parse the ASSEMBLED document, not just the halves. The cross-field rules
  // that only hold once both are present (one hydrated row per pool, the
  // candle resolution echoing the chart's) live on this schema, and a board
  // that fails them is a runtime defect rather than a model mistake.
  const spec = boardSpecV1Schema.safeParse(candidate);
  if (!spec.success) {
    logger.error("board.compose.spec_invalid", {
      sessionId: context.sessionId,
      issues: spec.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
    return fail(
      "BoardCompose: the board was not staged because the runtime could not assemble a valid "
      + "document from the market data it fetched. This is a Vex-side fault, not your input. "
      + "Present your analysis as prose.",
    );
  }

  // LOSSLESS DETACH before anything holds a reference to this document.
  // The board crosses `JSON.stringify` at the database boundary and
  // `structuredClone` at the IPC boundary, and a `Date`, a `BigInt` or a live
  // reference into mutable provider state would either throw there or arrive
  // silently mangled - at a point where no handler is left to refuse it. So
  // the staged object is the ROUND-TRIPPED one, and it is re-validated after
  // the round trip: what is staged is exactly what the row can store.
  const detached = boardSpecV1Schema.safeParse(JSON.parse(JSON.stringify(spec.data)));
  if (!detached.success) {
    logger.error("board.compose.detach_failed", {
      sessionId: context.sessionId,
      issues: detached.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
    return fail(
      "BoardCompose: the board was not staged because the document the runtime assembled did not "
      + "survive serialization intact. This is a Vex-side fault, not your input. Present your "
      + "analysis as prose.",
    );
  }

  // The budget is measured on the document that would be STORED, and an
  // over-budget board is refused with its size named. Nothing is dropped to
  // make one fit: a board the agent did not compose is worse than no board.
  const budget = checkBoardSpecByteBudget(detached.data);
  if (!budget.withinBudget) {
    return fail(`BoardCompose: ${describeBoardByteBudgetFailure(budget)}`);
  }

  const outcome = stagePresentation(context.sessionId, detached.data, nowMs);
  if (outcome === "already_pending") {
    return fail(
      "BoardCompose: a board is already staged for this turn and a second one would replace an "
      + "analysis you already told the user about. Write your final reply now; the staged board "
      + "is attached to it.",
    );
  }
  if (outcome === "no_open_scope") {
    return fail(
      "BoardCompose: a board can only be staged during a live turn that ends with your reply, "
      + "and this call did not run inside one. Nothing was staged.",
    );
  }

  logger.info("board.compose.staged", {
    sessionId: context.sessionId,
    missionRunId: context.missionRunId ?? null,
    pools: detached.data.pools.length,
    notes: detached.data.notes?.length ?? 0,
    hasChart: detached.data.chart !== undefined,
    candles: detached.data.hydration.candles?.bars.length ?? 0,
    byteLength: budget.byteLength,
  });

  return {
    success: true,
    output: stagedOutput(detached.data, budget.byteLength),
    actionKind: "local_write",
  };
}
