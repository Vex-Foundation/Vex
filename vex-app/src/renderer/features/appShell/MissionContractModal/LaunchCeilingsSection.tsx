/**
 * Host-authored autonomous-launch ceilings (§C6 spend, §C6b count).
 *
 * THE RENDERER'S ROLE IS DELIBERATELY SMALL. It collects two typed values and
 * sends them; it does NOT convert ETH to wei (main does, with `parseUnits` -
 * a decimals slip in the UI is a thousandfold spend error), does NOT enforce
 * anything (the engine refuses at the signing boundary), and cannot be the
 * author of record for a limit the agent is bound by.
 *
 * Both ceilings are contract-hash material, so saving them invalidates a prior
 * acceptance - the section says so before the user saves, and the mutation
 * invalidates both the draft and diff queries so the card immediately shows the
 * re-accept state.
 *
 * Absent is NOT unlimited: a mission with either ceiling unset can never launch
 * autonomously. That is stated in the copy, because a blank field that means
 * "refuse everything" is otherwise indistinguishable from one that means "no
 * limit".
 */

import { useState } from "react";
import type { JSX } from "react";

import type { MissionConstraints } from "@shared/schemas/mission.js";
import { MISSION_MAX_LAUNCH_COUNT } from "@shared/schemas/mission.js";
import { useSetLaunchCeilings } from "../../../lib/api/mission.js";
import { cn } from "../../../lib/utils.js";
import { Button } from "../../../components/ui/button.js";

/** The two ceiling inputs: 40 high field (docs/design/R3-MINIMAL.md section 1.5), figures in mono. */
const FIELD_CLASS =
  "mt-1.5 block h-10 w-full border border-rule bg-surface-field px-3 font-mono vex-num text-[14px] text-ink-primary caret-accent-primary placeholder:text-ink-tertiary focus-visible:outline-none focus-visible:border-accent-primary";

export interface LaunchCeilingsSectionProps {
  readonly sessionId: string;
  readonly missionId: string;
  readonly constraints: MissionConstraints;
  /** False once the mission has started - its run enforces a frozen snapshot. */
  readonly editable: boolean;
}

/**
 * Render the stored wei ceiling for display WITHOUT converting it.
 *
 * A display-side rescale of a money limit is the silent 10^n slip rule 90
 * forbids, so the raw amount is shown with its decimals, exactly as the
 * contract card does.
 */
function storedCeilingLabel(constraints: MissionConstraints): string {
  if (
    typeof constraints.maxLaunchValueRaw !== "string"
    || typeof constraints.maxLaunchValueDecimals !== "number"
  ) {
    return "not set - autonomous launches refuse";
  }
  return `${constraints.maxLaunchValueRaw} raw @ ${constraints.maxLaunchValueDecimals} decimals`;
}

function storedCountLabel(constraints: MissionConstraints): string {
  if (typeof constraints.maxLaunchCount !== "number") {
    return "not set - autonomous launches refuse";
  }
  return `${constraints.maxLaunchCount}`;
}

/** Local validation - the same shapes the schema and the engine accept. */
function localError(valueEth: string, count: string): string | null {
  if (valueEth.trim().length > 0 && !/^\d+(\.\d+)?$/.test(valueEth.trim())) {
    return "Max launch value must be a plain decimal amount of ETH, e.g. 0.05.";
  }
  if (count.trim().length > 0) {
    if (!/^\d+$/.test(count.trim())) {
      return "Max launch count must be a whole number of launches.";
    }
    if (Number(count.trim()) > MISSION_MAX_LAUNCH_COUNT) {
      return `Max launch count cannot exceed ${MISSION_MAX_LAUNCH_COUNT}.`;
    }
  }
  return null;
}

