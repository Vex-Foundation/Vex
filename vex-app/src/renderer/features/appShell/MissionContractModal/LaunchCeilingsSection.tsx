/**
 * Host-authored autonomous-launch ceilings (§C6 spend, §C6b count).
 *
 * THE RENDERER'S ROLE IS DELIBERATELY SMALL. It collects two typed values and
 * sends them; it does NOT convert ETH to wei (main does, with `parseUnits` —
 * a decimals slip in the UI is a thousandfold spend error), does NOT enforce
 * anything (the engine refuses at the signing boundary), and cannot be the
 * author of record for a limit the agent is bound by.
 *
 * Both ceilings are contract-hash material, so saving them invalidates a prior
 * acceptance — the section says so before the user saves, and the mutation
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
import { Button } from "../../../components/ui/button.js";

export interface LaunchCeilingsSectionProps {
  readonly sessionId: string;
  readonly missionId: string;
  readonly constraints: MissionConstraints;
  /** False once the mission has started — its run enforces a frozen snapshot. */
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

/** Local validation — the same shapes the schema and the engine accept. */
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
      // unlimited — the copy below says so.
      maxLaunchValueEth: valueEth.trim().length === 0 ? null : valueEth.trim(),
      maxLaunchCount: count.trim().length === 0 ? null : Number(count.trim()),
    });
  };

  return (
    <div
      className="rounded-xl border border-line-1 bg-surface-1 px-4 py-3"
      data-vex-area="launch-ceilings"
    >
      <div className="vex-micro-label uppercase text-ink-secondary">
        Autonomous launch ceilings
      </div>
      <p className="mt-1 text-xs text-ink-secondary">
        You set these, not the agent. Both are required before this mission can
        create a token unattended - leaving either blank means it refuses every
        autonomous launch. Saving them requires accepting the contract again.
      </p>

      <dl className="mt-2 space-y-0.5 text-xs text-ink-secondary">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-tertiary">Max launch value:</dt>
          <dd data-vex-field="stored-max-launch-value" className="font-semibold tabular-nums text-ink-primary">
            {storedCeilingLabel(constraints)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-tertiary">Max launch count:</dt>
          <dd data-vex-field="stored-max-launch-count" className="font-semibold tabular-nums text-ink-primary">
            {storedCountLabel(constraints)}
          </dd>
        </div>
      </dl>

      {editable ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-ink-secondary">
            <span className="text-ink-tertiary">
              Max launch value (ETH, per launch - creation fee + prebuy + Vex fee)
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={valueEth}
              placeholder="0.05"
              aria-label="Max launch value in ETH"
              data-vex-field="max-launch-value-eth"
              onChange={(e) => setValueEth(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line-input bg-surface-deep px-2 py-1 font-mono text-xs text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            <span className="text-ink-tertiary">
              Max launch count (tokens this mission may create)
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={count}
              placeholder="1"
              aria-label="Max launch count"
              data-vex-field="max-launch-count"
              onChange={(e) => setCount(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line-input bg-surface-deep px-2 py-1 font-mono text-xs text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            />
          </label>
          <div className="flex items-center justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={setCeilings.isPending || validationError !== null}
              onClick={onSave}
              data-vex-action="save-launch-ceilings"
            >
              {setCeilings.isPending ? "Saving…" : "Save ceilings"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-tertiary">
          This mission has started. Its run enforces the ceilings frozen when it
          began - editing them here would change what is shown, not what is
          enforced.
        </p>
      )}

      {validationError !== null || notice !== null ? (
        <p
          role="alert"
          data-vex-state="launch-ceilings-notice"
          className="mt-2 text-xs text-warning"
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
