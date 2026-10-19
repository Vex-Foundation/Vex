/**
 * System Check screen: the first screen on the stage after
 * the Chronos Gate cold open (first-run / remediation path; returning
 * users skip it entirely via the gate's orchestrator).
 *
 * Visual system (docs/design/R3-MINIMAL.md section 10.3): the screen stands at
 * the right of the stage plate (`SetupFrame`, layout `plate`): the crumb, a
 * serif sentence-case title above the six probe rows, separated by hairlines.
 * Status is shown by fill: a swatch beside a sentence-case word. Vex's face on
 * the plate follows the screen's mood: working while a probe is in flight,
 * concerned when the network or the local runtime's machine is not ready, an
 * error when a probe failed, else ready.
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
 */

import { type JSX } from "react";

import { useEnvState } from "../../lib/api/onboarding.js";
import {
  useLocalRuntimeCheck,
  useRuntimeInfo,
  useRuntimeMigrationStatus,
  useSystemHealth,
} from "../../lib/api/system.js";
import { useUiStore } from "../../stores/uiStore.js";
import type { FirstRunMood } from "../../components/onboarding/FirstRunStage.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { type StepStatus } from "./StepRow.js";
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

  // What Vex shows on the plate: working while a probe is in flight, an error
  // when one failed, concerned when the network or the local runtime's machine
  // is not ready, else ready. A door run starts no runtime, so its rows do not
  // count there.
  const runtimeStatuses: StepStatus[] = doorRun
    ? []
    : [localRuntimeRows.bundle.status, localRuntimeRows.disk.status, localRuntimeRows.memory.status];
  const statuses = [osStatus, networkStatus, ...runtimeStatuses, envStatus];
  const mood: FirstRunMood = anyLoading
    ? "working"
    : statuses.includes("fail")
      ? "error"
      : networkStatus === "warn" || runtimeStatuses.includes("warn")
        ? "concerned"
        : "ready";

  return (
    <SetupFrame
      layout="plate"
      screen="systemCheck"
      step="systemCheck"
      mood={mood}
      title="System check"
      subline="Six quick checks before setup begins."
    >
      <ProbeRows
        osStatus={osStatus}
        networkStatus={networkStatus}
        envStatus={envStatus}
        health={health}
        localRuntime={localRuntimeRows}
        env={env}
      />

      {health.data?.ok && health.data.data.translocated ? (
        // The ink callout - still deliberately loud (invariant: the translocation
        // warning stays loud here), and one more thing to read before Continue.
        <ErrorCallout
          role="alert"
          title="Vex is running from a quarantined location (App Translocation)."
          hint="Move Vex.app to /Applications in Finder and relaunch."
        />
      ) : null}

      <Footer
        disabled={anyLoading || (!doorRun && localRuntimeRows.blocksContinue)}
        onContinue={() => setCurrentView(nextView)}
      />
    </SetupFrame>
  );
}
