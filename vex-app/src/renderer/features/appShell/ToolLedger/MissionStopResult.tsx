/**
 * The visible result of a mission that ended through `MissionStop` (Kairos E-1
 * follow-up).
 *
 * The model reports the outcome in the stop call's `summary`, and a run can
 * end with that call alone and no prose. The act row is collapsed, so the
 * result the user asked for (a price move, a trade outcome) would sit behind a
 * disclosure. This block shows it under the act.
 *
 * Shown ONLY for a stop the engine ACCEPTED (`success === true`): a refused
 * stop did not end the run, and presenting its summary as the result would
 * claim an outcome that never happened. The summary is model-authored text and
 * renders as plain text, never markup.
 */

import type { JSX } from "react";

import type { ToolCallActView } from "../transcriptRowModel/act-ledger.js";

export interface MissionStopResultView {
  readonly reason: string;
  readonly summary: string;
}

const REASON_LABEL: Readonly<Record<string, string>> = {
  goal_reached: "Goal reached",
  deadline_reached: "Deadline reached",
  capital_depleted: "Capital depleted",
  max_loss_hit: "Max loss hit",
  no_viable_opportunity: "No viable opportunity",
  emergency_stop: "Emergency stop",
};

/** The accepted stop's reason and summary, or `null` for any other act. */
export function readMissionStopResult(act: ToolCallActView): MissionStopResultView | null {
  if (act.toolName !== "MissionStop" || act.success !== true) return null;
  if (act.toolArgs === null || act.toolArgs.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(act.toolArgs);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { reason, summary } = parsed as Record<string, unknown>;
  if (typeof reason !== "string" || typeof summary !== "string") return null;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return null;
  return { reason, summary: trimmed };
}

export function missionStopReasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason.replace(/_/g, " ");
}

export function MissionStopResult({ result }: { readonly result: MissionStopResultView }): JSX.Element {
  return (
    <div
      data-vex-area="mission-stop-result"
      className="mt-1 rounded-[6px] border border-[var(--vex-line)] px-3 py-2"
    >
      <div className="text-[11px] uppercase tracking-wide text-[var(--vex-text-3)]">
        Mission ended · {missionStopReasonLabel(result.reason)}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[14px] leading-6 text-foreground">{result.summary}</p>
    </div>
  );
}
