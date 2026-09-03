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
 */

import type { JSX } from "react";
import {
  IconChevronUp,
  IconFolderClose,
  IconPlus,
  IconRefresh,
} from "../../../../components/icons/index.js";
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
   * Create at the PROJECT ROOT. Optional, and omitted rather than disabled
   * where a mount has no write path: a button that is always there and never
   * works is worse than no button, and the row menu offers the same two
   * actions scoped to a folder.
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
  readonly className?: string;
}

export function ExplorerHeader({
  onRefresh,
  onCollapseAll,
  onCreateFile,
  onCreateFolder,
  title,
  className,
}: ExplorerHeaderProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 border-b border-line-3 bg-surface-sidebar px-2",
        className,
      )}
    >
      <span className="flex-1 truncate text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">
        {title ?? EXPLORER_SECTION_LABEL}
      </span>
      {onCreateFile === undefined ? null : (
        <Tooltip label={EXPLORER_NEW_FILE_TOOLTIP} side="bottom">
          <button
            type="button"
            aria-label={EXPLORER_NEW_FILE_LABEL}
            onClick={onCreateFile}
            className="rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <IconPlus size={12} />
          </button>
        </Tooltip>
      )}
      {onCreateFolder === undefined ? null : (
        <Tooltip label={EXPLORER_NEW_FOLDER_TOOLTIP} side="bottom">
          <button
            type="button"
            aria-label={EXPLORER_NEW_FOLDER_LABEL}
            onClick={onCreateFolder}
            className="rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <IconFolderClose size={12} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={EXPLORER_REFRESH_TOOLTIP} side="bottom">
        <button
          type="button"
          aria-label={EXPLORER_REFRESH_LABEL}
          onClick={onRefresh}
          className="rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <IconRefresh size={12} />
        </button>
      </Tooltip>
      <Tooltip label={EXPLORER_COLLAPSE_ALL_TOOLTIP} side="bottom">
        <button
          type="button"
          aria-label={EXPLORER_COLLAPSE_ALL_LABEL}
          onClick={onCollapseAll}
          className="rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <IconChevronUp size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
