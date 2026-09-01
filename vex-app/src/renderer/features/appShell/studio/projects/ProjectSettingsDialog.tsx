/**
 * THE PROJECT SCOPE EDITOR: permission, wallets, coding agents.
 *
 * Everything the creator collects except the name, which is immutable (the slug
 * is derived from it and it IS the directory under the projects root; see the
 * DTO's `rootPath` note).
 *
 * ## Optimistic concurrency is the point of this dialog
 *
 * `expectedScopeVersion` is carried from the project this dialog LOADED, not
 * re-read at submit. Re-reading it would defeat the mechanism entirely: the
 * whole purpose is to refuse an edit composed against a project that has since
 * changed, and a version fetched a millisecond before the write would always
 * match.
 *
 * ## `projects.scope_conflict` is NEVER auto-retried
 *
 * `useUpdateProjectScope` sets `retry: false` and this dialog adds the second
 * half of that contract: a conflict switches to its own pane with its own copy
 * and offers a RELOAD, never a resubmit. The expected version was consumed by
 * the attempt, so pressing Save again would either conflict identically or
 * re-apply an intent the user composed against a project that no longer looks
 * like that. The reload refetches, reseeds the form from what is actually
 * stored, and the user makes the choice again with the current facts in front
 * of them. Nothing is resent on the user's behalf.
 *
 * The RELOAD WINDOW is part of that contract and has its own state. Clearing
 * the conflict before awaiting the refetch put the stale form and its enabled
 * Save back on screen for the length of an IPC roundtrip, which is a second
 * submission against the version the first one already consumed. So the pane
 * stays mounted through an explicit `reloading` state and the fresh row
 * replaces the draft in one transition.
 *
 * ## Every render outcome is surfaced
 *
 * A scope edit rewrites files in the user's repository. `updateScope` returns
 * `{ project, render }` and the render half is shown in full through
 * `RenderOutcomePanel` before the dialog closes - a green "Saved" over a
 * refused config would be the exact lie `projectUpdateScopeResultSchema`'s
 * "ONE RESULT, TWO FACTS" note exists to prevent.
 *
 * ## A stored selection is sanitized on load
 *
 * An agent selection stored while an agent was supported is dropped from the
 * FORM if that agent is unsupported today. Keeping it checked would let the
 * next save resend a choice the user cannot see themselves making, and the
 * installer would answer `unsupported` for it forever. The DROP is visible: the
 * form becomes dirty against the stored value, so the user is shown that
 * something changed rather than having it happen behind the Save button.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import type {
  ProjectDto,
  ProjectUpdateScopeInput,
} from "@shared/schemas/projects.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type { StudioAgentId } from "@shared/schemas/studio-agent-ids.js";
import type {
  StudioProjectRefreshFailure,
  StudioRenderOutcome,
} from "@shared/schemas/studio-installer.js";
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
import { useProject, useUpdateProjectScope } from "../../../../lib/api/projects.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import type { WalletSelectOption } from "../../SessionWalletSelect.js";
import { SubmitError } from "../../SessionCreator/FormSections.js";
import {
  orderedAgents,
  ProjectAgentFieldset,
  ProjectPermissionFieldset,
  ProjectWalletFieldset,
} from "./ProjectScopeFields.js";
import { RenderOutcomePanel } from "./RenderOutcomePanel.js";
import { SELECTABLE_STUDIO_AGENT_IDS } from "./studio-agent-catalogue.js";
import {
  PROJECT_CANCEL,
  PROJECT_CLOSE,
  PROJECT_SCOPE_CONFLICT_BODY,
  PROJECT_SCOPE_CONFLICT_RELOAD,
  PROJECT_SCOPE_CONFLICT_RELOADING,
  PROJECT_SCOPE_CONFLICT_TITLE,
  PROJECT_SETTINGS_LOADING,
  PROJECT_SETTINGS_PENDING,
  PROJECT_SETTINGS_SUBMIT,
  PROJECT_SETTINGS_TITLE,
  PROJECT_SETTINGS_UNCHANGED,
  PROJECT_SETTINGS_UNREADABLE,
  projectFolderLine,
} from "./projects-copy.js";

/**
 * The wire code main refuses a stale edit with. Compared against
 * `result.error.code`, which is where a refusal's identity lives; the message
 * is for the human and the code is for the branch.
 */
