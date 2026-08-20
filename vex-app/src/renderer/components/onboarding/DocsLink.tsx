/**
 * External documentation link primitive. Renders the link with an
 * arrow-up-right glyph and routes through the renderer's default
 * `<a target="_blank">` flow, which the main process picks up via the
 * `shell.openExternal` allowlist (no in-renderer navigation).
 *
 * `rel="noopener noreferrer"` mandatory — even on Electron, leaving
 * `opener` open against a freshly-launched browser tab is bad hygiene.
 */

import { IconArrowUpRight } from "../icons/index.js";

interface DocsLinkProps {
  readonly href: string;
  readonly label: string;
}

export function DocsLink({ href, label }: DocsLinkProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Token-driven: the label reads `--vex-accent-text` (the accent's
      // lighter mix) because accent AS TEXT needs it - raw accent falls
      // short of contrast on the plate. The focus ring is a solid mark and
      // keeps --color-ring.
      className="inline-flex items-center gap-1 self-start text-xs text-[var(--vex-accent-text,var(--color-accent-hover))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
    >
      {label}
      <IconArrowUpRight size={12} />
    </a>
  );
}
