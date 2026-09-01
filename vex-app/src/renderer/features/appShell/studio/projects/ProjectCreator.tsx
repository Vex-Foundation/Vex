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
 * ## Which panel the result phase uses, and why it is not the other one
 *
 * `projectCreateResultSchema` is `projectDtoSchema` - a create returns the
 * project and NO render envelope. So the result phase renders
 * `project.files`, the per-artifact STATE on disk, through
 * `ProjectFilesPanel`. It does not render `RenderOutcomePanel`, and it does
 * not project one shape into the other: the outcome vocabulary records what a
 * run DID, the status vocabulary records what a file IS, and deriving the
 * first from the second would mean reporting writes and refusals the create
 * never told us about. `ProjectFilesPanel`'s module note carries the concrete
 * defect that reasoning removed.
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
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { useCreateProject } from "../../../../lib/api/projects.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import { SubmitError } from "../../SessionCreator/FormSections.js";
import {
  ProjectAgentFieldset,
  ProjectPermissionFieldset,
  ProjectWalletFieldset,
} from "./ProjectScopeFields.js";
import { ProjectFilesPanel } from "./ProjectFilesPanel.js";
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
} from "./projects-copy.js";

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
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Set on success. Its presence IS the result phase. */
  const [created, setCreated] = useState<ProjectDto | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Reset on every (re)open so a second create never inherits the first's
  // selection - or, worse, its result pane.
  useEffect(() => {
    if (!open) return;
    setName("");
    setPermission("restricted");
    setEvmWalletId(null);
    setSolanaWalletId(null);
    setAgents([]);
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
  const submitDisabled = trimmedName.length === 0 || pending;

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (trimmedName.length === 0 || createMutation.isPending) return;
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
        return;
      }
      // Selected NOW: the row exists whether or not the user has read the file
      // report yet.
      onCreated(result.data);
      setCreated(result.data);
    },
    [
      agents,
      createMutation,
      evmWalletId,
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
                : projectFolderLine(created.displayPath)}
            </DialogDescription>
          </DialogHeader>

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
                  onPermissionChange={setPermission}
                />

                <ProjectWalletFieldset
                  evmWalletId={evmWalletId}
                  solanaWalletId={solanaWalletId}
                  evmOptions={inventory.evm}
                  solanaOptions={inventory.solana}
                  onEvmChange={setEvmWalletId}
                  onSolanaChange={setSolanaWalletId}
                />

                <ProjectAgentFieldset
                  agents={agents}
                  onAgentsChange={setAgents}
                  disabled={pending}
                />

                <SubmitError submitError={submitError} />
              </>
            ) : (
              <ProjectFilesPanel files={created.files} />
            )}
          </DialogBody>

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
