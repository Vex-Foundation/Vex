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
 *
 * Under it, "Agent Scan for this session" (the d2x-mission-completed render)
 * opens the session's own Agent Scan, every move the run made, verified on
 * chain. The transcript on screen is the active session's, so that is the
 * session it names; with no active session the link is not drawn.
 */

import type { JSX } from "react";

import { Swatch } from "../../../components/ui/swatch.js";
import { useUiStore } from "../../../stores/uiStore.js";
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
  const sessionId = useUiStore((s) => s.activeSessionId);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  return (
    <div
      data-vex-area="mission-stop-result"
      className="mb-4 mt-1 border border-rule bg-surface-base px-[18px] py-4"
    >
      <div className="flex items-center gap-[9px]">
        <Swatch state="done" size={10} className="text-accent-primary" />
        <b className="text-[16px] font-medium leading-6 text-ink-primary">
          {`Mission ended · ${missionStopReasonLabel(result.reason)}`}
        </b>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[14.5px] leading-[1.55] text-ink-primary">{result.summary}</p>
      {sessionId !== null ? (
        <div className="mt-3 flex items-center gap-4">
          <button
            type="button"
            data-vex-action="mission-agent-scan"
            className="text-[13px] font-medium text-accent-primary underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vex-alias-focus)]"
            onClick={() => setShellRoute({ kind: "agentScan", origin: null, sessionId })}
          >
            Agent Scan for this session
          </button>
        </div>
      ) : null}
    </div>
  );
}
