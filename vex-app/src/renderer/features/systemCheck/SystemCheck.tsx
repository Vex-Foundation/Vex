/**
 * System Check screen: the first screen on the stage after
 * the Chronos Gate cold open (first-run / remediation path; returning
 * users skip it entirely via the gate's orchestrator).
 *
 * Visual system (docs/design/V10-SPREAD.md section 2): the screen is a
 * paper page on the stage (`SetupFrame`), a serif sentence-case title above
 * the probe rows, separated by hairlines. Status is shown by fill: a
 * swatch beside the mono word; a probe in flight shows the ongoing swatch at
 * size (the VexLoader). The rows rise once (`.vex-rise` ladder) and rest
 * still.
 *
 * Data flow: TanStack Query hooks feed the probe rows, each row computing
 * its `StepStatus` from the Result envelope. The bundled local runtime's
 * rows come from `useLocalRuntimeCheck` (bundle, disk, memory; six rows in
 * all), which reads facts and starts nothing. Continue stays disabled until
 * every probe resolves, and while a disk cannot take the runtime's first
 * run; the translocation banner stays loud (the macOS quarantine warning
 * owns this screen).
 *
 * Continue leads to the runtime screen, or to the migration screen first
 * while this install's data must still be moved. An e2e door run
 * (`useRuntimeInfo` answers `native: false`) starts no runtime because its
 * database is already published, so Continue goes straight to migrations
 * and the disk does not hold it back.
 *
 * CSP: brand icons come from `@thesvg/react` (typed React components,
 * no `dangerouslySetInnerHTML`); generic UI glyphs are the inline-SVG set in
 * `components/icons`. All animation is stylesheet @keyframes.
 */

import { useMemo } from "react";

import { useEnvState } from "../../lib/api/onboarding.js";
import {
  useLocalRuntimeCheck,
  useRuntimeInfo,
  useRuntimeMigrationStatus,
  useSystemHealth,
} from "../../lib/api/system.js";
import { useUiStore } from "../../stores/uiStore.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { type StepStatus } from "./StepRow.js";
import { platformOf, type Platform } from "./SystemCheck/OperatingSystemIcon.js";
import { ProbeRows } from "./SystemCheck/ProbeRows.js";
import { localRuntimeView } from "./SystemCheck/localRuntime.js";
import { Footer } from "./SystemCheck/Footer.js";

export function SystemCheck(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const health = useSystemHealth();
  const runtime = useRuntimeInfo();
  // Main starts the native runtime on every launch but a door run's. Only an
  // explicit `native: false` is one; anything else is the native path.
  const doorRun = runtime.data?.ok === true && !runtime.data.data.native;
  const localRuntime = useLocalRuntimeCheck();
  const env = useEnvState();

  const platform = useMemo<Platform>(
    () => platformOf(health.data?.ok ? health.data.data.os.platform : undefined),
    [health.data],
  );

  const osStatus: StepStatus = health.isPending
    ? "loading"
    : health.data?.ok
      ? "ok"
      : "fail";

  const networkStatus: StepStatus = health.isPending
    ? "loading"
    : health.data?.ok && health.data.data.network.online
      ? "ok"
      : "warn";

  const envStatus: StepStatus = env.isPending
    ? "loading"
    : !env.data?.ok
      ? "fail"
      : env.data.data.setupCompleteFlag
        ? "ok"
        : "warn";

  // Main holds the native runtime back while this install's data must still
  // be moved, and the migration screen comes first then. A door run has
  // nothing to move: its status is not asked for.
  const migration = useRuntimeMigrationStatus(!runtime.isPending && !doorRun);
  const nextView = doorRun
    ? "migrations"
    : migration.data?.ok === true && migration.data.data.kind === "not_needed"
      ? "runtimeBootstrap"
      : "runtimeMigration";

  const localRuntimeRows = localRuntimeView(localRuntime);

  const anyLoading =
    health.isPending
    || env.isPending
    || runtime.isPending
    || localRuntime.isPending
    || (!doorRun && migration.isPending);

  return (
    <SetupFrame
      screen="systemCheck"
      title="System check"
      subline="Six quick checks before setup begins."
    >
      {/* Probe rows on the leaf, separated by hairline only. */}
      <div className="vex-rise vex-rise-d1">
        <ProbeRows
          platform={platform}
          osStatus={osStatus}
          networkStatus={networkStatus}
          envStatus={envStatus}
          health={health}
          localRuntime={localRuntimeRows}
          env={env}
        />
      </div>

      {health.data?.ok && health.data.data.translocated ? (
        // The risk callout (ink frame, hatched edge) - still deliberately
        // loud (invariant: the translocation warning stays loud here).
        <div
          role="alert"
          className="vex-rise vex-rise-d2 vex-callout mt-5"
        >
          Vex is running from a quarantined location (App Translocation). Move
          Vex.app to /Applications in Finder and relaunch.
        </div>
      ) : null}

      <Footer
        disabled={anyLoading || (!doorRun && localRuntimeRows.blocksContinue)}
        onContinue={() => setCurrentView(nextView)}
      />
    </SetupFrame>
  );
}
