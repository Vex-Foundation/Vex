/**
 * The System Check probe rows (`<ol>`). Pure presentation: every status and
 * the resolved platform arrive as props — this module derives nothing and
 * performs no IO. All rows render immediately (the NOTARY-era cascade reveal
 * is retired; the card itself rises once via `.vex-rise` in the parent).
 *
 * The rows between network and configuration are the bundled local
 * runtime's: Local runtime, Disk space, Memory (`LocalRuntimeRows`).
 *
 * Reuses the shared `StepRow` (one level up) so the row chrome and the
 * `data-step-status` test selector stay single-sourced.
 *
 * Type-only imports for the query hooks (`typeof useX`) derive the data
 * shape without pulling a runtime hook into a presentational module;
 * `verbatimModuleSyntax` elides them at compile time.
 */

import {
  IconSettings,
  IconWifi,
} from "../../../components/icons/index.js";

import { StepRow, type StepStatus } from "../StepRow.js";
import { OperatingSystemIcon, type Platform } from "./OperatingSystemIcon.js";
import { LocalRuntimeRows } from "./LocalRuntimeRows.js";
import type { LocalRuntimeView } from "./localRuntime.js";
import { formatEnvDetail, formatPlatform } from "./format.js";
import type { useSystemHealth } from "../../../lib/api/system.js";
import type { useEnvState } from "../../../lib/api/onboarding.js";

interface ProbeRowsProps {
  readonly platform: Platform;
  readonly osStatus: StepStatus;
  readonly networkStatus: StepStatus;
  readonly envStatus: StepStatus;
  readonly health: ReturnType<typeof useSystemHealth>;
  readonly localRuntime: LocalRuntimeView;
  readonly env: ReturnType<typeof useEnvState>;
}

export function ProbeRows({
  platform,
  osStatus,
  networkStatus,
  envStatus,
  health,
  localRuntime,
  env,
}: ProbeRowsProps): JSX.Element {
  return (
    <ol className="flex w-full flex-col">
      <StepRow
        label="Operating system"
        status={osStatus}
        icon={<OperatingSystemIcon platform={platform} />}
        detail={
          health.data?.ok
            ? `${formatPlatform(health.data.data.os.platform, health.data.data.os.distro)} · Electron ${health.data.data.os.electronVersion}`
            : null
        }
      />
      <StepRow
        label="Network connectivity"
        status={networkStatus}
        icon={<IconWifi size={20} />}
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
        icon={
          <IconSettings size={20} />
        }
        // First-run nudge: "SETUP" beats "WARN" for a warn state that
        // means "guided setup required" — the only warn cause for
        // env config currently. Other states use defaults.
        badgeLabel={envStatus === "warn" ? "SETUP" : undefined}
        detail={
          env.data?.ok ? formatEnvDetail(env.data.data) : null
        }
      />
    </ol>
  );
}
