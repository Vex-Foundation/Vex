/**
 * The six System Check probe rows (`<ol>`). Pure presentation: every
 * status arrives as a prop - this module derives nothing and performs no
 * IO. All six rows render immediately; the stage crossfade is the only
 * entrance.
 *
 * The rows between network and configuration are the bundled local
 * runtime's: Local runtime, Disk space, Memory (`LocalRuntimeRows`).
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
import { LocalRuntimeRows } from "./LocalRuntimeRows.js";
import type { LocalRuntimeView } from "./localRuntime.js";
import { formatEnvDetail, formatPlatform } from "./format.js";
import type { useSystemHealth } from "../../../lib/api/system.js";
import type { useEnvState } from "../../../lib/api/onboarding.js";

interface ProbeRowsProps {
  readonly osStatus: StepStatus;
  readonly networkStatus: StepStatus;
  readonly envStatus: StepStatus;
  readonly health: ReturnType<typeof useSystemHealth>;
  readonly localRuntime: LocalRuntimeView;
  readonly env: ReturnType<typeof useEnvState>;
}

export function ProbeRows({
  osStatus,
  networkStatus,
  envStatus,
  health,
  localRuntime,
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
      <LocalRuntimeRows view={localRuntime} />
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