export const SCOPE_CONFLICT_CODE = "projects.scope_conflict";

/**
 * Where this dialog stands with respect to a REFUSED save.
 *
 * A discriminated state rather than a boolean pair (rule 08): `reloading` is
 * not "conflict, plus a spinner somewhere". It is the window in which the
 * consumed scope version is gone and the fresh one has not arrived, and the
 * editable form must not EXIST in it - a Save pressed there would carry the
 * version the refused attempt already spent. Modelling it as
 * `conflict === false && draft === stale` was exactly the defect.
 */
type ScopeConflictState =
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }
  | { readonly kind: "reloading" };

/** The form's editable state. Exactly the fields `updateScope` accepts. */
interface ScopeDraft {
  readonly permission: SessionPermission;
  readonly evmWalletId: string | null;
  readonly solanaWalletId: string | null;
  readonly agents: readonly StudioAgentId[];
}

export interface ProjectSettingsDialogProps {
  /** `null` closes the dialog. */
  readonly projectId: string | null;
  readonly onClose: () => void;
}

export function ProjectSettingsDialog({
  projectId,
  onClose,
}: ProjectSettingsDialogProps): JSX.Element {
  const open = projectId !== null;
  const projectQuery = useProject(projectId);
  const updateMutation = useUpdateProjectScope();
  const walletsQuery = useAvailableWallets();
  const inventory =
    walletsQuery.data?.ok === true
      ? walletsQuery.data.data
      : { evm: [], solana: [] };

  const project: ProjectDto | null =
    projectQuery.data !== undefined && projectQuery.data.ok
      ? projectQuery.data.data
      : null;

  const [draft, setDraft] = useState<ScopeDraft | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ScopeConflictState>({
    kind: "none",
  });
  const [render, setRender] = useState<StudioRenderOutcome | null>(null);
  /**
   * The save COMMITTED and main could not read the project back. The row this
   * dialog reseeds itself from is then the committed one, whose file status may
   * already be behind, so the report says so rather than presenting it as
   * current.
   */
  const [refreshFailure, setRefreshFailure] =
    useState<StudioProjectRefreshFailure | null>(null);
  /**
   * Single-flight for the reload. The disabled button is the affordance; this
   * is the guard, because a keyboard repeat or a re-render racing the state
   * update must not put two reads in flight against one conflict.
   */
  const reloadingRef = useRef(false);

  /** The conflict pane is on screen: as a refusal, or mid-reload. */
  const showingConflict = conflictState.kind !== "none";
  const reloading = conflictState.kind === "reloading";

  /**
   * The scope version this dialog is editing AGAINST.
   *
   * Captured with the draft rather than read from `project` at submit time.
   * The query cache is reseeded by every sibling mutation, so reading it later
   * would silently adopt a version this form's values were never composed
   * against - which is the stale write `expectedScopeVersion` exists to refuse.
   */
  const [editingVersion, setEditingVersion] = useState<number | null>(null);

  /** Seed the form from a loaded project. The one place a draft is born. */
  const seedFrom = useCallback((loaded: ProjectDto): void => {
    const selectable = new Set(SELECTABLE_STUDIO_AGENT_IDS);
    setDraft({
      permission: loaded.permission,
      evmWalletId: loaded.wallets.evm?.id ?? null,
      solanaWalletId: loaded.wallets.solana?.id ?? null,
      agents: orderedAgents(
        new Set(loaded.agents.filter((id) => selectable.has(id))),
      ),
    });
    setEditingVersion(loaded.scopeVersion);
  }, []);

  // Seed once per opening, and NOT on every cache reseed: re-seeding while the
  // user is editing would silently discard their unsaved choices.
  useEffect(() => {
    if (!open) {
      setDraft(null);
      setEditingVersion(null);
      setSubmitError(null);
      setConflictState({ kind: "none" });
      setRender(null);
      setRefreshFailure(null);
      reloadingRef.current = false;
      return;
    }
    if (draft !== null || project === null) return;
    seedFrom(project);
  }, [draft, open, project, seedFrom]);

  /**
   * The STORED scope, in the same normal form the draft is held in.
   *
   * Ordered through `orderedAgents` so a stored roster written in click order
   * does not read as an edit, but NOT filtered by supportability - that is the
   * whole point. The draft drops an agent that is unsupported today, so the
   * comparison then reports the form as dirty and the user SEES that the
   * selection changed instead of it happening behind the Save button.
   */
  const stored: ScopeDraft | null = useMemo(() => {
    if (project === null) return null;
    return {
      permission: project.permission,
      evmWalletId: project.wallets.evm?.id ?? null,
      solanaWalletId: project.wallets.solana?.id ?? null,
      agents: orderedAgents(new Set(project.agents)),
    };
  }, [project]);

  const dirty =
    draft !== null && stored !== null && !sameScope(draft, stored);
  const pending = updateMutation.isPending;

  /**
   * Leave the conflict by READING THE PROJECT AGAIN.
   *
   * Seeded from the refetch's OWN result, not by clearing the draft and letting
   * the seeding effect run. Clearing was the first version and it was wrong:
   * the effect fires immediately, the query cache still holds the row this
   * dialog loaded, so the form re-seeded from the STALE project and the fresh
   * read that arrived a moment later found a non-null draft and did nothing.
   * The user was then editing the same stale values again, against the same
   * consumed version, with a dialog that claimed it had reloaded.
   *
   * So the draft is held until the new row is in hand and replaced in one step.
   */
  const reload = useCallback(async (): Promise<void> => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    // The pane STAYS. Only the fresh row may take it down, and until it lands
    // there is no form on screen and therefore no Save to press.
    setConflictState({ kind: "reloading" });
    try {
      const outcome = await projectQuery.refetch();
      const result = outcome.data;
      if (result === undefined || !result.ok || result.data === null) {
        // The read failed, or the project is gone. Drop the draft rather than
        // leave the form editable against a row Vex could not confirm; the body
        // then renders the unreadable or loading state, which is the truth.
        setDraft(null);
        setEditingVersion(null);
        setSubmitError(null);
        setRender(null);
        setRefreshFailure(null);
        setConflictState({ kind: "none" });
        return;
      }
      // ONE transition out of the conflict: the fresh row seeds the draft and
      // the version, and the pane comes down in the same commit. React batches
      // these, so no render ever shows the form before it is reseeded.
      seedFrom(result.data);
      setSubmitError(null);
      setRender(null);
      setRefreshFailure(null);
      setConflictState({ kind: "none" });
    } finally {
      reloadingRef.current = false;
    }
  }, [projectQuery, seedFrom]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (
        // The conflict pane renders no Save, but the FORM is still mounted
        // under it and a stray submit (an Enter, a queued event) would carry
        // the version the refused attempt already consumed. The guard lives
        // here because this is where the version is spent, not in the markup
        // that happens to hide the button.
        conflictState.kind !== "none" ||
        draft === null ||
        editingVersion === null ||
        projectId === null ||
        !dirty ||
        pending
      ) {
        return;
      }
      setSubmitError(null);
      setRender(null);
      setRefreshFailure(null);
      const input: ProjectUpdateScopeInput = {
        projectId,
        expectedScopeVersion: editingVersion,
        permission: draft.permission,
        wallets: { evm: draft.evmWalletId, solana: draft.solanaWalletId },
        agents: [...draft.agents],
      };
      const result = await updateMutation.mutateAsync(input);
      if (!result.ok) {
        if (result.error.code === SCOPE_CONFLICT_CODE) {
          // ITS OWN PANE, and no resubmit. See the module note.
          setConflictState({ kind: "conflict" });
          return;
        }
        setSubmitError(result.error.message);
        return;
      }
      // The write landed. The dialog stays open on the render report: the save
      // succeeded AND some file may have been refused, and both are true.
      setRender(result.data.render);
      setRefreshFailure(result.data.refreshFailure);
      seedFrom(result.data.project);
    },
    [
      conflictState.kind,
      dirty,
      draft,
      editingVersion,
      pending,
      projectId,
      seedFrom,
      updateMutation,
    ],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-2xl" closeOnBackdropClick={false}>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="gap-2.5 border-line-2 px-8 py-5">
            <DialogTitle className="vex-eyebrow">
              {showingConflict
                ? PROJECT_SCOPE_CONFLICT_TITLE
                : PROJECT_SETTINGS_TITLE}
            </DialogTitle>
            <DialogDescription className="text-xs text-ink-tertiary">
              {showingConflict
                ? PROJECT_SCOPE_CONFLICT_BODY
                : project === null
                  ? PROJECT_SETTINGS_LOADING
                  : projectFolderLine(project.displayPath)}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="gap-6 px-8">
            {showingConflict ? null : <SettingsBody
              project={project}
              projectId={projectId}
              queryFailed={
                projectQuery.data !== undefined && !projectQuery.data.ok
              }
              draft={draft}
              pending={pending}
              inventory={inventory}
              dirty={dirty}
              onDraftChange={setDraft}
            />}

            {!showingConflict ? <SubmitError submitError={submitError} /> : null}
            {!showingConflict && render !== null ? (
              <RenderOutcomePanel render={render} refreshFailure={refreshFailure} />
            ) : null}
          </DialogBody>

          <DialogFooter className="border-line-2 px-8 py-4">
            {showingConflict ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
                >
                  {PROJECT_CLOSE}
                </Button>
                <Button
                  type="button"
                  onClick={() => void reload()}
                  disabled={reloading}
                  className="h-10 px-6"
                  autoFocus
                >
                  {reloading
                    ? PROJECT_SCOPE_CONFLICT_RELOADING
                    : PROJECT_SCOPE_CONFLICT_RELOAD}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={pending}
                  className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
                >
                  {PROJECT_CANCEL}
                </Button>
                <Button
                  type="submit"
                  disabled={!dirty || pending}
                  className="h-10 px-6"
                >
                  {pending ? PROJECT_SETTINGS_PENDING : PROJECT_SETTINGS_SUBMIT}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({
  project,
  projectId,
  queryFailed,
  draft,
  pending,
  inventory,
  dirty,
  onDraftChange,
}: {
  readonly project: ProjectDto | null;
  readonly projectId: string | null;
  readonly queryFailed: boolean;
  readonly draft: ScopeDraft | null;
  readonly pending: boolean;
  readonly inventory: {
    readonly evm: readonly WalletSelectOption[];
    readonly solana: readonly WalletSelectOption[];
  };
  readonly dirty: boolean;
  readonly onDraftChange: (next: ScopeDraft) => void;
}): JSX.Element | null {
  // Four reachable states, not one: still loading, the read failed, the read
  // succeeded with NULL (a stale row the caller was holding), and the form.
  // Collapsing them would report a deleted project as a loading spinner.
  if (projectId === null) return null;
  if (queryFailed) {
    return (
      <p role="alert" className="text-sm text-danger">
        {PROJECT_SETTINGS_UNREADABLE}
      </p>
    );
  }
  if (project === null || draft === null) {
    return (
      <p role="status" className="text-sm text-ink-tertiary">
        {PROJECT_SETTINGS_LOADING}
      </p>
    );
  }

  return (
    <>
      <ProjectPermissionFieldset
        permission={draft.permission}
        onPermissionChange={(permission) =>
          onDraftChange({ ...draft, permission })
        }
      />
      <ProjectWalletFieldset
        evmWalletId={draft.evmWalletId}
        solanaWalletId={draft.solanaWalletId}
        evmOptions={inventory.evm}
        solanaOptions={inventory.solana}
        onEvmChange={(evmWalletId) => onDraftChange({ ...draft, evmWalletId })}
        onSolanaChange={(solanaWalletId) =>
          onDraftChange({ ...draft, solanaWalletId })
        }
      />
      <ProjectAgentFieldset
        agents={draft.agents}
        onAgentsChange={(agents) => onDraftChange({ ...draft, agents })}
        disabled={pending}
      />
      {/* Only while nothing has changed: printed beside a dirty form it would
        * contradict the enabled Save button sitting under it. */}
      {!dirty ? (
        <p className="text-xs text-ink-tertiary">{PROJECT_SETTINGS_UNCHANGED}</p>
      ) : null}
    </>
  );
}

/** Value equality over the four editable fields. Agents compare as a SEQUENCE
 * because both sides are held in canonical roster order (`orderedAgents`), so
 * a positional compare is a set compare here and is cheaper to read. */
function sameScope(a: ScopeDraft, b: ScopeDraft): boolean {
  return (
    a.permission === b.permission &&
    a.evmWalletId === b.evmWalletId &&
    a.solanaWalletId === b.solanaWalletId &&
    a.agents.length === b.agents.length &&
    a.agents.every((id, index) => id === b.agents[index])
  );
}
