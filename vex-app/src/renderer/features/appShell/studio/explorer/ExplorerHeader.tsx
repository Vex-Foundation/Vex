/**
 * The explorer's section header: a label and two manual actions.
 *
 * Both actions exist in VS Code's explorer too, but here they carry weight the
 * originals do not. A watcher can end up `unavailable` - a spent OS watch
 * limit, an exhausted restart budget - and that state is DURABLE for the life
 * of that watcher. When it holds, Refresh is not a convenience: it is the only
 * way the user can see their current files. The root notice says so in words
 * and this button is what it points at.
 *
 * The header is a SIBLING of the tree, never inside it: a `role="tree"` may
 * only contain tree items, so a button in there would put a control in the
 * arrow-key sequence a screen reader walks.
 *
 * R3 (docs/design/R3-MINIMAL.md section 4, "Studio"): one line in the left
 * sidebar's group head register, "Explorer · {project}" in 12 / 500 muted,
 * with the keys at the right as 14px line icons in ink 2 on 24 x 24 targets.
 */

import type { JSX } from "react";
import {
  LineChevronUp,
  LineFile,
  LineFolder,
  LineRefresh,
} from "../../../../components/icons/line/index.js";
import { Tooltip } from "../../../../components/ui/tooltip.js";
import { cn } from "../../../../lib/utils.js";
import {
  EXPLORER_COLLAPSE_ALL_LABEL,
  EXPLORER_COLLAPSE_ALL_TOOLTIP,
  EXPLORER_NEW_FILE_LABEL,
  EXPLORER_NEW_FILE_TOOLTIP,
  EXPLORER_NEW_FOLDER_LABEL,
  EXPLORER_NEW_FOLDER_TOOLTIP,
  EXPLORER_REFRESH_LABEL,
  EXPLORER_REFRESH_TOOLTIP,
  EXPLORER_SECTION_LABEL,
} from "./explorer-copy.js";

export interface ExplorerHeaderProps {
  readonly onRefresh: () => void;
  readonly onCollapseAll: () => void;
  /**
   * Create WHERE THE TREE'S SELECTION POINTS: inside the selected folder,
   * beside the selected file, and at the project root only when nothing is
   * selected. The caller resolves that target - this header holds no tree
   * state - and VS Code's view-title command resolves the same one
   * (`fileActions.ts:931-938`).
   *
   * Optional, and omitted rather than disabled where a mount has no write
   * path: a button that is always there and never works is worse than no
   * button, and the row menu offers the same two actions scoped to a folder.
   *
   * VS Code puts the same two actions in the same place
   * (`explorer.newFile`/`explorer.newFolder` as view-title actions), and they
   * are FIRST here for the same reason they are there: they are the two things
   * a user comes to an empty explorer to do.
   */
  readonly onCreateFile?: () => void;
  readonly onCreateFolder?: () => void;
  /**
   * What this pane is showing. Defaults to the generic section label; the
   * Studio sidebar passes the ROOT PROJECT'S NAME, which is what VS Code's own
   * explorer view pane titles itself with (`explorerView.ts:250`) - the
   * enclosing section already says the word "Explorer", and a pane that
   * repeated it would name itself twice and name the folder never.
   */
  readonly title?: string;
  /**
   * The section word the title follows ("Explorer"), drawn before it with a
   * middle dot. Omitted, the header names the pane alone.
   */
  readonly section?: string;
  readonly className?: string;
}

export function ExplorerHeader({
  onRefresh,
  onCollapseAll,
  onCreateFile,
  onCreateFolder,
  title,
  section,
  className,
}: ExplorerHeaderProps): JSX.Element {
  return (
    <div className={cn("vex-st-xhead", className)}>
      <h2 className="vex-st-xhead__t">
        {section === undefined ? null : (
          <>
            <span className="vex-st-xhead__section">{section}</span>
            <span aria-hidden="true"> · </span>
          </>
        )}
        <span>{title ?? EXPLORER_SECTION_LABEL}</span>
      </h2>
      {onCreateFile === undefined ? null : (
        <Tooltip label={EXPLORER_NEW_FILE_TOOLTIP} side="bottom">
          <button
            type="button"
            aria-label={EXPLORER_NEW_FILE_LABEL}
            onClick={onCreateFile}
            className="vex-st-xkey"
          >
            <LineFile size={14} />
          </button>
        </Tooltip>
      )}
      {onCreateFolder === undefined ? null : (
        <Tooltip label={EXPLORER_NEW_FOLDER_TOOLTIP} side="bottom">
          <button
            type="button"
            aria-label={EXPLORER_NEW_FOLDER_LABEL}
            onClick={onCreateFolder}
            className="vex-st-xkey"
          >
            <LineFolder size={14} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={EXPLORER_REFRESH_TOOLTIP} side="bottom">
        <button
          type="button"
          aria-label={EXPLORER_REFRESH_LABEL}
          onClick={onRefresh}
          className="vex-st-xkey"
        >
          <LineRefresh size={14} />
        </button>
      </Tooltip>
      <Tooltip label={EXPLORER_COLLAPSE_ALL_TOOLTIP} side="bottom">
        <button
          type="button"
          aria-label={EXPLORER_COLLAPSE_ALL_LABEL}
          onClick={onCollapseAll}
          className="vex-st-xkey"
        >
          <LineChevronUp size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
