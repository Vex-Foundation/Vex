/**
 * System Check screen — the first slide on the cobalt continuum after
 * the Chronos Gate cold open (first-run / remediation path; returning
 * users skip it entirely via the gate's orchestrator).
 *
 * Visual system (Chronos rebrand, A2 plate + AMENDMENT A3 boxless): the
 * SetupGate plate continues underneath (`SetupFrame`), a serif
 * sentence-case title sits above the four probe rows, which rest
 * DIRECTLY on the plate separated by hairlines (the container card is
 * retired). Status is a colored word, never a stamp; a probe in flight
 * shows the inline VexLoader ring. The rows rise once (`.vex-rise`
 * ladder) and rest still — no cascade, no counters, no ledger indexes.
 *
 * Data flow is unchanged: three TanStack Query hooks (`useSystemHealth`,
 * `useDockerStatus`, `useEnvState`) feed four probe rows, each row
 * computes its `StepStatus` from the Result envelope. Continue stays
 * disabled until every probe resolves; the translocation banner stays
 * loud (the macOS quarantine warning owns this screen).
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
import { useSystemHealth } from "../../lib/api/system.js";
import { useUiStore } from "../../stores/uiStore.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { type StepStatus } from "./StepRow.js";
import { platformOf, type Platform } from "./SystemCheck/OperatingSystemIcon.js";
import { ProbeRows } from "./SystemCheck/ProbeRows.js";
import { Footer } from "./SystemCheck/Footer.js";

export function SystemCheck(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const health = useSystemHealth();
  const docker = useDockerStatus();
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

  const anyLoading = health.isPending || docker.isPending || env.isPending;

  return (
    <SetupFrame
      screen="systemCheck"
      title="System check"
      subline="Four quick checks before setup begins."
    >
      {/* Probe rows sit directly on the plate (AMENDMENT A3 — the
       * container card is retired; rows separate by hairline only). */}
      <div className="vex-rise vex-rise-d1">
        <ProbeRows
          platform={platform}
          osStatus={osStatus}
          networkStatus={networkStatus}
          dockerStatus={dockerStatus}
          envStatus={envStatus}
          health={health}
          docker={docker}
          env={env}
        />
      </div>

      {health.data?.ok && health.data.data.translocated ? (
        // Danger RAIL (A3 alert grammar) — still deliberately loud
        // (invariant: the translocation warning stays loud here).
        <div
          role="alert"
          className="vex-rise vex-rise-d2 mt-5 border-l-2 border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] pl-3 text-sm leading-relaxed text-[color-mix(in_oklab,var(--color-danger)_70%,white)]"
        >
          Vex is running from a quarantined location (App Translocation). Move
          Vex.app to /Applications in Finder and relaunch.
        </div>
      ) : null}

      <Footer
        disabled={anyLoading}
        onContinue={() => setCurrentView("dockerBootstrap")}
      />
    </SetupFrame>
  );
}
