/**
 * THE CONFIRMATION for "Reset local data": the project-delete grammar
 * (`ProjectDeleteDialog`) at the weight this action carries. The consequence
 * strip says WHAT is deleted, WHAT is kept and that it CANNOT be undone, above
 * a TYPED confirmation: the action is irreversible and takes every session and
 * memory with it, which is exactly when a typed gate earns its friction.
 *
 * Focus starts on Cancel (rule 08), a backdrop click never confirms, and the
 * dialog cannot be dismissed while the reset runs. What was typed is what is
 * sent: preload and main check it against the phrase again. On `reset` main
 * relaunches the app, so the dialog stays open saying so until the window
 * goes; a refusal or a failure is shown beside the button and the dialog stays.
 */

import { useEffect, useState, type JSX } from "react";
import { LOCAL_DATA_RESET_PHRASE } from "@shared/schemas/system.js";
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
import { useResetLocalData } from "../../../../lib/api/system.js";
import {
  RESET_CANCEL,
  RESET_CONFIRM_LABEL,
  RESET_CONFIRM_MISMATCH,
  RESET_CONSEQUENCE_KEPT,
  RESET_CONSEQUENCE_UNDO,
  RESET_CONSEQUENCE_WHAT,
  RESET_DIALOG_DESCRIPTION,
  RESET_DIALOG_TITLE,
  RESET_PENDING,
  RESET_RELAUNCHING,
  RESET_SUBMIT,
  resetConfirmPrompt,
} from "./local-runtime-copy.js";

export function LocalDataResetDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const reset = useResetLocalData();
  const [typed, setTyped] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [relaunching, setRelaunching] = useState(false);

  // A phrase typed into an earlier opening must not arm this one.
  useEffect(() => {
    if (!open) return;
    setTyped("");
    setSubmitError(null);
    setRelaunching(false);
  }, [open]);

  const matches = typed.trim() === LOCAL_DATA_RESET_PHRASE;
  const busy = reset.isPending || relaunching;

  const confirm = async (): Promise<void> => {
    if (!matches || busy) return;
    setSubmitError(null);
    let result: Awaited<ReturnType<typeof reset.mutateAsync>>;
    try {
      result = await reset.mutateAsync(typed.trim());
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    if (result.data.kind === "reset") {
      setRelaunching(true);
      return;
    }
    setSubmitError(result.data.message);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md" closeOnBackdropClick={false} data-vex-local-data-reset-dialog="">
        <DialogHeader className="border-line-2">
          <DialogTitle>{RESET_DIALOG_TITLE}</DialogTitle>
          <DialogDescription className="text-ink-secondary">{RESET_DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <DialogConsequence data-vex-consent="reset-local-data">
          <span className="font-medium">{RESET_CONSEQUENCE_WHAT}</span>
          <span className="text-ink-secondary">{RESET_CONSEQUENCE_KEPT}</span>
          <span className="text-ink-secondary">{RESET_CONSEQUENCE_UNDO}</span>
        </DialogConsequence>

        <DialogBody className="gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="vex-local-data-reset-confirm" className="text-xs">
              {resetConfirmPrompt(LOCAL_DATA_RESET_PHRASE)}
            </Label>
            <Input
              id="vex-local-data-reset-confirm"
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
          {relaunching ? (
            <p role="status" className="text-sm text-ink-secondary" data-vex-local-data-reset-relaunching="">
              {RESET_RELAUNCHING}
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
            {busy ? RESET_PENDING : RESET_SUBMIT}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
