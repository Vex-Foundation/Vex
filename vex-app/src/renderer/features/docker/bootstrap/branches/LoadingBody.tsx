/**
 * Branch: loading - Docker probe hasn't returned data yet, OR engine is
 * missing and the platform health probe is still resolving. A word and the
 * quiet loading line announce the wait (`docs/design/R3-MINIMAL.md section 11`);
 * the orchestrator disables Recheck while this branch is active.
 */

import type { JSX } from "react";

import { VexLoader } from "../../../../components/ui/vex-loader.js";

export function LoadingBody(): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3">
      {/* Loader label deliberately does NOT repeat "Detecting Docker" -
       * the visible line below carries it, and tests getByText the
       * phrase (a duplicate sr-only match would be ambiguous). */}
      <p className="text-[15px] font-medium text-ink-primary">
        Detecting Docker…
      </p>
      <VexLoader label="Probing the Docker endpoint" />
      <p className="vex-fr-note">
        Probing the Docker endpoint and platform. This should take a few
        seconds.
      </p>
    </div>
  );
}
