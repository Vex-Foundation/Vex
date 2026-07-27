/**
 * Branch C-linux — engine missing on Linux. Orchestrator auto-fetches
 * the apt-repo bootstrap from `useDockerInstall({ method:
 * "linux_manual_instructions" })` and passes the resulting state in.
 *
 * Rendering matrix:
 *   loading — inline VexLoader + "Loading install instructions…"
 *   error   — message + "Retry instructions fetch" (separate from main
 *             footer Recheck; this retries the fetch only)
 *   ready   — `<LinuxManualInstructions>` with copy-paste block
 *
 * Always-present: docker-group privilege heads-up (joining the group
 * grants root-equivalent access — Vex supports the standard Engine +
 * Compose path; rootless mode is mentioned as an advanced, separate
 * path per codex review).
 */

import { VexLoader } from "../../../../components/ui/vex-loader.js";
import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { DocsLink } from "../../../../components/onboarding/DocsLink.js";
import { LinuxManualInstructions } from "../../LinuxManualInstructions.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import {
  DOCKER_ENGINE_LINUX_URL,
  DOCKER_ROOTLESS_URL,
} from "../constants.js";
import type { ManualFetchState } from "../types.js";

interface LinuxInstallBodyProps {
  readonly state: ManualFetchState;
  readonly onRetryFetch: () => void;
}

export function LinuxInstallBody({
  state,
  onRetryFetch,
}: LinuxInstallBodyProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <SetupStatusCard
        tone="info"
        word="Install"
        title="Docker Engine is not installed"
        detail="Linux — install via your package manager."
      />

      {state.kind === "loading" ? (
        <div className="flex items-center gap-2.5">
          <VexLoader
            size={16}
            stroke={2}
            tone="paper"
            label="Loading install instructions"
          />
          <p aria-hidden className="text-xs text-[var(--color-text-secondary)]">
            Loading install instructions…
          </p>
        </div>
      ) : state.kind === "error" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-[var(--color-danger)]">
            Couldn&rsquo;t fetch install instructions: {state.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRetryFetch}
            className="self-start text-[var(--color-text-secondary)]"
          >
            Retry instructions fetch
          </Button>
        </div>
      ) : state.kind === "ready" ? (
        <LinuxManualInstructions instructions={state.instructions} />
      ) : null}

      {/* Warning RAIL (A3 alert grammar — no fill, no box). */}
      <div className="border-l-2 border-[color-mix(in_oklab,var(--color-warning)_45%,transparent)] pl-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
        <strong className="font-semibold text-[var(--color-warning)]">
          Heads up:
        </strong>{" "}
        joining the <code className="font-mono">docker</code> group grants
        root-equivalent access on this machine. Vex&rsquo;s supported Linux
        path is the standard Docker Engine + Compose plugin (the commands
        above). Advanced users can review{" "}
        <a
          href={DOCKER_ROOTLESS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color-mix(in_oklab,var(--vex-onboarding-accent,var(--color-accent-primary))_55%,white)] underline-offset-4 hover:underline"
        >
          Docker&rsquo;s rootless mode
        </a>{" "}
        as a separate path.
      </div>

      <DocsLink
        href={DOCKER_ENGINE_LINUX_URL}
        label="View official Docker Engine docs"
      />
      <OpenLogsLink />
    </div>
  );
}
