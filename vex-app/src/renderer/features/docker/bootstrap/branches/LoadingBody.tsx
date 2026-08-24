/**
 * Branch: loading — Docker probe hasn't returned data yet, OR engine is
 * missing and the platform health probe is still resolving. The hero
 * VexLoader ring (paper tone) announces the wait; the orchestrator
 * disables the footer Recheck while this branch is active.
 */

import { VexLoader } from "../../../../components/ui/vex-loader.js";

export function LoadingBody(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-5 py-6">
      {/* Loader label deliberately does NOT repeat "Detecting Docker" —
       * the visible line below carries it, and tests getByText the
       * phrase (a duplicate sr-only match would be ambiguous). */}
      <VexLoader
        size={72}
        stroke={2}
        tone="paper"
        label="Probing the Docker endpoint"
      />
      <div className="flex flex-col items-center gap-1">
        <p className="text-sm font-medium text-ink-primary">
          Detecting Docker…
        </p>
        <p className="text-xs text-ink-tertiary">
          Probing the Docker endpoint and platform. This should take a few
          seconds.
        </p>
      </div>
    </div>
  );
}
