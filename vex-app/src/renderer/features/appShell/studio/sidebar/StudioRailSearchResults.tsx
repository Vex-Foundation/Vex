/**
 * ONE result list for the rail's ONE search: projects above, loaded files
 * below.
 *
 * The shape is deepseek's workspace-browser search (`WorkspaceBrowser.tsx`):
 * the browsing region is REPLACED by results while a query is live, the rows
 * are grouped by the kind of thing they are, and the list says what it could
 * not show instead of ending silently.
 *
 * ## Keyboard
 *
 * A combobox, not a roving tabindex: the field keeps DOM focus and names the
 * active row with `aria-activedescendant`, so a keystroke that re-derives the
 * whole list cannot drop the user's focus onto `body`. Rows are therefore
 * `role="option"` elements rather than buttons - they are never focused - and a
 * pointer click activates the same handler Enter does.
 *
 * ## The two bound lines are not decoration
 *
 * "Showing 20 of 57" and the file-scope note are the honest edges of this
 * answer: the group limit, and the fact that only opened folders were searched.
 * Neither is a silent cut; both name what is missing and how to reach it.
 */

import type { JSX } from "react";
import type { FileNode } from "@shared/schemas/files.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { IconFile, IconFolderClose } from "../../../../components/icons/index.js";
import { SEARCH_INDEX_AGE_NOTICE_MS } from "@shared/schemas/studio-search.js";
import {
  STUDIO_SEARCH_EMPTY,
  STUDIO_SEARCH_FILE_SCOPE_NOTE,
  STUDIO_SEARCH_GROUP_FILES,
  STUDIO_SEARCH_GROUP_PROJECTS,
  STUDIO_SEARCH_INDEX_BUILDING,
  STUDIO_SEARCH_RANKING_TRUNCATED,
  STUDIO_SEARCH_RESULTS_LABEL,
  studioSearchIndexCappedLine,
  studioSearchIndexedAgeLine,
  studioSearchScanTruncatedLine,
  studioSearchShowingLine,
} from "../studio-copy.js";
import {
  RAIL_SEARCH_GROUP_LIMIT,
  RAIL_SEARCH_SCAN_MAX,
  railSearchHitCount,
  type RailSearchResults,
} from "./rail-search-model.js";

export interface StudioRailSearchResultsProps {
  readonly results: RailSearchResults;
  /** The `role="listbox"` id the field's `aria-controls` points at. */
  readonly listboxId: string;
  /** Index into projects-then-files, or -1 while nothing is active. */
  readonly activeIndex: number;
  /** Stable DOM id per hit index; the field echoes it as activedescendant. */
  readonly optionId: (index: number) => string;
  readonly onOpenProject: (projectId: string) => void;
  readonly onOpenFile: (node: FileNode) => void;
  /** True while a project is open, so the file scope note is meaningful. */
  readonly fileSearchAvailable: boolean;
  /**
   * The clock, for the index's age line only.
   *
   * Injected rather than read inside the render so the age is a deterministic
   * function of the props in tests. Production leaves it out.
   */
  readonly nowMs?: number;
}

