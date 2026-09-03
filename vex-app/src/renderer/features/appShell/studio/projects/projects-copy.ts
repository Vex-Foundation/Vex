/**
 * EVERY user-visible string of the Studio project dialogs, in one module.
 *
 * Separate from `../studio-copy.ts` for the reason that file states about the
 * terminal, explorer and viewer copy modules: this is a surface with its own
 * owner and its own vocabulary (scope, render outcomes, tombstones, trash), and
 * folding it into the shell's copy would make one file the place two unrelated
 * wordings are reviewed.
 *
 * Rules that bind this file: English, no em dashes, and NO ROADMAP COPY. An
 * agent Vex cannot integrate says WHY and says what would change it, because
 * that is a fact about today; it never says "coming soon".
 *
 * ONE RULE ABOUT REFUSALS. Every outcome, refusal and warning the installer or
 * the delete can produce has a sentence here, keyed by its wire member, and the
 * records are typed `Record<Member, string>` rather than `Partial`. A new wire
 * member with no sentence is then a type error instead of a blank line in a
 * dialog about the user's files.
 */

import type {
  ProjectDeleteResult,
  ProjectTrashOutcome,
} from "@shared/schemas/projects.js";
import type { StudioAgentId } from "@shared/schemas/studio-agent-ids.js";
import type {
  StudioArtifactKind,
  StudioArtifactStatus,
  StudioArtifactOutcome,
  StudioInstallerWarning,
  StudioProjectRefreshFailure,
  StudioRefusalReason,
  StudioRenderOutcome,
  StudioRunFailure,
} from "@shared/schemas/studio-installer.js";

/* ----------------------------- consent grammar ---------------------------- */

/**
 * THE THREE FACTS EVERY CONSENT STRIP STATES, and the one home they live in.
 *
 * Studio asks for consent in five places - creating a project with Full access,
 * widening an existing project to it, deleting a project, repairing its files,
 * and closing a workspace that has shells running in it - and before this table
 * each of them answered "what am I agreeing to" in its own voice, in a paragraph
 * inside a scrolling body. The strip (`components/ui/dialog.tsx`,
 * `DialogConsequence`) states them in the dialog's chrome, and every sentence it
 * prints is here so the five surfaces cannot drift into describing the same
 * class of act differently.
 *
 * The three facts, in this order, always:
 *
 *   1. WHAT will happen, in the active voice, naming the effect and not the
 *      button;
 *   2. TO WHAT - the folder, the project, the wallets - because "this" is not a
 *      resource identity (rule 90: approval binds to the exact resource);
 *   3. WHETHER IT CAN BE UNDONE, said plainly either way. An action that IS
 *      reversible says so; hedging both directions teaches the user to read
 *      neither.
 *
 * `StudioKeepAliveDialog` reads its strip from here rather than from
 * `studio-copy.ts`, where the rest of its words live, for the reason this
 * module's header gives about vocabulary: the consent grammar is ONE thing
 * across the five dialogs, and splitting it across two copy modules would put
 * "what a Vex consent strip says" in two places to be reviewed.
 */

/* --- the grant: Full access, in the creator and in the settings editor --- */

export const FULL_ACCESS_CONSEQUENCE_WHAT =
  "Agents in this project will be able to act outside its folder and to use its wallets.";

/**
 * Which folder the grant is about. The creator has no path yet - the directory
 * is claimed by the create itself - and says so rather than printing an empty
 * line or guessing at a path Vex has not derived.
 */
export function fullAccessFolderLine(displayPath: string | null): string {
  return displayPath === null
    ? "Folder: the one Vex creates for this project."
    : `Folder: ${displayPath}`;
}

/**
 * WHICH WALLETS, by name.
 *
 * An empty selection is not silence: the grant covers whatever the project ends
 * up holding, so the line says the selection is empty AND that anything selected
 * below joins the grant. Naming only the non-empty case would let a user
 * acknowledge a wallet grant, then add a wallet under the acknowledgement they
 * had already given - which is why the acknowledgement is dropped when this line
 * changes.
 */
export function fullAccessWalletsLine(
  walletLabels: readonly string[],
): string {
  return walletLabels.length === 0
    ? "Wallets: none selected. Any wallet you select below is covered by this grant."
    : `Wallets: ${walletLabels.join(", ")}.`;
}

