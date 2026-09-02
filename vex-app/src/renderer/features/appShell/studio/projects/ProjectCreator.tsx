/**
 * THE NEW-PROJECT DIALOG. Mirrors `SessionCreator` and differs where a project
 * differs from a session.
 *
 * ## Two phases in one dialog, and the second one is not optional
 *
 * A create does two things: it claims a directory, and it WRITES FILES INTO
 * THAT DIRECTORY for every agent the user selected. Those writes can refuse -
 * a foreign entry at the Vex path, a malformed config, an agent Vex cannot
 * integrate - and the project that comes back carries the per-artifact result
 * on `files`.
 *
 * So a successful create does not close the dialog. It switches it to a RESULT
 * phase that renders every one of those artifacts, and the user closes it
 * themselves. Closing on success and raising a toast would make "four files
 * written" and "four files Vex was refused on" the same green flash, which is
 * exactly the swallowed refusal `studio-installer.ts` was shaped to prevent.
 *
 * The project is SELECTED the moment the create succeeds, not when the dialog
 * closes: the row exists, the sidebar should show it, and holding the selection
 * hostage to a dialog the user has not read yet would make the shell lie about
 * what Vex has done.
 *
 * ## Both panels, because a create now answers both questions
 *
 * `projectCreateResultSchema` is the shared `{ project, render,
 * refreshFailure }` envelope: creating a project RENDERS its files, so the
 * dialog can finally report what that run DID as well as what the files ARE.
 * Both are shown - the run's verdict in the dialog's PINNED SLOT, where it
 * cannot be scrolled away from the button that produced it, the per-file
 * inventory in the scrolling body - and neither is projected into the other: the
 * outcome vocabulary records what a run did, the status vocabulary records what
 * a file is, and deriving one from the other would mean reporting writes and
 * refusals nobody performed. `ProjectFilesPanel`'s module note carries the
 * concrete defect that reasoning removed.
 *
 * When the re-read after the render failed, `refreshFailure` says so above both
 * panels: the project shown is the row as it was committed, which is real and
 * may be one field behind.
 *
 * ## Refusals render by NAME
 *
 * `projects.slug_taken` and every other refusal come back as
 * `result.error.message`, already sanitized by main, and are printed. Nothing
 * here maps a refusal to "something went wrong".
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  PROJECT_NAME_MAX_LENGTH,
  type ProjectCreateInput,
  type ProjectCreateResult,
  type ProjectDto,
} from "@shared/schemas/projects.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type { StudioAgentId } from "@shared/schemas/studio-agent-ids.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPinnedSlot,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { useLiveAnnouncer } from "../../../../components/ui/live-region.js";
import { SubmitError } from "../../../../components/ui/submit-error.js";
import { useCreateProject } from "../../../../lib/api/projects.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import { openProjectRepair } from "./project-dialog-intent.js";
import { FullAccessConsent } from "./FullAccessConsent.js";
import {
  ProjectAgentFieldset,
  ProjectPermissionFieldset,
  ProjectWalletFieldset,
  selectedWalletLabels,
} from "./ProjectScopeFields.js";
import { ProjectFilesPanel } from "./ProjectFilesPanel.js";
import { RenderOutcomePanel } from "./RenderOutcomePanel.js";
import {
  PROJECT_CANCEL,
  PROJECT_CLOSE,
  PROJECT_CREATE_LEAD,
  PROJECT_CREATE_PENDING,
  PROJECT_CREATE_SUBMIT,
  PROJECT_CREATE_TITLE,
  PROJECT_NAME_HELP,
  PROJECT_NAME_LABEL,
  PROJECT_NAME_PLACEHOLDER,
  projectFolderLine,
  renderReportAnnouncement,
} from "./projects-copy.js";

/**
 * The one refusal that names a FIELD of this form.
 *
 * `projects.slug_taken` is about the name the user typed, so the dialog puts
 * the caret back in it: the message alone leaves a keyboard user to find the
 * field again, and on a form taller than the dialog it may not even be on
 * screen. Compared against `error.code` rather than the message, because the
 * code is where a refusal's identity lives.
 */
export const SLUG_TAKEN_CODE = "projects.slug_taken";

export interface ProjectCreatorProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** Select the freshly created project. Called the moment the create lands. */
  readonly onCreated: (project: ProjectDto) => void;
}

