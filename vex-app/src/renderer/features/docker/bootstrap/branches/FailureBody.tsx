/**
 * Branch D - Docker check did not complete. Sources of failure:
 *   1) `dockerStatus.data.ok === false` - IPC/Result error
 *   2) `engine.state.kind === "permission_denied"` - the engine socket
 *      exists and refused this process
 *   3) `engine.state.kind === "error"` - probe error, or endpoint rejected
 *      (context misconfigured, remote context, ...)
 *
 * Each case states its own real cause and remediation; none is reduced to
 * "unexpected error". It is the ink callout (a failure is ink, never a hue).
 * Recheck lives in the orchestrator's actions.
 */

import type { JSX } from "react";

import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { DocsLink } from "../../../../components/onboarding/DocsLink.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import { DOCKER_ENGINE_LINUX_URL } from "../constants.js";
// Type-only import - `useDockerStatus` is referenced solely as
// `typeof useDockerStatus` to derive the data shape. `verbatimModuleSyntax`
// in tsconfig.base.json elides this import at compile time so no runtime
// hook gets pulled into a presentational branch (codex non-blocking cleanup).
import type { useDockerStatus } from "../../../../lib/api/docker.js";

interface FailureBodyProps {
  readonly status: ReturnType<typeof useDockerStatus>["data"];
}

export function FailureBody({ status }: FailureBodyProps): JSX.Element {
  const engineState = status?.ok === true ? status.data.engine.state : null;
  const denied = engineState?.kind === "permission_denied";
  const probeFailed =
    engineState?.kind === "error" && engineState.reason === "probe_error";
  const title = denied
    ? "Docker denied access"
    : probeFailed
      ? "Docker probe failed"
      : "Docker check did not complete";
  const message = denied
    ? engineState.message
    : probeFailed
      ? `${engineState.message} Open the logs folder for details.`
      : engineState?.kind === "error"
        ? engineState.message
        : status?.ok === false
          ? status.error.message
          : status?.ok === true && !status.data.endpoint.accepted
            ? (status.data.endpoint.message ?? "Docker endpoint rejected.")
            : "Docker check did not complete.";
  return (
    <>
      <SetupStatusCard tone="error" title={title} detail={message} />

      <ul className="vex-fr-steps list-disc">
        <li>Ensure your user has access to the local Docker socket.</li>
        <li>
          Use a local Docker Engine or Docker Desktop endpoint - remote
          Docker contexts are blocked for local data safety.
        </li>
      </ul>

      <div className="vex-fr-row vex-fr-row--links">
        <DocsLink href={DOCKER_ENGINE_LINUX_URL} label="View Docker install docs" />
        <OpenLogsLink className="vex-fr-link" />
      </div>
    </>
  );
}
