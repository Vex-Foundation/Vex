/**
 * Mission reasoning effort on the contract card (Kairos E-1).
 *
 * The effort is part of the contract: every model call of the run uses it,
 * it is frozen when the run starts, and changing it requires accepting the
 * contract again (the engine clears acceptance on a write). Unset means
 * Medium, the default the run would use, so the card always shows a value.
 *
 * The renderer only picks and sends. The engine clamps the effort to what the
 * model supports at run time (never higher than chosen) and refuses a write
 * once the mission has started.
 */

import { useState } from "react";
import type { JSX } from "react";

import type { MissionConstraints } from "@shared/schemas/mission.js";
import {
  REASONING_EFFORT_VALUES,
  reasoningEffortSchema,
  type ReasoningEffort,
} from "@shared/schemas/reasoning.js";
import { useSetReasoningEffort } from "../../../lib/api/mission.js";
import { Button } from "../../../components/ui/button.js";

/** The run's effort when the contract names none (engine `MISSION_DEFAULT_REASONING_EFFORT`). */
export const MISSION_DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

const EFFORT_LABEL: Readonly<Record<ReasoningEffort, string>> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export interface ReasoningEffortSectionProps {
  readonly sessionId: string;
  readonly missionId: string;
  readonly constraints: MissionConstraints;
  /** False once the mission has started - its run uses a frozen snapshot. */
  readonly editable: boolean;
}

export function ReasoningEffortSection({
  sessionId,
  missionId,
  constraints,
  editable,
}: ReasoningEffortSectionProps): JSX.Element {
  const stored = constraints.reasoningEffort ?? MISSION_DEFAULT_REASONING_EFFORT;
  const [picked, setPicked] = useState<ReasoningEffort>(stored);
  const setEffort = useSetReasoningEffort();
  const notice = noticeFor(setEffort.isError, setEffort.data);

  const onSave = (): void => {
    setEffort.mutate({ sessionId, missionId, reasoningEffort: picked });
  };

  return (
    <div
      className="rounded-xl border border-line-1 bg-surface-1 px-4 py-3"
      data-vex-area="mission-reasoning-effort"
    >
      <div className="vex-micro-label uppercase text-ink-secondary">Reasoning effort</div>
      <p className="mt-1 text-xs text-ink-secondary">
        How long the agent thinks before each step of this mission. Lower is faster
        and cheaper; higher is more careful. Medium is the default. If the model
        does not support your choice, the nearest lower level it supports is used.
      </p>

      <div className="mt-2 flex flex-wrap gap-x-2 text-xs text-ink-secondary">
        <span className="text-ink-tertiary">Current:</span>
        <span data-vex-field="stored-reasoning-effort" className="font-semibold text-ink-primary">
          {EFFORT_LABEL[stored]}
        </span>
      </div>

      {editable ? (
        <div className="mt-3 flex items-end gap-2">
          <label className="block flex-1 text-xs text-ink-secondary">
            <span className="text-ink-tertiary">Effort for this mission</span>
            <select
              value={picked}
              aria-label="Mission reasoning effort"
              data-vex-field="mission-reasoning-effort"
              onChange={(e) => {
                const parsed = reasoningEffortSchema.safeParse(e.target.value);
                if (parsed.success) setPicked(parsed.data);
              }}
              className="mt-1 w-full rounded-xl border border-line-input bg-surface-deep px-2 py-1 text-xs text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              {REASONING_EFFORT_VALUES.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_LABEL[effort]}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={setEffort.isPending || picked === stored}
            onClick={onSave}
            data-vex-action="save-reasoning-effort"
          >
            {setEffort.isPending ? "Saving..." : "Save effort"}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-tertiary">
          This mission has started. Its run uses the effort frozen when it began.
        </p>
      )}

      {notice !== null ? (
        <p role="alert" data-vex-state="reasoning-effort-notice" className="mt-2 text-xs text-warning">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function noticeFor(
  isError: boolean,
  result: ReturnType<typeof useSetReasoningEffort>["data"],
): string | null {
  if (isError) return "Couldn't save the reasoning effort. Try again.";
  if (result === undefined) return null;
  if (!result.ok) return "Couldn't save the reasoning effort. Try again.";
  switch (result.data.outcome) {
    case "updated":
      return result.data.acceptanceCleared
        ? "Effort saved. The contract changed, so accept it again before starting."
        : "Effort saved.";
    case "invalid":
      return result.data.reason;
    case "blocked_status":
      return `Couldn't save: this mission is ${result.data.status} and its effort is already frozen into the run.`;
    case "not_found":
      return "Couldn't save: this mission no longer exists. Refresh and try again.";
  }
}