export const FULL_ACCESS_CONSEQUENCE_UNDO =
  "This can be undone: change the permission back in this project's settings at any time.";

/**
 * THE ACKNOWLEDGEMENT, and it is required rather than decorative.
 *
 * Owner decision, 2026-09-02: Full access is confirmed, not merely picked. The
 * primary action stays disabled until this is checked, the check is dropped
 * whenever the proposal it was given for changes (the permission or the wallet
 * selection), and it is never persisted - a grant acknowledged once for one
 * project says nothing about the next one.
 */
export const FULL_ACCESS_ACKNOWLEDGEMENT =
  "I understand that agents in this project can act outside its folder and can use its wallets.";

/* --------------------------------- delete -------------------------------- */

export function projectDeleteConsequenceWhat(projectName: string): string {
  return `Deleting removes "${projectName}" from Vex and ends every terminal running in it.`;
}

export const PROJECT_DELETE_CONSEQUENCE_FOLDER_KEPT =
  "Your project folder and its contents stay on disk.";
export const PROJECT_DELETE_CONSEQUENCE_FOLDER_TRASHED =
  "Your project folder and everything in it move to your operating system's trash.";

export const PROJECT_DELETE_CONSEQUENCE_UNDO =
  "This cannot be undone. Vex has no way to bring the project back.";
export const PROJECT_DELETE_CONSEQUENCE_UNDO_TRASHED =
  "This cannot be undone. Vex has no way to bring the project back, though the folder can still be recovered from your trash.";

/* --------------------------------- repair -------------------------------- */

export const PROJECT_REPAIR_CONSEQUENCE_WHAT =
  "Repair rewrites the files Vex maintains in this folder so they match the project's current scope.";
export const PROJECT_REPAIR_CONSEQUENCE_SCOPE =
  "A file you edited since Vex wrote it is overwritten. Nothing else in the folder is touched.";
export const PROJECT_REPAIR_CONSEQUENCE_UNDO =
  "An edit Vex overwrites here cannot be recovered from Vex.";

/* ------------------------ closing a project workspace --------------------- */

export const PROJECT_CLOSE_CONSEQUENCE_WHAT =
  "Closing a project ends every shell running in it.";
export const PROJECT_CLOSE_CONSEQUENCE_SCOPE =
  "Only the project you close below. Its files on disk are untouched.";
export const PROJECT_CLOSE_CONSEQUENCE_UNDO =
  "Reopening it restores its files and tabs. The processes do not come back.";

/* --------------------------------- creator -------------------------------- */

export const PROJECT_CREATE_TITLE = "New project";
export const PROJECT_CREATE_LEAD =
  "A project is a folder Vex creates under your projects root. Its permission and its wallet selection can be changed later; the folder name cannot.";
export const PROJECT_CREATE_SUBMIT = "Create";
export const PROJECT_CREATE_PENDING = "Creating";
export const PROJECT_CREATE_DONE = "Done";
export const PROJECT_CANCEL = "Cancel";
export const PROJECT_CLOSE = "Close";

export const PROJECT_NAME_LABEL = "Name";
export const PROJECT_NAME_PLACEHOLDER = "Give this project a short name.";
export const PROJECT_NAME_HELP =
  "Vex derives the folder name from this. The sidebar uses it as the project title.";

export const PROJECT_PERMISSION_LEGEND = "Permission";
export const PROJECT_PERMISSION_OPTIONS = [
  {
    value: "restricted",
    index: "01",
    title: "Restricted",
    description:
      "Agents in this project may act inside the project folder and the wallets you select below.",
    caution: false,
  },
  {
    value: "full",
    index: "02",
    title: "Full access",
    description:
      "Agents in this project may act outside the project folder. Grant this only when you know why you need it.",
    caution: true,
  },
] as const;

export const PROJECT_WALLETS_LEGEND = "Wallets";
export const PROJECT_WALLETS_HELP =
  "Optional. Pick at most one EVM and one Solana wallet this project may use. Vex sends the wallet identifier only; the keys never leave your machine.";
export const PROJECT_WALLET_EVM_LABEL = "EVM wallet";
export const PROJECT_WALLET_SOLANA_LABEL = "Solana wallet";

