/**
 * "Reset local data", behind the typed confirmation (`TypedConfirmDialog`).
 * What was typed is what is sent: preload and main check it against the
 * phrase again. On `reset` main relaunches the app, so the dialog stays open
 * saying so until the window goes.
 */

import type { JSX } from "react";
import { LOCAL_DATA_RESET_PHRASE } from "@shared/schemas/system.js";
import { useResetLocalData } from "../../../../lib/api/system.js";
import {
  RESET_CONSEQUENCE_KEPT,
  RESET_CONSEQUENCE_UNDO,
  RESET_CONSEQUENCE_WHAT,
  RESET_DIALOG_DESCRIPTION,
  RESET_DIALOG_TITLE,
  RESET_PENDING,
  RESET_RELAUNCHING,
  RESET_SUBMIT,
} from "./local-runtime-copy.js";
import { TypedConfirmDialog, type TypedConfirmOutcome } from "./TypedConfirmDialog.js";

export function LocalDataResetDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const reset = useResetLocalData();
  const confirm = async (typed: string): Promise<TypedConfirmOutcome> => {
    const result = await reset.mutateAsync(typed);
    if (!result.ok) return { kind: "error", message: result.error.message };
    return result.data.kind === "reset"
      ? { kind: "done", stay: true }
      : { kind: "error", message: result.data.message };
  };
  return (
    <TypedConfirmDialog
      open={open}
      onClose={onClose}
      title={RESET_DIALOG_TITLE}
      description={RESET_DIALOG_DESCRIPTION}
      what={RESET_CONSEQUENCE_WHAT}
      kept={RESET_CONSEQUENCE_KEPT}
      undo={RESET_CONSEQUENCE_UNDO}
      phrase={LOCAL_DATA_RESET_PHRASE}
      submit={RESET_SUBMIT}
      pending={RESET_PENDING}
      doneText={RESET_RELAUNCHING}
      onConfirm={confirm}
      testId="local-data-reset"
    />
  );
}
