/**
 * What an open file tab shows until stage B3c puts a viewer here.
 *
 * IT LIVES IN `studio/viewer/` rather than beside the terminal on purpose: this
 * directory is the one B3c replaces, and a file panel owned by the terminal
 * folder would leave the viewer arriving as an edit to a terminal module.
 *
 * The content is the PATH and nothing else. A placeholder that said "viewer
 * coming soon" would be a roadmap note shipped as product copy, and it would
 * tell the person looking at it less than the path already does.
 */

import type { JSX } from "react";
import { cn } from "../../../../lib/utils.js";

export interface FileTabPlaceholderProps {
  /** Project-root-relative, exactly as the tab holds it. */
  readonly relativePath: string;
  readonly className?: string;
}

export function FileTabPlaceholder({
  relativePath,
  className,
}: FileTabPlaceholderProps): JSX.Element {
  return (
    <div
      data-testid="file-tab-placeholder"
      className={cn(
        "flex h-full items-center justify-center bg-surface-base px-4 text-center",
        className,
      )}
    >
      <span className="max-w-full truncate font-mono text-[12px] leading-5 text-ink-tertiary">
        {relativePath}
      </span>
    </div>
  );
}
