/**
 * ConnectionBanner: top strip surfacing connection loss. Purely
 * presentational - the owner subscribes to connection state and passes
 * `reconnecting` and localized copy down; only an actual outage shows the
 * strip.
 */

import type { JSX } from "react";

export function ConnectionBanner({ reconnecting, label }: {
  /** True while the connection is in backoff/retry. */
  readonly reconnecting: boolean;
  /** Banner copy, resolved by the owner. */
  readonly label: string;
}): JSX.Element | null {
  if (!reconnecting) return null;
  return (
    <div className="vex-connection-banner" role="status">
      {label}
    </div>
  );
}