/**
 * WHAT AN EMPTY WALLET INVENTORY SAYS, and why it is not two "None" selects.
 *
 * With no wallet configured, both pickers rendered a single option reading
 * "None" and offered nothing else: a control whose entire vocabulary is the
 * absence of a choice, printed beside a right rail that says "add your first
 * below" behind the modal the user is looking at. So the fieldset names the
 * PATH instead.
 *
 * It NAMES the path rather than offering a button that walks it. The wallet flow
 * is a full-app settings screen and this dialog is a modal in the browser's top
 * layer, so a control that opened it would have to close this dialog first and
 * discard the name the user has typed and the agents they have picked. Sending
 * someone back to an empty form is a worse answer than telling them where to go
 * and that the choice keeps until they get there.
 */
export const PROJECT_WALLETS_NONE_TITLE = "No wallets yet.";
export const PROJECT_WALLETS_NONE_HELP =
  "Add one in Settings, under Wallets. It appears here the next time you open this dialog, and a project's wallets can be changed at any time after it exists.";

/**
 * WHAT AN UNSELECTED PICKER MEANS, said before the project is saved.
 *
 * Live test 2026-09-03 (A7): a profile held exactly one wallet per chain, both
 * pickers stood at "None" because that is the default, and the project was
 * created that way. The first thing the agent in it was asked was a balance,
 * and the only honest answer it could give was "no wallets selected" - a fact
 * the dialog knew at save time and never said. So the fieldset says it, in the
 * same plain register as the empty-inventory copy above, while the choice is
 * still on screen and free to change.
 *
 * OWNER DECISION, 2026-09-03: pre-selecting the only wallet was REJECTED.
 * Selecting a wallet is what puts an agent's reach over that wallet into the
 * project, and the Full-access strip with its acknowledgement - dropped on
 * every wallet change - exists because that reach is granted deliberately, by
 * an act of the user. A default that picked the wallet for them would
 * pre-consent the exact thing the strip was built to make explicit, and would
 * do it silently for the single-wallet profile that is the most common one.
 * VS Code defaults no setting to a resource the user did not name, and
 * deepseek-harness makes every capability grant an explicit act. The picker may
 * list a lone wallet first; it never arrives chosen.
 */
export const PROJECT_WALLETS_UNSELECTED =
  "No wallet selected. Agents in this project will hold no wallet, so a balance or a transfer has nothing to act on. Pick one above, or add another in Settings under Wallets. A project's wallets can be changed at any time.";

export const PROJECT_AGENTS_LEGEND = "Coding agents";
export const PROJECT_AGENTS_HELP =
  "Vex writes an MCP config for each agent you select, inside this project's folder. You can change the selection later.";

/** How the picker introduces an agent Vex cannot integrate today. */
export function agentSupportReturnsSentence(condition: string): string {
  return `Support returns when ${condition}.`;
}

/**
 * How the picker shows a launch-mode agent's required command.
 *
 * "From the project folder" is part of the instruction, not decoration: the
 * config path in the command is PROJECT-RELATIVE (the catalogue substitutes
 * the engine's own `configPath`), so the command only resolves from there.
 */
export function agentLaunchSentence(instruction: string): string {
  return `Launch it from the project folder with: ${instruction}`;
}

/* -------------------------------- settings -------------------------------- */

export const PROJECT_SETTINGS_TITLE = "Project settings";
export const PROJECT_SETTINGS_SUBMIT = "Save";
export const PROJECT_SETTINGS_PENDING = "Saving";
/**
 * THE IDLE SENTENCE, and it is only true in the idle state.
 *
 * "Nothing has changed" is a claim about the SAVED values, and after a save the
 * form is re-seeded from them - so this sentence became true again the moment
 * the report of that save appeared, and printed a stale prompt above the
 * account of what Vex had just written (live test 2026-09-03, A4, shot 38).
 * `ProjectSettingsDialog` shows it only while nothing is edited AND no answer
 * to a Save stands on screen.
 */
export const PROJECT_SETTINGS_UNCHANGED =
  "Nothing has changed yet. Edit the permission, the wallets or the agents to save.";
export const PROJECT_SETTINGS_LOADING = "Loading this project";
export const PROJECT_SETTINGS_UNREADABLE =
  "Vex could not read this project. Close this dialog and try again.";
export const PROJECT_SETTINGS_GONE =
  "This project no longer exists. Close this dialog.";

export function projectFolderLine(displayPath: string): string {
  return `Folder: ${displayPath}`;
}

