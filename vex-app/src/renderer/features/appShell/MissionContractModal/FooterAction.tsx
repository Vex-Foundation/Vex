/**
 * The contract sheet's pinned foot (docs/design/R3-MINIMAL.md section 12: 68
 * high, a quiet rule above).
 *
 * Reproduces `CardFooter`'s accept logic (helper copy, plan-mode label, the
 * plan_missing block, the accept notice) on the sheet foot - `shrink-0` and
 * pinned, which is the whole point of the rail/modal redesign (the inline
 * card's footer could be pushed below the fold). Beside Accept sits "Not
 * now", which dismisses through the same path as Escape.
 */

import type { JSX } from "react";

import { Button, buttonVariants } from "../../../components/ui/button.js";
import { DialogClose } from "../../../components/ui/dialog.js";
import { SheetFooter } from "../../../components/ui/sheet.js";
import type { CardState } from "./contract-state.js";
import type { PlanGate } from "./plan-gate.js";
import { MissionMissingFields } from "../MissionMissingFields.js";

export interface FooterActionProps {
  readonly state: CardState | null;
  readonly pending: boolean;
  readonly onAccept: (hash: string) => void;
  readonly planGate: PlanGate;
  /** Refetches the plan read after a failed Result - see the `failed` gate. */
  readonly onPlanRetry: () => void;
  /** True while a refetch is in flight - the Retry button disables itself. */
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
      <SheetFooter className="h-auto min-h-[68px] flex-col items-start justify-center gap-1 py-3 text-[13.5px] leading-[1.45] text-ink-tertiary">
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
      </SheetFooter>
    );
  }
  if (kind === "accepted") {
    return (
      <SheetFooter className="text-[13.5px] text-ink-tertiary">
        <p>
          Use the{" "}
          <span className="font-medium text-accent-primary">Start mission</span>{" "}
          button to dispatch.
        </p>
      </SheetFooter>
    );
  }
  if (currentHash === null) return null;

  // Plan state not yet known - block accept: the UI must never present an
  // action the engine is known to reject right now.
  if (planGate.kind === "loading") {
    return (
      <SheetFooter>
        <p
          className="text-[13.5px] leading-[1.45] text-ink-primary"
          role="alert"
          data-vex-state="plan-unknown"
        >
          Plan status is loading. Accepting is unavailable until it is known.
        </p>
      </SheetFooter>
    );
  }
  // Failed read: the err Result sits in the query cache as data, so nothing
  // refetches by itself while the modal stays mounted - without an explicit
  // Retry the user would be stranded here.
  if (planGate.kind === "failed") {
    return (
      <SheetFooter className="justify-between">
        <p
          className="text-[13.5px] leading-[1.45] text-ink-primary"
          role="alert"
          data-vex-state="plan-failed"
        >
          Plan status could not be read. Accepting is unavailable until it is.
        </p>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={planRetryPending}
          onClick={() => void onPlanRetry()}
        >
          Retry
        </Button>
      </SheetFooter>
    );
  }

  // Plan-mode ON but nothing authored - block accept and prompt to write a plan
  // first (matches the engine `plan_missing`).
  if (planGate.kind === "missing") {
    return (
      <SheetFooter>
        <p
          className="text-[13.5px] leading-[1.45] text-ink-primary"
          role="alert"
          data-vex-state="plan-missing"
        >
          Plan mode is on, but no action plan has been authored yet. Ask Vex to
          write the plan, then accept the contract and plan together.
        </p>
      </SheetFooter>
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
    <SheetFooter className="h-auto min-h-[68px] flex-col items-stretch justify-center gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 text-[13.5px] leading-[1.45] text-ink-tertiary">
          {helperText}
        </span>
        {/* Dismissal without a decision, the same path as Escape. */}
        <DialogClose className={buttonVariants({ variant: "quiet" })}>
          Not now
        </DialogClose>
        {/* THE single primary action - the sheet's one blue fill. */}
        <Button
          type="button"
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
          className="w-full text-[13px] leading-5 text-ink-primary"
        >
          {notice}
        </p>
      ) : null}
    </SheetFooter>
  );
}
