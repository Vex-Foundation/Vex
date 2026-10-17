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
 * its `StepStatus` from the Result envelope. `useRuntimeInfo` decides which
 * runtime rows show, and only that runtime's probe runs:
 *   - native: `useLocalRuntimeCheck` (bundle, disk, memory; six rows). It
 *     starts nothing, and a disk that cannot take the first run keeps
 *     Continue disabled.
 *   - container: `useDockerStatus` (the Docker Engine row; four rows).
 * Continue stays disabled until every probe resolves; the translocation
 * banner stays loud (the macOS quarantine warning owns this screen).
 *
 * M11.5.4 — DMR (Docker Model Runner) is no longer surfaced here.
 * vex-app ships its own bundled embeddings runtime via Compose
 * (`embeddings-runtime` service). The `dockerStatusSchema.modelRunner`
 * block is retained unchanged for backward compatibility — the probe
 * still runs but no rendered surface consumes it.
 *
 * CSP: brand icons come from `@thesvg/react` (typed React components,
 * no `dangerouslySetInnerHTML`); generic UI glyphs are the inline-SVG set in
 * `components/icons`. All animation is stylesheet @keyframes.
 */

import { useMemo } from "react";

import { useDockerStatus } from "../../lib/api/docker.js";
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
import { ProbeRows, type RuntimeRows } from "./SystemCheck/ProbeRows.js";
import { localRuntimeView } from "./SystemCheck/localRuntime.js";
import { Footer } from "./SystemCheck/Footer.js";

export function SystemCheck(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const health = useSystemHealth();
  const runtime = useRuntimeInfo();
  // The native runtime is started by main; setup watches it come up.
  const nativeRuntime = runtime.data?.ok === true && runtime.data.data.native;
  // Each runtime's probe runs only once the mode is known, and only its own.
  const docker = useDockerStatus({ enabled: !runtime.isPending && !nativeRuntime });
  const localRuntime = useLocalRuntimeCheck(nativeRuntime);
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

  const dockerStatus: StepStatus = docker.isPending
    ? "loading"
    : !docker.data?.ok
      ? "fail"
      : !docker.data.data.endpoint.accepted
        ? "fail"
        : !docker.data.data.engine.present || !docker.data.data.daemon.running
          ? "warn"
          : "ok";

  const envStatus: StepStatus = env.isPending
    ? "loading"
    : !env.data?.ok
      ? "fail"
      : env.data.data.setupCompleteFlag
        ? "ok"
        : "warn";

  // Main holds the native runtime back while this install's data must still
  // be moved, and the migration screen comes first then.
  const migration = useRuntimeMigrationStatus(nativeRuntime);
  const nativeView =
    migration.data?.ok === true && migration.data.data.kind === "not_needed" ? "runtimeBootstrap" : "runtimeMigration";

  const localRuntimeRows = localRuntimeView(localRuntime);
  const runtimeRows: RuntimeRows = nativeRuntime
    ? { kind: "native", view: localRuntimeRows }
    : { kind: "container", status: dockerStatus, docker };

  const anyLoading =
    health.isPending
    || env.isPending
    || runtime.isPending
    || (nativeRuntime ? localRuntime.isPending || migration.isPending : docker.isPending);

  return (
    <SetupFrame
      screen="systemCheck"
      title="System check"
      subline={nativeRuntime ? "Six quick checks before setup begins." : "Four quick checks before setup begins."}
    >
      {/* Probe rows on the leaf, separated by hairline only. */}
      <div className="vex-rise vex-rise-d1">
        <ProbeRows
          platform={platform}
          osStatus={osStatus}
          networkStatus={networkStatus}
          envStatus={envStatus}
          health={health}
          runtime={runtimeRows}
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
        disabled={anyLoading || (nativeRuntime && localRuntimeRows.blocksContinue)}
        onContinue={() => setCurrentView(nativeRuntime ? nativeView : "dockerBootstrap")}
      />
    </SetupFrame>
  );
}