/**
 * The `projects.scope_conflict` copy, and it is DELIBERATELY not a retry.
 *
 * The expected scope version was consumed by the attempt, so pressing Save
 * again with the same intent would either be a second conflict or would re-
 * apply an edit composed against a project that no longer looks like that.
 * The only correct next step is a fresh read, which is what the button offers,
 * and the user re-makes their choices against what is actually stored.
 */
export const PROJECT_SCOPE_CONFLICT_TITLE = "This project changed while you were editing";
export const PROJECT_SCOPE_CONFLICT_BODY =
  "Someone or something else saved a change to this project's scope after this dialog was opened, so Vex wrote nothing. Reload the project and make your edits again against what is stored now.";
export const PROJECT_SCOPE_CONFLICT_RELOAD = "Reload the project";
/**
 * The reload is IN FLIGHT. Said on the button rather than by swapping the pane,
 * because the pane is still telling the truth: the save was refused and nothing
 * was written. What has changed is only that the fresh read has not landed yet,
 * and until it does there is no form to edit.
 */
export const PROJECT_SCOPE_CONFLICT_RELOADING = "Reloading";

/* --------------------------------- repair --------------------------------- */

export const PROJECT_REPAIR_TITLE = "Repair project files";
export const PROJECT_REPAIR_BODY =
  "Vex rewrites the files it maintains in this project's folder so they match the project's current scope. A file you edited since Vex wrote it will be OVERWRITTEN. Nothing else in the folder is touched.";
export const PROJECT_REPAIR_SUBMIT = "Repair";
export const PROJECT_REPAIR_PENDING = "Repairing";

/* --------------------------------- delete --------------------------------- */

export const PROJECT_DELETE_TITLE = "Delete project?";
export const PROJECT_DELETE_SUBMIT = "Delete";
export const PROJECT_DELETE_PENDING = "Deleting";
export const PROJECT_DELETE_RETRY = "Try again";

export function projectDeleteBody(projectName: string): string {
  return `Vex removes "${projectName}" and everything it stores about it. Your project FOLDER stays on disk unless you ask for it below.`;
}

export const PROJECT_DELETE_TRASH_LABEL = "Also move the project folder to the trash";
export const PROJECT_DELETE_TRASH_HELP =
  "The folder goes to your operating system's trash, where you can still recover it. Everything in it goes with it.";

/**
 * Why the folder choice stops being editable once the delete is durable.
 *
 * Main records the trash intent on the TOMBSTONE and a retry RESUMES that
 * recorded request, ignoring whatever the retry's own input carries
 * (`main/studio/project-delete.ts`, the `already_tombstoned` branch). A
 * checkbox that still moved after that point would let the user believe they
 * had spared or condemned their folder when nothing they did could change it,
 * which is the worst kind of lie a destructive dialog can tell.
 *
 * It says "as it was recorded" rather than "as you first asked it" because the
 * recorded request is not always this window's: main echoes the tombstone's own
 * intent, and when a second window created the tombstone the value shown here
 * is that window's choice. Claiming the user asked for it would be false in
 * exactly the case `PROJECT_DELETE_TRASH_ELSEWHERE_NOTE` exists to name.
 */
export const PROJECT_DELETE_TRASH_LOCKED_NOTE =
  "Vex recorded this choice when it deleted the project. Trying again resumes that same request with the folder choice exactly as it was recorded, so it can no longer be changed here.";

/**
 * The extra sentence for the case where the recorded choice is NOT the one this
 * dialog submitted.
 *
 * Main echoes the tombstone's intent on every outcome that resumes an
 * unfinished cleanup, and it can disagree with this dialog's checkbox: another
 * window deleted the same project first, or an earlier attempt from here
 * recorded a choice the box has since moved off. The locked note alone would
 * then read as though the user had made the shown choice, so this names the
 * real provenance instead of quietly swapping the value under them.
 */
export const PROJECT_DELETE_TRASH_ELSEWHERE_NOTE =
  "This delete was already in progress with the folder choice shown above, from another window or an earlier attempt, and that is the request Vex is finishing.";

/**
 * The line above the typed confirmation. It names the action as irreversible in
 * Vex, which is true whether or not the folder is trashed: the project row, its
 * scope and its backing session are gone either way.
 */
export function projectDeleteConfirmPrompt(projectName: string): string {
  return `Type the project name to confirm: ${projectName}`;
}

