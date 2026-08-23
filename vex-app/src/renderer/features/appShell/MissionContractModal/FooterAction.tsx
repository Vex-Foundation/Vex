/**
 * The modal's pinned footer action.
 *
 * Reproduces `CardFooter`'s accept logic (helper copy, plan-mode label, the
 * plan_missing block, the accept notice) on the DialogFooter surface —
 * `shrink-0` and pinned, which is the whole point of the rail/modal redesign
 * (the inline card's footer could be pushed below the fold).
 *
 * Moved out of `MissionContractModal.tsx` unchanged.
 */

import type { JSX } from "react";

import { Button } from "../../../components/ui/button.js";
import { DialogFooter } from "../../../components/ui/dialog.js";
import type { CardState } from "./contract-state.js";
import type { PlanGate } from "./plan-gate.js";
import { MissionMissingFields } from "../MissionMissingFields.js";

export interface FooterActionProps {
  readonly state: CardState | null;
  readonly pending: boolean;
  readonly onAccept: (hash: string) => void;
  readonly planGate: PlanGate;
  /** Refetches the plan read after a failed Result — see the `failed` gate. */
  readonly onPlanRetry: () => void;
  /** True while a refetch is in flight — the Retry button disables itself. */
  readonly planRetryPending: boolean;
  readonly notice: string | null;
}

export function FooterAction({
  state,
  pending,
  onAccept,
  planGate,
  onPlanRetry,
  planRetryPending,
  notice,
}: FooterActionProps): JSX.Element | null {
  if (state === null) return null;
  const { kind, currentHash, missingFields } = state;

  if (kind === "setup-needed") {
    // THE defect this rewrite fixes: the old copy read "Add a goal,
    // constraints, and stop conditions to enable Accept." - an imperative aimed
    // at the user for fields the user CANNOT edit. `mission.updateDraft`
    // returns `unavailable` (the host-side draft editor is deliberately
    // stubbed), so only the agent's `MissionDraftUpdate` tool can write them.
    // Telling the user to do the impossible was the dead end; naming the real
    // actor, and the exact fields, is the fix. Shape follows VS Code's
    // Restricted Mode copy: state, consequence, next action.
    return (
      <DialogFooter className="flex-col items-start gap-1 border-line-2 text-xs text-ink-tertiary sm:flex-col sm:items-start">
        <p data-vex-state="contract-incomplete">
          Vex is still writing this contract. Accepting unlocks once every
          required field is set, and Vex sets them from your conversation - they
          cannot be edited here.
        </p>
        {missingFields.length > 0 ? (
          <>
            <p>Ask Vex for what is still missing:</p>
            <MissionMissingFields
              fields={missingFields}
              surface="contract-modal"
            />
          </>
        ) : (
          <p>Reading the current contract state.</p>
        )}
      </DialogFooter>
    );
  }
  if (kind === "accepted") {
    return (
      <DialogFooter className="justify-start border-line-2 text-xs text-ink-tertiary">
        Use the{" "}
        <span className="text-accent-primary">Start mission</span>{" "}
        button to dispatch.
      </DialogFooter>
    );
  }
  if (currentHash === null) return null;

  // Plan state not yet known — block accept: the UI must never present an
  // action the engine is known to reject right now.
  if (planGate.kind === "loading") {
    return (
      <DialogFooter className="justify-start border-line-2">
        <p
          className="text-xs text-warning"
          role="alert"
          data-vex-state="plan-unknown"
        >
          Plan status is loading. Accepting is unavailable until it is known.
        </p>
      </DialogFooter>
    );
  }
  // Failed read: the err Result sits in the query cache as data, so nothing
  // refetches by itself while the modal stays mounted — without an explicit
  // Retry the user would be stranded here.
  if (planGate.kind === "failed") {
    return (
      <DialogFooter className="justify-between border-line-2">
        <p
          className="text-xs text-warning"
          role="alert"
          data-vex-state="plan-failed"
        >
          Plan status could not be read. Accepting is unavailable until it is.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={planRetryPending}
          onClick={() => void onPlanRetry()}
        >
          Retry
        </Button>
      </DialogFooter>
    );
  }

  // Plan-mode ON but nothing authored — block accept and prompt to write a plan
  // first (matches the engine `plan_missing`).
  if (planGate.kind === "missing") {
    return (
      <DialogFooter className="justify-start border-line-2">
        <p
          className="text-xs text-warning"
          role="alert"
          data-vex-state="plan-missing"
        >
          Plan mode is on, but no action plan has been authored yet. Ask Vex to
          write the plan, then accept the contract and plan together.
        </p>
      </DialogFooter>
    );
  }

  const isDirty = kind === "dirty-acceptance";
  const unified = planGate.kind === "ready";
  const helperText = unified
    ? "Accepting locks the contract AND the action plan for this run."
    : isDirty
      ? "Re-accept to bring the runtime back in sync with the draft."
      : "Accepting locks the contract for this mission run.";
  const acceptLabel = pending
    ? "Accepting…"
    : unified
      ? "Accept contract & plan"
      : isDirty
        ? "Accept new contract"
        : "Accept contract";

  return (
    <DialogFooter className="flex-col items-stretch gap-2 border-line-2 sm:flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-tertiary">{helperText}</span>
        {/* THE single primary action — filled cobalt pill (Button default). */}
        <Button
          type="button"
          size="sm"
          onClick={() => onAccept(currentHash)}
          disabled={pending}
          data-vex-action="accept-contract"
        >
          {acceptLabel}
        </Button>
      </div>
      {notice !== null ? (
        <p
          role="alert"
          data-vex-state="plan-accept-notice"
          className="w-full text-xs text-warning"
        >
          {notice}
        </p>
      ) : null}
    </DialogFooter>
  );
}
