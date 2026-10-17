/**
 * THE TYPED CONFIRMATION in front of an irreversible Settings action (reset
 * local data, remove the old data): the project-delete grammar
 * (`ProjectDeleteDialog`). The consequence strip says WHAT is deleted, WHAT is
 * kept and that it CANNOT be undone, above a typed phrase; the action is
 * irreversible and unbounded, which is exactly when a typed gate earns its
 * friction.
 *
 * Focus starts on Cancel (rule 08), a backdrop click never confirms, and the
 * dialog cannot be dismissed while the action runs. What was typed is what
 * `onConfirm` receives. A refusal or failure is shown beside the button and
 * the dialog stays; a success either closes it or, when the app is about to
 * relaunch, keeps it open saying so.
 */

import { useEffect, useState, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPinnedSlot,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { SubmitError } from "../../../../components/ui/submit-error.js";
import {
  RESET_CANCEL,
  RESET_CONFIRM_LABEL,
  RESET_CONFIRM_MISMATCH,
  resetConfirmPrompt,
} from "./local-runtime-copy.js";

/** How the action ended: `stay` keeps the dialog open on `doneText` (a relaunch follows). */
export type TypedConfirmOutcome =
  | { readonly kind: "done"; readonly stay: boolean }
  | { readonly kind: "error"; readonly message: string };

export interface TypedConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description: string;
  readonly what: string;
  readonly kept: string;
  readonly undo: string;
  readonly phrase: string;
  readonly submit: string;
  readonly pending: string;
  readonly doneText: string;
  readonly onConfirm: (typed: string) => Promise<TypedConfirmOutcome>;
  /** `data-*` hook naming the dialog for tests and e2e. */
  readonly testId: string;
}

export function TypedConfirmDialog(props: TypedConfirmDialogProps): JSX.Element {
  const { open, onClose, phrase } = props;
  const inputId = `vex-${props.testId}-confirm`;
  const [typed, setTyped] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  // A phrase typed into an earlier opening must not arm this one.
  useEffect(() => {
    if (!open) return;
    setTyped("");
    setSubmitError(null);
    setRunning(false);
    setDone(false);
  }, [open]);

  const matches = typed.trim() === phrase;
  const busy = running || done;

  const confirm = async (): Promise<void> => {
    if (!matches || busy) return;
    setSubmitError(null);
    setRunning(true);
    let outcome: TypedConfirmOutcome;
    try {
      outcome = await props.onConfirm(typed.trim());
    } catch (cause) {
      outcome = { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
    setRunning(false);
    if (outcome.kind === "error") {
      setSubmitError(outcome.message);
      return;
    }
    if (outcome.stay) {
      setDone(true);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md" closeOnBackdropClick={false} data-vex-typed-confirm={props.testId}>
        <DialogHeader className="border-line-2">
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription className="text-ink-secondary">{props.description}</DialogDescription>
        </DialogHeader>

        <DialogConsequence data-vex-consent={props.testId}>
          <span className="font-medium">{props.what}</span>
          <span className="text-ink-secondary">{props.kept}</span>
          <span className="text-ink-secondary">{props.undo}</span>
        </DialogConsequence>

        <DialogBody className="gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId} className="text-xs">
              {resetConfirmPrompt(phrase)}
            </Label>
            <Input
              id={inputId}
              type="text"
              value={typed}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              aria-label={RESET_CONFIRM_LABEL}
              aria-invalid={typed.length > 0 && !matches}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirm();
                }
              }}
              className="h-10"
            />
            {typed.length > 0 && !matches ? (
              <p className="text-xs text-ink-tertiary">{RESET_CONFIRM_MISMATCH}</p>
            ) : null}
          </div>
          {done ? (
            <p role="status" className="text-sm text-ink-secondary" data-vex-typed-confirm-done="">
              {props.doneText}
            </p>
          ) : null}
        </DialogBody>

        {submitError !== null ? (
          <DialogPinnedSlot>
            <SubmitError submitError={submitError} />
          </DialogPinnedSlot>
        ) : null}

        <DialogFooter className="border-line-2">
          <Button
            type="button"
            variant="bare"
            onClick={onClose}
            disabled={busy}
            {...DIALOG_INITIAL_FOCUS}
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            {RESET_CANCEL}
          </Button>
          <Button type="button" variant="ink" onClick={() => void confirm()} disabled={!matches || busy}>
            {busy ? props.pending : props.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