export const PROJECT_DELETE_CONFIRM_LABEL = "Project name";
export const PROJECT_DELETE_CONFIRM_MISMATCH =
  "That does not match the project name yet.";

export function projectDeleteTerminalsLine(count: number): string {
  return count === 1
    ? "1 running terminal in this project will be closed."
    : `${String(count)} running terminals in this project will be closed.`;
}

/**
 * What each delete outcome MEANS, and what the user does next.
 *
 * Seven members, seven sentences. `removed` and `already_removed` are the two
 * that end the dialog; the rest keep it open because the user still has a
 * decision or a retry in front of them.
 *
 * `not_found` is one of those five and its sentence has to carry the
 * UNCERTAINTY the wire member actually holds: main answers it both for a
 * project that is gone AND for one whose stored name no longer matches the one
 * this dialog sent, which is a concurrent rename of a project that still
 * exists. "Deleted" is therefore a claim this outcome cannot support.
 */
export const PROJECT_DELETE_OUTCOME_SENTENCES: Readonly<
  Record<ProjectDeleteResult["outcome"], string>
> = {
  removed: "The project was deleted.",
  already_removed: "This project was already deleted; there was nothing left to do.",
  cleanup_resumed:
    "An unfinished delete was found and Vex ran its cleanup again. What that pass did is listed below.",
  cleanup_pending:
    "The project is deleted and will not come back, but Vex could not finish cleaning up its files. Try again to resume; it will not delete anything a second time.",
  not_found:
    "Vex could not match this to a project it holds, so it deleted NOTHING. The row this dialog opened is either already gone or has been renamed since. The project list has been reloaded; check it before trying again.",
  blocked_active_calls:
    "Calls from this project were still running, so Vex wrote nothing and left the project exactly as it was. Stop them, or wait for them, then try again.",
  blocked_pending_dispatch:
    "An approved action for this project was already being dispatched, so Vex wrote nothing and left the project exactly as it was. Try again once it settles.",
};

export function projectDeleteActiveCallsLine(count: number): string {
  return count === 1
    ? "1 call was still running."
    : `${String(count)} calls were still running.`;
}

export function projectDeleteAttemptsLine(attempts: number): string {
  return attempts === 1
    ? "Vex has attempted this cleanup once."
    : `Vex has attempted this cleanup ${String(attempts)} times.`;
}

/**
 * What a retry of an unfinished cleanup actually does. Said beside the attempt
 * count because "try again" on a delete is the one place a user could
 * reasonably fear deleting something twice.
 */
export const PROJECT_DELETE_ATTEMPTS_NOTE =
  "Trying again resumes the same cleanup. It does not delete anything a second time.";

/** What happened to the user's FOLDER. `not_requested` says nothing on purpose. */
export const PROJECT_TRASH_SENTENCES: Readonly<
  Record<ProjectTrashOutcome, string>
> = {
  not_requested: "Your project folder was left on disk, as you asked.",
  trashed: "Your project folder was moved to the trash and can still be recovered from there.",
  failed:
    "Vex could not move your project folder to the trash, so it is still on disk. The project itself is still deleted. Move the folder yourself if you wanted it gone.",
};

export const PROJECT_DELETE_CLEANUP_TITLE = "What the cleanup did";

/* ---------------------------- render outcomes ----------------------------- */

/**
 * The run panel's heading, and it is DELIBERATELY not "Project files".
 *
 * Both panels are on screen together after a create - what the run DID, then
 * what the files ARE - and both used to be headed "Project files" over lists
 * whose rows carry the same artifact names. Two headings with one name over two
 * different vocabularies is the ambiguity `PROJECT_FILES_LIST_LABEL` already
 * fixed for the lists' accessible names; this fixes it for the visible ones.
 */
export const RENDER_OUTCOME_TITLE = "What Vex did";
export const RENDER_WARNINGS_TITLE = "Worth knowing";

type RenderTrigger = StudioRenderOutcome["trigger"];

/**
 * WHY THE RUN DID NOTHING, as the headline.
 *
 * A run failure is the first thing said about a run, above the trigger line and
 * above the rows, because everything else in the panel is a statement about
 * file work that did not happen. Both members used to arrive dressed as a
 * `launch_required` warning at the bottom of the panel, under a heading that
 * said Vex had reconciled the project's files.
 */
