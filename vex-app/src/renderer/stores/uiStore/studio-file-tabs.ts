/**
 * THE OPEN FILE TABS' OWN PERSISTED HOME, per Studio project.
 *
 * ## Why it is here and not in the terminal snapshot
 *
 * The terminal snapshot is the pty host's file and its schema describes
 * terminals; `workspace-model.ts`'s `toPersistedLayout` says so in its own note
 * and deliberately writes no file tab. Worse, the restore channel answers NULL
 * for a project with no live terminal, so a file-only workspace could never
 * come back through it at all. VS Code keeps the same two things apart for the
 * same reason: `EditorPart.saveState` writes the editor state into workbench
 * storage (`browser/parts/editor/editorPart.ts:1475`, a `Memento` scoped to the
 * workspace) while the terminal layout is the terminal service's, so a
 * corrupt terminal snapshot cannot cost you your editors.
 *
 * So file tabs get a home of their own, in the renderer's `vex-ui` payload,
 * beside the last Studio location that already lives there (v17). Cosmetic,
 * user-scoped, and it never crosses IPC.
 *
 * ## Everything here is untrusted input
 *
 * `vex-ui` is user-writable localStorage. `migrate` only runs on a version hop,
 * so a hand-edited current-version payload reaches {@link coerceStudioFileTabs}
 * directly, and that function is written as though every payload were hostile.
 * What survives it is a BOUNDED, plain-string path and nothing else - and a
 * surviving path still names nothing: `workspace/resolve-path-token.ts` makes
 * main list every one of its segments and mint the token before a tab exists,
 * so an injected path can only ever name a file main's own walk confirms inside
 * the project. That is the two-stage shape `activeProjectId` already uses
 * (coerce, then confirm against the authority) rather than a new one.
 *
 * ## The bounds, and what happens at each
 *
 *  - {@link STUDIO_FILE_TABS_MAX} tabs per project, the same bound the live
 *    strip enforces, imported from the workspace's own runtime-free vocabulary
 *    rather than restated here: two numbers for one quantity is how a persisted
 *    record starts describing a strip that cannot hold it.
 *  - {@link STUDIO_FILE_TAB_PROJECTS_MAX} projects, evicted LEAST RECENTLY
 *    SAVED first. A project past the LRU FORGETS ITS TABS - stated, because it
 *    is a real product behaviour and not a failure: the twenty-first project
 *    you touch pushes out the one you have not opened in longest, and it
 *    reopens with its terminals and an empty file strip.
 *  - {@link STUDIO_FILE_TAB_PATH_MAX} characters per path, matching the files
 *    schema's own relative-path bound at the process boundary.
 *
 * A project whose file strip is EMPTY holds no record at all rather than an
 * empty one: an empty record would spend an LRU slot to say nothing.
 */

import { STUDIO_FILE_TABS_MAX } from "../../features/appShell/studio/workspace/types.js";

/**
 * Projects that keep their file tabs. Twenty is well past the number of
 * projects a person moves between in a session and small enough that the whole
 * record stays a few kilobytes of a localStorage payload.
 */
export const STUDIO_FILE_TAB_PROJECTS_MAX = 20;

/**
 * Characters a persisted path may hold - `FILES_RELATIVE_PATH_MAX`, the bound
 * main's own schema applies to the same string. Restated as a local constant
 * only because the store must not import the IPC schema module; the number is
 * pinned against the schema by this module's suite.
 */
export const STUDIO_FILE_TAB_PATH_MAX = 4_096;

/** Bounded exactly as every project id is bounded at the process boundary. */
const PROJECT_ID_MAX = 64;

/** One persisted file tab. */
export interface PersistedFileTab {
  /** Project-root-relative, POSIX. Re-resolved through main before it is a tab. */
  readonly relativePath: string;
  /**
   * Whether the tab was a KEPT one rather than the strip's throwaway preview
   * slot.
   *
   * The writer records `true` for a preview tab: a tab that survives a restart
   * is a tab the user kept, so the PROMOTION happens at the write, which is the
   * moment that knows the session is ending. The reader honours whatever the
   * record says, because a hand-edited payload may say anything, and the
   * model's "at most one preview" invariant is enforced by
   * {@link coerceStudioFileTabs} before the workspace ever sees it.
   */
  readonly pinned: boolean;
  /** The tab's index in the WHOLE strip, terminals included, when it was saved. */
  readonly position: number;
  /** Whether this tab was the selected one. At most one per project. */
  readonly active: boolean;
}

/** One project's strip, and when it was written. */
export interface PersistedProjectFileTabs {
  readonly tabs: readonly PersistedFileTab[];
  /** Epoch ms. The LRU's key, and the only reason it is stored. */
  readonly savedAtMs: number;
}

export type StudioFileTabsByProject = Readonly<
  Record<string, PersistedProjectFileTabs>
>;

/**
 * Is this a project-relative path a walk may be asked to resolve?
 *
 * Rejected, by name, with the reason each one is a real attack rather than a
 * typo:
 *
 *  - an ABSOLUTE path (`/etc/passwd`, `C:\...`) is not a project path at all;
 *  - a `..` SEGMENT is the escape, and it is rejected as a segment rather than
 *    as a substring so `..hidden` and `a..b` stay legal names;
 *  - an EMPTY segment (`a//b`, a leading or trailing `/`) is not a name, and a
 *    walk asked for one would ask main for a child called "";
 *  - a BACKSLASH, because the wire's paths are POSIX and a separator this
 *    module does not split on would travel through the walk as part of a name;
 *  - a NUL or control character, which no entry name main mints can contain.
 *
 * This is belt and braces over main's own validation, deliberately: the cheap
 * check here means a hostile payload never reaches the bridge at all, and
 * main's check is what makes the guarantee.
 */
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > STUDIO_FILE_TAB_PATH_MAX) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  // A Windows drive prefix (`C:/...`) is absolute too, and does not start `/`.
  if (/^[A-Za-z]:/.test(value)) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "..");
}

