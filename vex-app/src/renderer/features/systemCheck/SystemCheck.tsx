/**
 * System Check screen: the first screen on the stage after
 * the Chronos Gate cold open (first-run / remediation path; returning
 * users skip it entirely via the gate's orchestrator).
 *
 * Visual system (docs/design/R3-MINIMAL.md section 10.3): the screen stands at
 * the right of the stage plate (`SetupFrame`, layout `plate`): the crumb, a
 * serif sentence-case title above the four probe rows, separated by hairlines.
 * Status is shown by fill: a swatch beside a sentence-case word. Vex's face on
 * the plate follows the screen's mood: working while a probe is in flight,
 * concerned when the network or Docker is not ready, an error when a probe
 * failed, else ready.
 *
 * Data flow is unchanged: three TanStack Query hooks (`useSystemHealth`,
 * `useDockerStatus`, `useEnvState`) feed four probe rows, each row
 * computes its `StepStatus` from the Result envelope. Continue stays
 * disabled until every probe resolves; the translocation banner stays
 * loud (the macOS quarantine warning owns this screen).
 *
 * M11.5.4 - DMR (Docker Model Runner) is no longer surfaced here.
 * vex-app ships its own bundled embeddings runtime via Compose
 * (`embeddings-runtime` service). The `dockerStatusSchema.modelRunner`
 * block is retained unchanged for backward compatibility - the probe
 * still runs but no rendered surface consumes it.
 */

import { type JSX } from "react";

import { useDockerStatus } from "../../lib/api/docker.js";
import { useEnvState } from "../../lib/api/onboarding.js";
import { useSystemHealth } from "../../lib/api/system.js";
import { useUiStore } from "../../stores/uiStore.js";
import type { FirstRunMood } from "../../components/onboarding/FirstRunStage.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { type StepStatus } from "./StepRow.js";
import { ProbeRows } from "./SystemCheck/ProbeRows.js";
import { Footer } from "./SystemCheck/Footer.js";

export function SystemCheck(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const health = useSystemHealth();
  const docker = useDockerStatus();
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

  const anyLoading = health.isPending || docker.isPending || env.isPending;

  // What Vex shows on the plate: working while a probe is in flight, an error when one failed,
  // concerned when the network or Docker is not ready, else ready.
  const statuses = [osStatus, networkStatus, dockerStatus, envStatus];
  const mood: FirstRunMood = anyLoading
    ? "working"
    : statuses.includes("fail")
      ? "error"
      : networkStatus === "warn" || dockerStatus === "warn"
        ? "concerned"
        : "ready";

  return (
    <SetupFrame
      layout="plate"
      screen="systemCheck"
      step="systemCheck"
      mood={mood}
      title="System check"
      subline="Four quick checks before setup begins."
    >
      <ProbeRows
        osStatus={osStatus}
        networkStatus={networkStatus}
        dockerStatus={dockerStatus}
        envStatus={envStatus}
        health={health}
        docker={docker}
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
        disabled={anyLoading}
        onContinue={() => setCurrentView("dockerBootstrap")}
      />
    </SetupFrame>
  );
}
