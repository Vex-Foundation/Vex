/**
 * THE REPAIR DIALOG: confirm, then the render report.
 *
 * ## Why Repair owns a dialog instead of living in the settings pane
 *
 * Repair is the ONLY path that OVERWRITES a managed block a human edited - the
 * schema says so in as many words (`projectRepairFilesResultSchema`: "the only
 * path that overwrites a drifted managed block, which is why it is an explicit
 * user action with its own channel"). An action that can destroy someone's edit
 * needs a place to say so BEFORE it runs, and the settings dialog has no such
 * place: its primary action is Save, its body is a scope form, and a Repair
 * button parked in it would fire a destructive write from a screen the user
 * opened to change a permission. Folding it in would also drop the user into a
 * scope editor they did not ask for while a write they did ask for is in
 * flight.
 *
 * So: its own dialog, its own confirm, and the SAME `RenderOutcomePanel` the
 * settings dialog uses for the report - because `repairFiles` and `updateScope`
 * return the identical `{ project, render }` pair and two renderers for one
 * shape would be two chances to drop a refusal.
 *
 * ## Not retried automatically
 *
 * `useRepairProjectFiles` sets `retry: false` for the reason above: a blind
 * retry would repeat a destructive-to-someone's-edit action the user asked for
 * exactly once. This dialog never resubmits on its own either; every attempt is
 * a press.
 *
 * Focus defaults to Cancel, as every dialog here whose confirm can lose work
 * does.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import type { StudioRenderOutcome } from "@shared/schemas/studio-installer.js";
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
import { useLiveAnnouncer } from "../../../../components/ui/live-region.js";
import { SubmitError } from "../../../../components/ui/submit-error.js";
import { useRepairProjectFiles } from "../../../../lib/api/projects.js";
import { ProjectFilesPanel } from "./ProjectFilesPanel.js";
import { RenderOutcomePanel } from "./RenderOutcomePanel.js";
import {
  PROJECT_CANCEL,
  PROJECT_CLOSE,
  PROJECT_REPAIR_BODY,
  PROJECT_REPAIR_CONSEQUENCE_SCOPE,
  PROJECT_REPAIR_CONSEQUENCE_UNDO,
  PROJECT_REPAIR_CONSEQUENCE_WHAT,
  PROJECT_REPAIR_PENDING,
  PROJECT_REPAIR_SUBMIT,
  PROJECT_REPAIR_TITLE,
  projectFolderLine,
  renderReportAnnouncement,
} from "./projects-copy.js";

export interface ProjectRepairDialogProps {
  /** `null` closes the dialog. The row as the list holds it. */
  readonly project: ProjectDto | null;
  readonly onClose: () => void;
}

export function ProjectRepairDialog({
  project,
  onClose,
}: ProjectRepairDialogProps): JSX.Element {
  const open = project !== null;
  const repairMutation = useRepairProjectFiles();
  const [render, setRender] = useState<StudioRenderOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Announced from the confirm path; see `components/ui/live-region.tsx`. */
  const { announce, region: liveRegion } = useLiveAnnouncer();

  useEffect(() => {
    if (!open) return;
    setRender(null);
    setSubmitError(null);
  }, [open, project?.id]);

  const pending = repairMutation.isPending;

  const onConfirm = useCallback(async (): Promise<void> => {
    if (project === null || pending) return;
    setSubmitError(null);
    const result = await repairMutation.mutateAsync({ projectId: project.id });
    if (!result.ok) {
      setSubmitError(result.error.message);
      announce("error", result.error.message);
      return;
    }
    // The dialog STAYS OPEN on the report. A repair that refused three of four
    // files succeeded as a call and failed at the thing the user wanted, and
    // closing on the Result alone would show only the first half.
    setRender(result.data.render);
    announce(
      result.data.render.runFailure !== null ? "error" : "info",
      renderReportAnnouncement(result.data.render),
    );
  }, [announce, pending, project, repairMutation]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg" closeOnBackdropClick={false}>
        <DialogHeader className="border-line-2">
          <DialogTitle>{PROJECT_REPAIR_TITLE}</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            {project === null
              ? PROJECT_REPAIR_BODY
              : projectFolderLine(project.displayPath)}
          </DialogDescription>
        </DialogHeader>

        {/* THE CONSEQUENCE, in the NOTICE register (audit A10). Repair
          * overwrites a file the user may have edited, so it owes them the
          * strip; it does not end a project or move a folder to the trash, so
          * dressing it in Delete's red would leave Studio's two most
          * consequential buttons speaking one tone for two different outcomes.
          * Gone once the repair has run: the report below is then the answer,
          * and a strip still promising a rewrite would be describing the past
          * in the future tense. */}
        {render === null ? (
          <DialogConsequence tone="notice" data-vex-consent="repair">
            <span className="font-medium">{PROJECT_REPAIR_CONSEQUENCE_WHAT}</span>
            {project !== null ? (
              <span className="truncate font-mono text-[11px] text-ink-secondary">
                {projectFolderLine(project.displayPath)}
              </span>
            ) : null}
            <span className="text-ink-secondary">
              {PROJECT_REPAIR_CONSEQUENCE_SCOPE}
            </span>
            <span className="text-ink-secondary">
              {PROJECT_REPAIR_CONSEQUENCE_UNDO}
            </span>
          </DialogConsequence>
        ) : null}

        {/* The confirm phase only. Once the repair has run, the file list this
          * body held describes the disk BEFORE the write, and the report that
          * replaces it is pinned below rather than scrolled. */}
        {render === null ? (
          <DialogBody className="gap-4">
            {/* The body no longer repeats what the strip above states. It said
              * the same three facts in a paragraph the user had to scroll to,
              * which is the arrangement the strip exists to replace. */}
            {/* What is on disk RIGHT NOW, so the user can see which files the
              * overwrite would actually touch before pressing Repair. No
              * `onRepair`: the confirm button below IS the repair, and a second
              * one inside this dialog would point back at itself. */}
            {project !== null ? <ProjectFilesPanel files={project.files} /> : null}
          </DialogBody>
        ) : null}

        {liveRegion}

        {/* PINNED: the report of a destructive write, and any refusal of it,
          * beside the button that ran it rather than under a file list the
          * user would have to scroll past. */}
        {render !== null || submitError !== null ? (
          <DialogPinnedSlot>
            <SubmitError submitError={submitError} />
            {render !== null ? <RenderOutcomePanel render={render} /> : null}
          </DialogPinnedSlot>
        ) : null}

        <DialogFooter className="border-line-2">
          {render === null ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={pending}
                // The safer choice takes focus (rule 08); `DialogContent`
                // moves focus here after `showModal()`.
                {...DIALOG_INITIAL_FOCUS}
                className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
              >
                {PROJECT_CANCEL}
              </Button>
              {/* PRIMARY, not danger (audit A10). Repair rewrites files Vex
                * maintains and can rewrite again; Delete is the one action in
                * Studio that ends something, and it keeps the destructive
                * tone alone so the tone still means something. */}
              <Button
                type="button"
                onClick={() => void onConfirm()}
                disabled={pending}
              >
                {pending ? PROJECT_REPAIR_PENDING : PROJECT_REPAIR_SUBMIT}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={onClose} autoFocus>
              {PROJECT_CLOSE}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
