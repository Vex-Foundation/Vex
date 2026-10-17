/**
 * The four System Check probe rows (`<ol>`). Pure presentation: every
 * status arrives as a prop - this module derives nothing and performs no
 * IO. All four rows render immediately; the stage crossfade is the only
 * entrance.
 *
 * Reuses the shared `StepRow` (one level up) so the row chrome and the
 * `data-step-status` test selector stay single-sourced. The rows carry no
 * glyph (`docs/design/R3-MINIMAL.md section 10.3`): the label, the detail and
 * the state word say it.
 *
 * Type-only imports for the query hooks (`typeof useX`) derive the data
 * shape without pulling a runtime hook into a presentational module;
 * `verbatimModuleSyntax` elides them at compile time.
 */

import type { JSX } from "react";

import { StepRow, type StepStatus } from "../StepRow.js";
import {
  formatDockerDetail,
  formatEnvDetail,
  formatPlatform,
} from "./format.js";
import type { useSystemHealth } from "../../../lib/api/system.js";
import type { useDockerStatus } from "../../../lib/api/docker.js";
import type { useEnvState } from "../../../lib/api/onboarding.js";

interface ProbeRowsProps {
  readonly osStatus: StepStatus;
  readonly networkStatus: StepStatus;
  readonly dockerStatus: StepStatus;
  readonly envStatus: StepStatus;
  readonly health: ReturnType<typeof useSystemHealth>;
  readonly docker: ReturnType<typeof useDockerStatus>;
  readonly env: ReturnType<typeof useEnvState>;
}

export function ProbeRows({
  osStatus,
  networkStatus,
  dockerStatus,
  envStatus,
  health,
  docker,
  env,
}: ProbeRowsProps): JSX.Element {
  return (
    <ol className="vex-fr-probes">
      <StepRow
        label="Operating system"
        status={osStatus}
        detail={
          health.data?.ok
            ? `${formatPlatform(health.data.data.os.platform, health.data.data.os.distro)} · Electron ${health.data.data.os.electronVersion}`
            : null
        }
      />
      <StepRow
        label="Network connectivity"
        status={networkStatus}
        detail={
          health.data?.ok
            ? health.data.data.network.online
              ? `online · ${health.data.data.network.latencyMs ?? "?"} ms`
              : "offline - agent will run with limited capabilities"
            : null
        }
      />
      <StepRow
        label="Docker Engine"
        status={dockerStatus}
        // "Ready" reads more accurately than "OK" for an engine
        // that's installed + daemon running + container available.
        // Other states fall back to the StepRow defaults.
        badgeLabel={dockerStatus === "ok" ? "Ready" : undefined}
        detail={
          docker.data?.ok
            ? formatDockerDetail(docker.data.data)
            : null
        }
      />
      <StepRow
        label="Vex configuration"
        status={envStatus}
        // First-run nudge: "Setup" beats "Warning" for a warn state that
        // means "guided setup required" - the only warn cause for
        // env config currently. Other states use defaults.
        badgeLabel={envStatus === "warn" ? "Setup" : undefined}
        detail={
          env.data?.ok ? formatEnvDetail(env.data.data) : null
        }
      />
    </ol>
  );
}