function coerceProjectTabs(value: unknown): PersistedProjectFileTabs | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawTabs = record["tabs"];
  if (!Array.isArray(rawTabs)) return null;
  // The BOUND is applied by refusing the whole record rather than by taking the
  // first sixteen: a payload naming forty tabs is not a strip this build wrote,
  // and silently keeping a slice of it would restore a workspace nobody had.
  if (rawTabs.length === 0 || rawTabs.length > STUDIO_FILE_TABS_MAX) return null;
  const savedAtMs = record["savedAtMs"];
  if (typeof savedAtMs !== "number" || !Number.isFinite(savedAtMs) || savedAtMs < 0) {
    return null;
  }

  const tabs: PersistedFileTab[] = [];
  const seenPaths = new Set<string>();
  let activeTaken = false;
  let previewTaken = false;
  for (const entry of rawTabs) {
    if (entry === null || typeof entry !== "object") return null;
    const tab = entry as Record<string, unknown>;
    const relativePath = tab["relativePath"];
    if (!isSafeRelativePath(relativePath)) return null;
    // A DUPLICATE PATH is refused rather than deduped: `addFileTab` treats the
    // path as the tab's identity, so a record naming one file twice describes a
    // strip the model cannot produce.
    if (seenPaths.has(relativePath)) return null;
    seenPaths.add(relativePath);
    const position = tab["position"];
    if (
      typeof position !== "number"
      || !Number.isInteger(position)
      || position < 0
      // A position past what any strip can hold is meaningless. The restore
      // clamps anyway; refusing here keeps the record describable.
      || position > STUDIO_FILE_TABS_MAX + 16
    ) {
      return null;
    }
    const pinnedValue = tab["pinned"];
    const activeValue = tab["active"];
    if (typeof pinnedValue !== "boolean" || typeof activeValue !== "boolean") {
      return null;
    }
    // AT MOST ONE of each, because both are invariants of the strip this record
    // describes: one selection, and one throwaway preview slot. A second is
    // coerced to false rather than refusing the record - the strip that comes
    // back is still exactly the user's files, which is what the record is for.
    const active = activeValue && !activeTaken;
    if (active) activeTaken = true;
    const pinned = pinnedValue || previewTaken;
    if (!pinned) previewTaken = true;
    tabs.push({ relativePath, pinned, position, active });
  }
  return { tabs, savedAtMs };
}

/**
 * Coerce the whole per-project record on every rehydrate.
 *
 * Anything off-shape degrades to `{}` - no remembered tabs, which is exactly
 * what a fresh install has - and a single bad project degrades to that project
 * having none, never to the others losing theirs.
 */
export function coerceStudioFileTabs(value: unknown): StudioFileTabsByProject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  // The LRU bound applied to the payload as READ, before anything walks it: a
  // hand-written record naming ten thousand projects must not become ten
  // thousand entries this store then carries for the life of the window.
  const entries: Array<[string, PersistedProjectFileTabs]> = [];
  for (const projectId of keys) {
    if (projectId.length === 0 || projectId.length > PROJECT_ID_MAX) continue;
    const coerced = coerceProjectTabs(source[projectId]);
    if (coerced === null) continue;
    entries.push([projectId, coerced]);
  }
  return Object.fromEntries(evictToBound(entries));
}

/**
 * Keep the {@link STUDIO_FILE_TAB_PROJECTS_MAX} most recently saved projects.
 *
 * Sorted by `savedAtMs` DESCENDING and cut, so the projects that go are the
 * ones untouched longest. Ties keep insertion order, which is the only stable
 * answer available when two records claim the same millisecond.
 */
function evictToBound(
  entries: readonly (readonly [string, PersistedProjectFileTabs])[],
): Array<[string, PersistedProjectFileTabs]> {
  if (entries.length <= STUDIO_FILE_TAB_PROJECTS_MAX) {
    return entries.map(([id, value]) => [id, value]);
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      b.entry[1].savedAtMs - a.entry[1].savedAtMs || a.index - b.index,
    )
    .slice(0, STUDIO_FILE_TAB_PROJECTS_MAX)
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => [entry[0], entry[1]]);
}

/**
 * Write one project's strip into the record, enforcing both bounds.
 *
 * An EMPTY list REMOVES the project's entry: a project with nothing open has
 * nothing to remember, and keeping a record to say so would spend an LRU slot
 * that another project's tabs could use.
 *
 * A list longer than the per-project bound is truncated to the first
 * {@link STUDIO_FILE_TABS_MAX} entries, which cannot happen from the live strip
 * (the model refuses the seventeenth tab) and is here so this function's
 * contract holds for every caller rather than for the one that exists.
 */
export function putProjectFileTabs(
  current: StudioFileTabsByProject,
  projectId: string,
  tabs: readonly PersistedFileTab[],
  savedAtMs: number,
): StudioFileTabsByProject {
  const { [projectId]: _previous, ...rest } = current;
  if (tabs.length === 0) return rest;
  const entries: Array<[string, PersistedProjectFileTabs]> = [
    ...Object.entries(rest),
    [projectId, { tabs: tabs.slice(0, STUDIO_FILE_TABS_MAX), savedAtMs }],
  ];
  return Object.fromEntries(evictToBound(entries));
}

/** Forget one project's tabs entirely. The delete path's call. */
export function forgetProjectFileTabs(
  current: StudioFileTabsByProject,
  projectId: string,
): StudioFileTabsByProject {
  if (!(projectId in current)) return current;
  const { [projectId]: _dropped, ...rest } = current;
  return rest;
}
