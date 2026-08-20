/**
 * The four System Check probe rows (`<ol>`). Pure presentation: every
 * status and the resolved platform arrive as props — this module
 * derives nothing and performs no IO. All four rows render immediately
 * (the NOTARY-era cascade reveal is retired; the card itself rises once
 * via `.vex-rise` in the parent).
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
import { Docker } from "@thesvg/react";

import { StepRow, type StepStatus } from "../StepRow.js";
import { OperatingSystemIcon, type Platform } from "./OperatingSystemIcon.js";
import {
  formatDockerDetail,
  formatEnvDetail,
  formatPlatform,
} from "./format.js";
import type { useSystemHealth } from "../../../lib/api/system.js";
import type { useDockerStatus } from "../../../lib/api/docker.js";
import type { useEnvState } from "../../../lib/api/onboarding.js";

interface ProbeRowsProps {
  readonly platform: Platform;
  readonly osStatus: StepStatus;
  readonly networkStatus: StepStatus;
  readonly dockerStatus: StepStatus;
  readonly envStatus: StepStatus;
  readonly health: ReturnType<typeof useSystemHealth>;
  readonly docker: ReturnType<typeof useDockerStatus>;
  readonly env: ReturnType<typeof useEnvState>;
}

export function ProbeRows({
  platform,
  osStatus,
  networkStatus,
  dockerStatus,
  envStatus,
  health,
  docker,
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
      <StepRow
        label="Docker Engine"
        status={dockerStatus}
        icon={<Docker width={20} height={20} aria-hidden />}
        // "READY" reads more accurately than "OK" for an engine
        // that's installed + daemon running + container available.
        // Other states fall back to StepRow defaults (CHECKING…/WARN/FAIL).
        badgeLabel={dockerStatus === "ok" ? "READY" : undefined}
        detail={
          docker.data?.ok
            ? formatDockerDetail(docker.data.data)
            : null
        }
      />
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
