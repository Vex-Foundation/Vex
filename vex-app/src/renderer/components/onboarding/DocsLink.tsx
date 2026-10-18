/**
 * External documentation link primitive. Renders the link with the line
 * "external" glyph and routes through the renderer's default
 * `<a target="_blank">` flow, which the main process picks up via the
 * `shell.openExternal` allowlist (no in-renderer navigation).
 *
 * `rel="noopener noreferrer"` mandatory - even on Electron, leaving
 * `opener` open against a freshly-launched browser tab is bad hygiene.
 *
 * Type: the blue link of the first run (13.5 / 500, `docs/design/R3-MINIMAL.md` section 10.3).
 * Its colour is the blue token (the periwinkle at night); the focus ring is the
 * 2px outline of the focus blue, 3px clear, as on every key.
 */

import type { JSX } from "react";

import { LineExternal } from "../icons/line/index.js";

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
      className="vex-fr-link inline-flex items-center gap-1.5 self-start"
    >
      {label}
      <LineExternal size={14} />
    </a>
  );
}