export function StudioRailSearchResults({
  results,
  listboxId,
  activeIndex,
  optionId,
  onOpenProject,
  onOpenFile,
  fileSearchAvailable,
  nowMs,
}: StudioRailSearchResultsProps): JSX.Element {
  const hits = railSearchHitCount(results);
  const projectOffset = 0;
  const fileOffset = results.projects.length;
  const building = results.indexState === "building";
  // The index is a SNAPSHOT and it says how old it is once that starts to
  // matter. Below the notice window a date would be noise; above it, a user who
  // just created a file needs the reason it is missing and the remedy.
  const indexAgeMs =
    results.indexedAtMs === null ? null : (nowMs ?? Date.now()) - results.indexedAtMs;
  const showAge = indexAgeMs !== null && indexAgeMs >= SEARCH_INDEX_AGE_NOTICE_MS;

  return (
    <div className="vex-scroll vex-scroll-overlay min-h-0 flex-1 overflow-y-auto overflow-x-clip px-2 py-3">
      {hits === 0 ? (
        // "Nothing matched" is only honest once the index has answered. While
        // the walk is running the file half has not been consulted at all, and
        // saying there are no matches would be a claim nothing supports.
        <p role="status" className="px-2 py-3 text-[12px] leading-[18px] text-ink-secondary">
          {building ? STUDIO_SEARCH_INDEX_BUILDING : STUDIO_SEARCH_EMPTY}
        </p>
      ) : (
        <div id={listboxId} role="listbox" aria-label={STUDIO_SEARCH_RESULTS_LABEL}>
          {results.projects.length === 0 ? null : (
            <div role="group" aria-label={STUDIO_SEARCH_GROUP_PROJECTS}>
              <GroupHeading title={STUDIO_SEARCH_GROUP_PROJECTS} />
              {results.projects.map((project, index) => (
                <ResultOption
                  key={project.id}
                  id={optionId(projectOffset + index)}
                  active={activeIndex === projectOffset + index}
                  title={project.name}
                  detail={project.displayPath}
                  glyph={<IconFolderClose size={13} />}
                  onActivate={() => onOpenProject(project.id)}
                />
              ))}
            </div>
          )}
          {results.files.length === 0 ? null : (
            <div role="group" aria-label={STUDIO_SEARCH_GROUP_FILES}>
              <GroupHeading title={STUDIO_SEARCH_GROUP_FILES} />
              {results.files.map((node, index) => (
                <ResultOption
                  key={node.nodeId}
                  id={optionId(fileOffset + index)}
                  active={activeIndex === fileOffset + index}
                  title={node.name}
                  detail={node.path}
                  glyph={<IconFile size={13} />}
                  onActivate={() => onOpenFile(node)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1 px-2">
        {results.projectMatchCount > RAIL_SEARCH_GROUP_LIMIT ? (
          <p className="text-[11px] leading-[16px] text-ink-tertiary">
            {`${STUDIO_SEARCH_GROUP_PROJECTS}: ${studioSearchShowingLine(
              results.projects.length,
              results.projectMatchCount,
            )}`}
          </p>
        ) : null}
        {results.fileMatchCount > RAIL_SEARCH_GROUP_LIMIT ? (
          <p className="text-[11px] leading-[16px] text-ink-tertiary">
            {`${STUDIO_SEARCH_GROUP_FILES}: ${studioSearchShowingLine(
              results.files.length,
              results.fileMatchCount,
            )}`}
          </p>
        ) : null}
        {/* The WALK's own bound, and it outranks the group lines above: those
          * say which matches were not listed, this says which files were never
          * examined, so a match may be missing from the answer altogether.
          * Only reachable before the index answers - after that the loaded
          * reader is no longer what bounds the answer. */}
        {results.scanTruncated ? (
          <p role="status" className="text-[11px] leading-[16px] text-warning">
            {studioSearchScanTruncatedLine(RAIL_SEARCH_SCAN_MAX)}
          </p>
        ) : null}
        {/* THE INDEX'S OWN CAP, and the worst of the bounds on this list: a
          * name that was never collected cannot be found, so an empty result
          * is not evidence the file is absent. */}
        {results.indexState === "capped" ? (
          <p role="status" className="text-[11px] leading-[16px] text-warning">
            {studioSearchIndexCappedLine(results.indexedFileCount)}
          </p>
        ) : null}
        {results.indexTruncated ? (
          <p role="status" className="text-[11px] leading-[16px] text-warning">
            {STUDIO_SEARCH_RANKING_TRUNCATED}
          </p>
        ) : null}
        {building && hits > 0 ? (
          <p role="status" className="text-[11px] leading-[16px] text-ink-tertiary">
            {STUDIO_SEARCH_INDEX_BUILDING}
          </p>
        ) : null}
        {showAge && indexAgeMs !== null ? (
          <p className="text-[11px] leading-[16px] text-ink-tertiary">
            {studioSearchIndexedAgeLine(results.indexedFileCount, indexAgeMs)}
          </p>
        ) : null}
        {fileSearchAvailable ? (
          <p className="text-[11px] leading-[16px] text-ink-tertiary">
            {STUDIO_SEARCH_FILE_SCOPE_NOTE}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A group's visible eyebrow.
 *
 * `aria-hidden` deliberately: the group already carries the same word as its
 * `aria-label`, so exposing the heading too would name every group twice, and a
 * listbox whose groups contain non-option children is not the structure the
 * pattern promises.
 */
function GroupHeading({ title }: { readonly title: string }): JSX.Element {
  return (
    <div aria-hidden="true" className="mb-1 flex h-6 items-center px-2">
      <span className="vex-eyebrow">{title}</span>
    </div>
  );
}

/**
 * One result row.
 *
 * A `div` with `role="option"`, never a button: options in a combobox listbox
 * are not tab stops, and a focusable control inside one would put a second
 * keyboard model on a list the field already drives.
 */
function ResultOption({
  id,
  active,
  title,
  detail,
  glyph,
  onActivate,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly title: string;
  readonly detail: string;
  readonly glyph: JSX.Element;
  readonly onActivate: () => void;
}): JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onClick={onActivate}
      className={[
        "flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2",
        active ? "bg-interactive-hover" : "hover:bg-interactive-hover",
      ].join(" ")}
    >
      <span aria-hidden="true" className="shrink-0 text-ink-tertiary">
        {glyph}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-[20px] text-ink-primary">
        {title}
      </span>
      <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[11px] leading-[16px] text-ink-tertiary">
        {detail}
      </span>
    </div>
  );
}
