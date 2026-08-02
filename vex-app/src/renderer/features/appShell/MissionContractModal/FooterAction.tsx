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
  const { kind, currentHash } = state;

  if (kind === "setup-needed") {
    return (
      <DialogFooter className="justify-start border-[var(--vex-line)] text-xs text-[var(--vex-text-3)]">
        Add a goal, constraints, and stop conditions to enable Accept.
      </DialogFooter>
    );
  }
  if (kind === "accepted") {
    return (
      <DialogFooter className="justify-start border-[var(--vex-line)] text-xs text-[var(--vex-text-3)]">
        Use the{" "}
        <span className="text-[var(--vex-accent-text)]">Start mission</span>{" "}
        button to dispatch.
      </DialogFooter>
    );
  }
  if (currentHash === null) return null;

  // Plan state not yet known — block accept: the UI must never present an
  // action the engine is known to reject right now.
  if (planGate.kind === "loading") {
    return (
      <DialogFooter className="justify-start border-[var(--vex-line)]">
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
      <DialogFooter className="justify-between border-[var(--vex-line)]">
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
      <DialogFooter className="justify-start border-[var(--vex-line)]">
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
    <DialogFooter className="flex-col items-stretch gap-2 border-[var(--vex-line)] sm:flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--vex-text-3)]">{helperText}</span>
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