export function ProjectCreator({
  open,
  onOpenChange,
  onCreated,
}: ProjectCreatorProps): JSX.Element {
  const createMutation = useCreateProject();
  const walletsQuery = useAvailableWallets();
  const inventory =
    walletsQuery.data?.ok === true
      ? walletsQuery.data.data
      : { evm: [], solana: [] };

  const [name, setName] = useState("");
  const [permission, setPermission] = useState<SessionPermission>("restricted");
  const [evmWalletId, setEvmWalletId] = useState<string | null>(null);
  const [solanaWalletId, setSolanaWalletId] = useState<string | null>(null);
  const [agents, setAgents] = useState<readonly StudioAgentId[]>([]);
  /**
   * The Full-access grant has been acknowledged FOR THE PROPOSAL ON SCREEN.
   *
   * Dropped by every edit to a field the strip names - the permission and the
   * two wallet selects - which is what makes it an acknowledgement of a specific
   * grant rather than a box that stays ticked while the grant changes under it.
   * Dropping it on the way OUT of Full access is what makes the round trip
   * restricted -> full ask again, instead of restoring a consent the user gave
   * to a proposal they have since walked away from.
   */
  const [fullAccessAcknowledged, setFullAccessAcknowledged] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Set on success. Its presence IS the result phase. */
  const [created, setCreated] = useState<ProjectCreateResult | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // Announced from the SUBMIT PATH, not from a role on a node that may be
  // scrolled out of view - see `components/ui/live-region.tsx`.
  const { announce, region: liveRegion } = useLiveAnnouncer();

  // Reset on every (re)open so a second create never inherits the first's
  // selection - or, worse, its result pane.
  useEffect(() => {
    if (!open) return;
    setName("");
    setPermission("restricted");
    setEvmWalletId(null);
    setSolanaWalletId(null);
    setAgents([]);
    setFullAccessAcknowledged(false);
    setSubmitError(null);
    setCreated(null);
  }, [open]);

  // The name is the only text field, so it takes focus. Deferred a frame past
  // `showModal`, exactly as `SessionCreator` does.
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      nameRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open]);

  const trimmedName = name.trim();
  const pending = createMutation.isPending;
  const grantingFullAccess = permission === "full";
  /** The grant is unacknowledged, so there is nothing to create yet. */
  const consentMissing = grantingFullAccess && !fullAccessAcknowledged;
  const submitDisabled = trimmedName.length === 0 || consentMissing || pending;
  const walletLabels = selectedWalletLabels(
    evmWalletId,
    solanaWalletId,
    inventory.evm,
    inventory.solana,
  );

  /**
   * Every edit the consent strip NAMES drops the acknowledgement.
   *
   * One helper rather than three call sites so a field added to the strip
   * cannot be wired to the form without passing through here.
   */
  const invalidateConsent = useCallback((): void => {
    setFullAccessAcknowledged(false);
  }, []);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (trimmedName.length === 0 || createMutation.isPending) return;
      // THE GATE, at the point the wire input is built rather than only on the
      // button. A disabled attribute is a statement about dispatch, not a rule:
      // a synthetic submit, an Enter in a text field or a queued event all
      // reach here, and this is the last place before a grant leaves for main.
      if (permission === "full" && !fullAccessAcknowledged) return;
      setSubmitError(null);
      const input: ProjectCreateInput = {
        name: trimmedName,
        permission,
        agents: [...agents],
        wallets: { evm: evmWalletId, solana: solanaWalletId },
      };
      const result = await createMutation.mutateAsync(input);
      if (!result.ok) {
        // BY NAME. `projects.slug_taken`, a wallet drift, a refused directory:
        // main's message is already sanitized and is the only thing the user
        // can act on.
        setSubmitError(result.error.message);
        announce("error", result.error.message);
        if (result.error.code === SLUG_TAKEN_CODE) {
          const field = nameRef.current;
          field?.focus();
          field?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      // Selected NOW: the row exists whether or not the user has read the file
      // report yet.
      onCreated(result.data.project);
      setCreated(result.data);
      announce(
        result.data.render.runFailure !== null ? "error" : "info",
        renderReportAnnouncement(result.data.render),
      );
    },
    [
      agents,
      announce,
      createMutation,
      evmWalletId,
      fullAccessAcknowledged,
      onCreated,
      permission,
      solanaWalletId,
      trimmedName,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        // An explicit choice, not a stray backdrop click: the form holds real
        // input, and the result pane holds facts about the user's disk.
        closeOnBackdropClick={false}
      >
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="gap-2.5 border-line-2 px-8 py-5">
            <DialogTitle className="vex-eyebrow">
              {PROJECT_CREATE_TITLE}
            </DialogTitle>
            <DialogDescription className="text-xs text-ink-tertiary">
              {created === null
                ? PROJECT_CREATE_LEAD
                : projectFolderLine(created.project.displayPath)}
            </DialogDescription>
          </DialogHeader>

          {/* THE CONSEQUENCE, above the scroll region, for the one choice in
            * this form that grants authority over the user's disk and wallets.
            * Rendered only while that choice stands: a strip that is always
            * there is chrome, and chrome is not read. */}
          {created === null && grantingFullAccess ? (
            <FullAccessConsent
              displayPath={null}
              walletLabels={walletLabels}
              acknowledged={fullAccessAcknowledged}
              disabled={pending}
              onAcknowledgedChange={setFullAccessAcknowledged}
            />
          ) : null}

          <DialogBody className="gap-6 px-8">
            {created === null ? (
              <>
                <div className="flex flex-col gap-2.5">
                  <Label htmlFor="vex-project-name" className="vex-eyebrow">
                    {PROJECT_NAME_LABEL}
                  </Label>
                  <Input
                    ref={nameRef}
                    id="vex-project-name"
                    type="text"
                    required
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={PROJECT_NAME_PLACEHOLDER}
                    className="h-10"
                  />
                  <div className="flex items-center justify-between gap-3 text-xs text-ink-tertiary">
                    <p>{PROJECT_NAME_HELP}</p>
                    <span
                      aria-live="polite"
                      className="font-mono text-[10px] tracking-[0.14em] tabular-nums text-ink-tertiary"
                    >
                      {name.length} / {PROJECT_NAME_MAX_LENGTH}
                    </span>
                  </div>
                </div>

                <ProjectPermissionFieldset
                  permission={permission}
                  onPermissionChange={(next) => {
                    invalidateConsent();
                    setPermission(next);
                  }}
                />

                <ProjectWalletFieldset
                  evmWalletId={evmWalletId}
                  solanaWalletId={solanaWalletId}
                  evmOptions={inventory.evm}
                  solanaOptions={inventory.solana}
                  onEvmChange={(next) => {
                    invalidateConsent();
                    setEvmWalletId(next);
                  }}
                  onSolanaChange={(next) => {
                    invalidateConsent();
                    setSolanaWalletId(next);
                  }}
                />

                <ProjectAgentFieldset
                  agents={agents}
                  onAgentsChange={setAgents}
                  disabled={pending}
                />
              </>
            ) : (
              // The per-artifact inventory scrolls; the RUN's verdict does not
              // (it is pinned below). What each file IS answers a question the
              // user reads at their own pace; what the run DID is the answer to
              // the button they just pressed.
              <ProjectFilesPanel
                files={created.project.files}
                onRepair={() => {
                  openProjectRepair(created.project.id);
                }}
              />
            )}
          </DialogBody>

          {liveRegion}

          {/* PINNED: the refusal, or the run report, beside the button that
            * produced it. Rendered as the body's last child both used to land
            * below the fold of a form taller than the dialog. */}
          {created === null ? (
            submitError !== null ? (
              <DialogPinnedSlot className="px-8">
                <SubmitError submitError={submitError} />
              </DialogPinnedSlot>
            ) : null
          ) : (
            <DialogPinnedSlot className="px-8">
              <RenderOutcomePanel
                render={created.render}
                refreshFailure={created.refreshFailure}
              />
            </DialogPinnedSlot>
          )}

          <DialogFooter className="border-line-2 px-8 py-4">
            {created === null ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={pending}
                  className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
                >
                  {PROJECT_CANCEL}
                </Button>
                <Button type="submit" disabled={submitDisabled} className="h-10 px-6">
                  {pending ? PROJECT_CREATE_PENDING : PROJECT_CREATE_SUBMIT}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-10 px-6"
                autoFocus
              >
                {PROJECT_CLOSE}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
