/**
 * Branch C-linux - engine missing on Linux. Orchestrator auto-fetches
 * the apt-repo bootstrap from `useDockerInstall({ method:
 * "linux_manual_instructions" })` and passes the resulting state in.
 *
 * Rendering matrix:
 *   loading - a word and the quiet loading line
 *   error   - the ink callout with "Retry instructions fetch" (separate from
 *             the orchestrator's Recheck; this retries the fetch only)
 *   ready   - `<LinuxManualInstructions>` with the copy-paste block
 *
 * Always-present: docker-group privilege heads-up (joining the group
 * grants root-equivalent access - Vex supports the standard Engine +
 * Compose path; rootless mode is mentioned as an advanced, separate
 * path per codex review).
 */

import type { JSX } from "react";

import { VexLoader } from "../../../../components/ui/vex-loader.js";
import { Button } from "../../../../components/ui/button.js";
import { ErrorCallout } from "../../../../components/ui/error-callout.js";
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
    <>
      <SetupStatusCard
        tone="info"
        word="Install"
        title="Docker Engine is not installed"
        detail="Linux - install via your package manager."
      />

      {state.kind === "loading" ? (
        <div className="flex flex-col items-start gap-3">
          <VexLoader label="Loading install instructions" />
          <p aria-hidden className="vex-fr-text">
            Loading install instructions…
          </p>
        </div>
      ) : state.kind === "error" ? (
        <ErrorCallout
          compact
          role="alert"
          title={`Couldn’t fetch install instructions: ${state.message}`}
          actions={
            <Button variant="quiet" size="sm" onClick={onRetryFetch}>
              Retry instructions fetch
            </Button>
          }
        />
      ) : state.kind === "ready" ? (
        <LinuxManualInstructions instructions={state.instructions} />
      ) : null}

      {/* The ink callout: frame, hatch band, ink type. */}
      <div className="vex-callout">
        <strong className="font-semibold">
          Heads up:
        </strong>{" "}
        joining the <code className="font-code">docker</code> group grants
        root-equivalent access on this machine. Vex&rsquo;s supported Linux
        path is the standard Docker Engine + Compose plugin (the commands
        above). Advanced users can review{" "}
        <a
          href={DOCKER_ROOTLESS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="vex-fr-link"
        >
          Docker&rsquo;s rootless mode
        </a>{" "}
        as a separate path.
      </div>

      <div className="vex-fr-row vex-fr-row--links">
        <DocsLink
          href={DOCKER_ENGINE_LINUX_URL}
          label="View official Docker Engine docs"
        />
        <OpenLogsLink className="vex-fr-link" />
      </div>
    </>
  );
}
