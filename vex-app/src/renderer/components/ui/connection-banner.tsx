/**
 * ConnectionBanner: the band that surfaces connection loss
 * (docs/design/R3-MINIMAL.md sections 6 and 12). Under the title bar, 40
 * high, the paper 2 step with an ink rule below: the concerned fill (ink
 * hatch) and the word, and an optional muted figure at the right ("Last
 * online 12:31"). Purely presentational - the owner subscribes to connection
 * state and passes `reconnecting` and localized copy down; only an actual
 * outage shows the band.
 *
 * Fixed under the title bar by default; `inline` lets it flow in the column
 * that mounts it.
 */

import type { JSX } from "react";
import { Swatch } from "./swatch.js";

export function ConnectionBanner({ reconnecting, label, meta, inline = false }: {
  /** True while the connection is in backoff/retry. */
  readonly reconnecting: boolean;
  /** Banner copy, resolved by the owner. */
  readonly label: string;
  /** A muted figure at the right, resolved by the owner. */
  readonly meta?: string;
  /** Flow inside the mounting column instead of the fixed band. */
  readonly inline?: boolean;
}): JSX.Element | null {
  if (!reconnecting) return null;
  return (
    <div
      className="vex-connection-banner"
      role="status"
      data-inline={inline ? "" : undefined}
    >
      <Swatch state="concerned" size={10} />
      <span>{label}</span>
      {meta === undefined || meta === "" ? null : (
        <span className="vex-connection-banner__meta">{meta}</span>
      )}
    </div>
  );
}