export const RUN_FAILURE_SENTENCES: Readonly<
  Record<StudioRunFailure["kind"], string>
> = {
  bridge_unavailable:
    "Vex could not find the bridge program its configs point at, so it wrote NO files for this project. A config naming a program that is not there is worse than no config. Reinstall or update Vex, then repair this project.",
  render_failed:
    "Vex could not write this project's files. Nothing else about this project changed. Repair it from the project menu to try again.",
};

/** The project could not be re-read after the change that was committed. */
export const PROJECT_REFRESH_FAILURE_SENTENCES: Readonly<
  Record<StudioProjectRefreshFailure["kind"], string>
> = {
  project_refresh_failed:
    "Your change is stored, but Vex could not read this project back afterwards, so what is shown below is how it looked when Vex saved it and may already be out of date. Reopen the project to see its current state.",
};

/**
 * The `trigger` line for a run that reconciled AT LEAST ONE artifact.
 *
 * `create` is not folded into `scope_update`: a project that has just been
 * created has no scope the user saved, and saying it does is the same class of
 * lie as the borrowed warning this table's sibling replaced.
 */
export const RENDER_TRIGGER_SENTENCES: Readonly<Record<RenderTrigger, string>> = {
  create: "Vex wrote this project's coding-agent files as part of creating it.",
  scope_update: "Vex reconciled this project's files against the scope you saved.",
  repair: "Vex rewrote the files it maintains in this project.",
  superseded:
    "A newer change to this project was already queued, so this run wrote nothing and the newer one owns the result.",
};

/**
 * The SAME triggers, for a run whose artifact list is EMPTY.
 *
 * "Vex rewrote the files it maintains in this project" over a report of zero
 * files is a claim about writes that did not happen. A run reconciles nothing
 * when the project selects no agent, and also when it could not start at all -
 * so these sentences state the absence and leave the reason to the run failure
 * beside them.
 */
export const RENDER_TRIGGER_EMPTY_SENTENCES: Readonly<
  Record<RenderTrigger, string>
> = {
  create: "Vex created this project and reconciled no files for it.",
  scope_update: "Vex saved your settings and reconciled no files for this project.",
  repair: "Vex reconciled no files in this project.",
  superseded:
    "A newer change to this project was already queued, so this run wrote nothing and the newer one owns the result.",
};

/** The trigger line, chosen by whether the run touched any artifact at all. */
export function renderTriggerSentence(render: StudioRenderOutcome): string {
  return render.artifacts.length === 0
    ? RENDER_TRIGGER_EMPTY_SENTENCES[render.trigger]
    : RENDER_TRIGGER_SENTENCES[render.trigger];
}

/**
 * WHAT A SCREEN READER IS TOLD when a render report arrives.
 *
 * One sentence, taken from the SAME constants the panel headlines with -
 * `RUN_FAILURE_SENTENCES` when the run never happened, the trigger line
 * otherwise - so the spoken summary and the printed one cannot drift into
 * disagreeing about what Vex did. The caller picks the severity: a run that
 * failed is announced as an error, a run that happened as info.
 */
export function renderReportAnnouncement(render: StudioRenderOutcome): string {
  return render.runFailure !== null
    ? RUN_FAILURE_SENTENCES[render.runFailure.kind]
    : renderTriggerSentence(render);
}

/**
 * What an EMPTY artifact list means, and it is not one thing.
 *
 * "Select a coding agent to get one" is true only when the run finished and
 * found nothing to do. On a run that did NOT complete, the same sentence blames
 * the user's agent selection for a list that is empty because the run stopped,
 * which sends them to fix a setting that was never the problem.
 */
export const RENDER_OUTCOME_EMPTY_COMPLETED =
  "Vex maintains no files for this project. Select a coding agent to get one.";
export const RENDER_OUTCOME_EMPTY_INCOMPLETE =
  "This run reconciled no files. That is a fact about the run, not about what this project needs, so it says nothing about your agent selection.";

export function renderOutcomeEmptySentence(render: StudioRenderOutcome): string {
  return render.completed
    ? RENDER_OUTCOME_EMPTY_COMPLETED
    : RENDER_OUTCOME_EMPTY_INCOMPLETE;
}

