/**
 * Settings → Local runtime: removing what the previous release left behind,
 * once the move into the native runtime completed (main reports it as
 * `previousReleaseData`, from runtime-state.json). Shown only while that data
 * may still exist; main records a removal, so the row goes once it is done.
 *
 * After a start-fresh the old data was never imported: the copy says it is
 * the only copy, and only then is `allowWithoutImport` sent. Main refuses on
 * its own terms (not completed, not imported, another install, busy), and each
 * refusal is said in words. The words live with the migration screen's
 * (`features/runtime/migration/copy.ts`), the one renderer file allowed to
 * name the old stack.
 */

import { useState, type JSX } from "react";
import type { PreviousReleaseData } from "@shared/schemas/system.js";
import { useRemovePreviousReleaseData } from "../../../../lib/api/system.js";
import { REMOVE_OLD_DATA, removeOldDataProblem } from "../../../runtime/migration/copy.js";
import { TypedConfirmDialog, type TypedConfirmOutcome } from "./TypedConfirmDialog.js";

const SECTION = "vex-set__sec border-t border-rule pt-5";
const BODY = "vex-set__note mt-2";

export function PreviousReleaseDataSection({ data }: { readonly data: PreviousReleaseData }): JSX.Element | null {
  const remove = useRemovePreviousReleaseData();
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);

  if (removed) {
    return (
      <section aria-label={REMOVE_OLD_DATA.heading} className={SECTION} data-vex-previous-release-data="removed">
        <h3 className="vex-set__sh-title">{REMOVE_OLD_DATA.heading}</h3>
        <p role="status" className={BODY}>
          {REMOVE_OLD_DATA.done}
        </p>
      </section>
    );
  }
  if (data.kind === "none") return null;
  const imported = data.imported;

  const confirm = async (): Promise<TypedConfirmOutcome> => {
    const result = await remove.mutateAsync(!imported);
    if (!result.ok) return { kind: "error", message: result.error.message };
    if (result.data.kind === "removed") {
      setRemoved(true);
      return { kind: "done", stay: false };
    }
    return { kind: "error", message: removeOldDataProblem(result.data) };
  };

  return (
    <section
      aria-label={REMOVE_OLD_DATA.heading}
      className={SECTION}
      data-vex-previous-release-data={imported ? "imported" : "not-imported"}
    >
      <h3 className="vex-set__sh-title">{REMOVE_OLD_DATA.heading}</h3>
      <p className={BODY}>{imported ? REMOVE_OLD_DATA.bodyImported : REMOVE_OLD_DATA.bodyNotImported}</p>
      <div className="mt-3">
        <button
          type="button"
          className="vex-sbtn"
          onClick={() => setOpen(true)}
          data-vex-previous-release-data-open=""
        >
          {REMOVE_OLD_DATA.open}
        </button>
      </div>
      <TypedConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={REMOVE_OLD_DATA.dialogTitle}
        description={imported ? REMOVE_OLD_DATA.descriptionImported : REMOVE_OLD_DATA.descriptionNotImported}
        what={imported ? REMOVE_OLD_DATA.whatImported : REMOVE_OLD_DATA.whatNotImported}
        kept={REMOVE_OLD_DATA.kept}
        undo={REMOVE_OLD_DATA.undo}
        phrase={REMOVE_OLD_DATA.phrase}
        submit={REMOVE_OLD_DATA.submit}
        pending={REMOVE_OLD_DATA.pending}
        doneText={REMOVE_OLD_DATA.done}
        onConfirm={confirm}
        testId="previous-release-data"
      />
    </section>
  );
}