export function LaunchCeilingsSection({
  sessionId,
  missionId,
  constraints,
  editable,
}: LaunchCeilingsSectionProps): JSX.Element {
  const [valueEth, setValueEth] = useState("");
  const [count, setCount] = useState("");
  const setCeilings = useSetLaunchCeilings();

  const validationError = localError(valueEth, count);
  const result = setCeilings.data;
  const notice = noticeFor(setCeilings.isError, result);

  const onSave = (): void => {
    if (validationError !== null) return;
    setCeilings.mutate({
      sessionId,
      missionId,
      // An empty field CLEARS the ceiling. Cleared is zero authority, not
      // unlimited - the copy below says so.
      maxLaunchValueEth: valueEth.trim().length === 0 ? null : valueEth.trim(),
      maxLaunchCount: count.trim().length === 0 ? null : Number(count.trim()),
    });
  };

  const valueIsSet =
    typeof constraints.maxLaunchValueRaw === "string"
    && typeof constraints.maxLaunchValueDecimals === "number";
  const countIsSet = typeof constraints.maxLaunchCount === "number";

  return (
    <div className="mt-[22px]" data-vex-area="launch-ceilings">
      <div className="mb-2 flex items-baseline gap-2.5">
        <b className="text-[14px] font-semibold text-ink-primary">
          Autonomous launch ceilings
        </b>
        <span className="text-[12.5px] text-ink-tertiary">
          You set these, not the agent.
        </span>
      </div>
      <p className="mb-2.5 text-[14px] leading-[1.5] text-ink-secondary">
        Both are required before this mission can create a token unattended -
        leaving either blank means it refuses every autonomous launch. Saving
        them requires accepting the contract again.
      </p>

      {editable ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px] items-end gap-3">
          <label className="block text-[13px] font-medium text-ink-secondary">
            Max launch value (ETH, per launch)
            <input
              type="text"
              inputMode="decimal"
              value={valueEth}
              placeholder="0.05"
              aria-label="Max launch value in ETH"
              data-vex-field="max-launch-value-eth"
              onChange={(e) => setValueEth(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>
          <label className="block text-[13px] font-medium text-ink-secondary">
            Max launch count (tokens this mission may create)
            <input
              type="text"
              inputMode="numeric"
              value={count}
              placeholder="1"
              aria-label="Max launch count"
              data-vex-field="max-launch-count"
              onChange={(e) => setCount(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>
          <Button
            type="button"
            variant="quiet"
            className="w-full"
            disabled={setCeilings.isPending || validationError !== null}
            onClick={onSave}
            data-vex-action="save-launch-ceilings"
          >
            {setCeilings.isPending ? "Saving…" : "Save ceilings"}
          </Button>
        </div>
      ) : null}

      <div className="mt-2 text-[12.5px] leading-[1.45] text-ink-tertiary">
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
          <div className="flex flex-wrap gap-x-1.5">
            <dt>Max launch value:</dt>
            <dd
              data-vex-field="stored-max-launch-value"
              className={cn("text-ink-primary", valueIsSet && "font-mono vex-num")}
            >
              {storedCeilingLabel(constraints)}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-1.5">
            <dt>Max launch count:</dt>
            <dd
              data-vex-field="stored-max-launch-count"
              className={cn("text-ink-primary", countIsSet && "font-mono vex-num")}
            >
              {storedCountLabel(constraints)}
            </dd>
          </div>
        </dl>
        {editable ? <p>The value covers creation fee + prebuy + Vex fee.</p> : null}
      </div>

      {editable ? null : (
        <p className="mt-2 text-[13px] leading-[1.45] text-ink-tertiary">
          This mission has started. Its run enforces the ceilings frozen when it
          began - editing them here would change what is shown, not what is
          enforced.
        </p>
      )}

      {validationError !== null || notice !== null ? (
        <p
          role="alert"
          data-vex-state="launch-ceilings-notice"
          className="mt-2 text-[13px] leading-5 text-ink-primary"
        >
          {validationError ?? notice}
        </p>
      ) : null}
    </div>
  );
}

/** Map a save attempt to user-facing copy; `updated` says what it invalidated. */
function noticeFor(
  isError: boolean,
  result: ReturnType<typeof useSetLaunchCeilings>["data"],
): string | null {
  if (isError) {
    return "Couldn't save the launch ceilings - something went wrong. Try again.";
  }
  if (result === undefined) return null;
  if (!result.ok) {
    return "Couldn't save the launch ceilings - something went wrong. Try again.";
  }
  switch (result.data.outcome) {
    case "updated":
      return result.data.acceptanceCleared
        ? "Ceilings saved. The contract changed, so accept it again before starting."
        : "Ceilings saved.";
    case "invalid":
      return result.data.reason;
    case "blocked_status":
      return `Couldn't save: this mission is ${result.data.status} and its ceilings are already frozen into the run.`;
    case "not_found":
      return "Couldn't save: this mission no longer exists. Refresh and try again.";
  }
}