/**
 * The incomplete notice, per trigger, and `superseded` deliberately has NONE.
 *
 * Two things this table refuses to say. It does not tell someone who just ran
 * Repair to run Repair - that is the button they pressed, and repeating it
 * reads as though the dialog did not notice. And it does not describe a
 * superseded run as unfinished work the user owes: the newer run owns the
 * result, which the trigger line already says, so a second warning would invent
 * a chore that does not exist.
 *
 * `null` is a member of the value type rather than an absent key, so the record
 * stays exhaustive over the trigger enum and a new trigger is a compile error.
 */
export const RENDER_INCOMPLETE_NOTICES: Readonly<
  Record<RenderTrigger, string | null>
> = {
  create:
    "This run did not reach every file, so Vex still owes this project a reconciliation. Repair it from the project menu.",
  scope_update:
    "This run did not reach every file, so Vex still owes this project a reconciliation. Repair it from the project menu.",
  repair:
    "This repair did not reach every file, so Vex still owes this project a reconciliation. The rows below name what stopped it.",
  superseded: null,
};

/** Which artifact a row is about, in words rather than a wire enum. */
export const ARTIFACT_KIND_LABELS: Readonly<Record<StudioArtifactKind, string>> = {
  "agent-config": "Agent config",
  "agents-md": "AGENTS.md",
  "claude-md": "CLAUDE.md",
  "protocols-doc": "Vex tool reference",
};

/** The per-row verdict word. Short, because the row already carries the path. */
export const ARTIFACT_STATUS_LABELS: Readonly<
  Record<StudioArtifactOutcome["status"], string>
> = {
  written: "Written",
  unchanged: "Unchanged",
  removed: "Removed",
  refused: "Refused",
  drift_blocked: "Not overwritten",
  unsupported: "Not supported",
};

export function artifactChangeLabel(change: "created" | "updated"): string {
  return change === "created" ? "Created" : "Updated";
}

/**
 * WHAT THE USER STILL HAS TO DO IN THE CLIENT, once Vex has written the config.
 *
 * A written file is not a connected server. Claude Code asks about a project's
 * MCP server the first time it opens the folder, and that prompt DEFAULTS to
 * "Continue without using this MCP server" - so a user who presses Enter ends
 * up with every file correct and an agent that sees no Vex tools at all.
 * Measured on the built app (live test 2026-09-03, A-5): the report said what
 * Vex had written and never said this.
 *
 * `Partial` rather than an exhaustive record, and deliberately so: this is not
 * a wire enum every member of which owes a sentence, it is the short list of
 * clients with an out-of-band step. An agent with none prints nothing rather
 * than a filler line.
 */
export const AGENT_CLIENT_STEP_SENTENCES: Partial<Record<StudioAgentId, string>> = {
  "claude-code":
    "When Claude Code asks about this project's MCP server, choose Use this MCP server.",
};

/**
 * WHY a write was refused, one sentence per closed wire reason.
 *
 * Each one names a different situation with a different fix, which is the
 * property `studioRefusalReasonSchema` exists to preserve: collapsing them into
 * "could not write the file" would throw away the only part the user can act
 * on. The installer's own `detail` is rendered beside these, so this is the
 * category and that is the specific.
 */
export const REFUSAL_REASON_SENTENCES: Readonly<
  Record<StudioRefusalReason, string>
> = {
  malformed_json: "The existing file is not valid JSON, so Vex would have had to guess what to keep.",
  malformed_toml: "The existing file is not valid TOML, so Vex would have had to guess what to keep.",
  toml_multiline_string:
    "The existing TOML uses multi-line strings, which Vex cannot edit section by section without risking the rest of the file.",
  malformed_managed_block:
    "The Vex block in this file has a start marker without an end, or the reverse, so Vex cannot tell where its own content stops.",
  provenance_collision:
    "Something already sits at this path and Vex cannot prove it wrote it, so it left it alone.",
  unknown_keys_in_vex_entry:
    "Vex's own entry in this file grew keys Vex never writes, so something else has been editing it.",
  symlinked_path:
    "The path, or a folder on the way to it, is a symbolic link. Vex does not follow links out of a project.",
  not_a_regular_file: "Something that is not a regular file sits at this path.",
  too_large: "The existing file is larger than Vex will read.",
  invalid_utf8: "The existing file is not valid UTF-8 text.",
  ambiguous_twin:
    "Both a .json and a .jsonc version of this file exist and Vex cannot tell which one the agent reads.",
  source_changed: "The file changed on disk while Vex was writing it.",
  path_escape: "The resolved path led outside the project folder.",
  io_error: "The write itself failed. Check the folder's permissions and free space.",
  file_locked:
    "Another program is holding this file open, so Vex could not replace it. Close your editor, or whatever else has it open, then repair again.",
};

