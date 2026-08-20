/**
 * Post-submit status banners for the export-private-key modal: the "copied —
 * scrub in {N}s" warning banner (phase === "copied") and the "scrub attempted —
 * closing" success banner (phase === "cleared" | "closing"). Tones ride the
 * semantic tokens (--color-warning / --color-success) via the repo's
 * color-mix hairline recipe (SetupStatusCard/ReviewStep pattern).
 *
 * Extracted verbatim from `ExportPrivateKeyModal.tsx`. Purely presentational:
 * it shows only the countdown integer — never any secret material.
 */

import type { JSX } from "react";
import type { Phase } from "./types.js";

export interface ExportPrivateKeyBannersProps {
  readonly phase: Phase;
  readonly clearCountdown: number;
}

export function ExportPrivateKeyBanners({
  phase,
  clearCountdown,
}: ExportPrivateKeyBannersProps): JSX.Element {
  return (
    <>
      {phase === "copied" ? (
        <p
          className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
          role="status"
          data-vex-export-status="copied"
        >
          Copied. Clipboard will be scrubbed in {clearCountdown}s.
        </p>
      ) : null}

      {phase === "cleared" || phase === "closing" ? (
        <p
          className="rounded-xl border border-success/40 bg-success/10 p-3 text-sm text-success"
          role="status"
          data-vex-export-status="cleared"
        >
          Vex attempted to scrub the clipboard. This window will close shortly.
        </p>
      ) : null}
    </>
  );
}
