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
import { IconChevronUp, IconRefresh } from "../../../../components/icons/index.js";
import { Tooltip } from "../../../../components/ui/tooltip.js";
import { cn } from "../../../../lib/utils.js";
import {
  EXPLORER_COLLAPSE_ALL_LABEL,
  EXPLORER_COLLAPSE_ALL_TOOLTIP,
  EXPLORER_REFRESH_LABEL,
  EXPLORER_REFRESH_TOOLTIP,
  EXPLORER_SECTION_LABEL,
} from "./explorer-copy.js";

export interface ExplorerHeaderProps {
  readonly onRefresh: () => void;
  readonly onCollapseAll: () => void;
  readonly className?: string;
}

export function ExplorerHeader({
  onRefresh,
  onCollapseAll,
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
        {EXPLORER_SECTION_LABEL}
      </span>
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