export const DRIFT_BLOCKED_SENTENCE =
  "This file was edited after Vex wrote it, so Vex left your edit in place. Repair the project to overwrite it with Vex's version.";

/** Something true about a written file that the write itself cannot fix. */
export const INSTALLER_WARNING_SENTENCES: Readonly<
  Record<StudioInstallerWarning["kind"], string>
> = {
  inert_until: "This config will do nothing until you pass a gate outside Vex.",
  launch_required: "This agent only reads the config when you launch it with a flag.",
  user_global_timeout:
    "This agent's only tool-call timeout lives in a file outside the project, so Vex cannot set it here.",
  foreign_authority_section:
    "This file also carries permission or allow rules that Vex did not write and does not manage.",
  timeout_unverified:
    "This agent documents no tool-call timeout, so a long Vex call may be cut short.",
};

/* --------------------------- files on disk (DTO) --------------------------- */

export const PROJECT_FILES_TITLE = "Project files";
export const PROJECT_FILES_EMPTY =
  "Vex maintains no files in this project yet. Select a coding agent to get one.";
export const PROJECT_FILES_NEVER_RENDERED =
  "Vex has not yet completed a full pass over this project's files. Repair it from the project menu to finish.";

/**
 * The ACTION beside the sentences that ask for a repair.
 *
 * The banner above and the per-row sentences for `missing`, `stale`, `drifted`
 * and `unreadable` all end by telling the user to repair the project, and until
 * now the panel offered no way to do it: the instruction pointed at a menu in
 * another column, behind the dialog the sentence was printed in.
 */
export const PROJECT_FILES_REPAIR_ACTION = "Repair this project";

/** The per-row verdict word for what a file IS, not what a run did to it. */
export const ARTIFACT_STATE_LABELS: Readonly<
  Record<StudioArtifactStatus["state"], string>
> = {
  current: "Current",
  drifted: "Edited",
  missing: "Missing",
  stale: "Out of date",
  unsupported: "Not supported",
  unreadable: "Unreadable",
};

/** One sentence per state, saying what it means and what fixes it. */
export const ARTIFACT_STATE_SENTENCES: Readonly<
  Record<StudioArtifactStatus["state"], string>
> = {
  current: "On disk and identical to what Vex would write now.",
  drifted:
    "On disk but edited since Vex wrote it. Repairing this project overwrites your edit.",
  missing:
    "This project asks for this file and it is not on disk. Repair this project to write it.",
  stale:
    "On disk and unedited, but older than this project's current scope. Repair this project to bring it up to date.",
  unsupported: "Vex writes no file for this agent, by design.",
  unreadable: "Vex could not inspect this file on disk.",
};

/**
 * Which states read in the warning register.
 *
 * `unsupported` is deliberately NOT one of them, matching
 * `sidebar/project-row-model.ts`: an agent with no artifact by design is not a
 * problem, and badging it would train the user to ignore the badge that is.
 */
export const ARTIFACT_STATE_WANTS_ATTENTION: Readonly<
  Record<StudioArtifactStatus["state"], boolean>
> = {
  current: false,
  drifted: true,
  missing: true,
  stale: true,
  unsupported: false,
  unreadable: true,
};

/* --------------------------------- toasts --------------------------------- */

export function projectDeletedToast(projectName: string): string {
  return `Deleted "${projectName}".`;
}

export function projectCreatedToast(projectName: string): string {
  return `Created "${projectName}".`;
}

/* ---------------------------- accessible names ---------------------------- */

export const PROJECT_OUTCOME_LIST_LABEL = "What Vex did to each file";
/**
 * The status list's OWN name. The two lists are shown together after a create -
 * what the run did, then what the files are - and two lists carrying one
 * accessible name would leave a screen-reader user with no way to tell which
 * one they had landed in.
 */
export const PROJECT_FILES_LIST_LABEL = "What each file is right now";
export const PROJECT_WARNING_LIST_LABEL = "Things worth knowing about these files";
export const PROJECT_AGENT_LIST_LABEL = "Coding agents for this project";
