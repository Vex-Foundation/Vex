/**
 * Branch D — Docker check did not complete. Two sources of failure:
 *   1) `dockerStatus.data.ok === false` — IPC/Result error
 *   2) `dockerStatus.data.data.endpoint.accepted === false` — endpoint
 *      rejected (context misconfigured, socket access denied, etc.)
 *
 * Either way: surface the message, suggest the common fixes, and link
 * the canonical install docs. Recheck lives in the orchestrator footer.
 */

import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { DocsLink } from "../../../../components/onboarding/DocsLink.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import { DOCKER_ENGINE_LINUX_URL } from "../constants.js";
// Type-only import — `useDockerStatus` is referenced solely as
// `typeof useDockerStatus` to derive the data shape. `verbatimModuleSyntax`
// in tsconfig.base.json elides this import at compile time so no runtime
// hook gets pulled into a presentational branch (codex non-blocking cleanup).
import type { useDockerStatus } from "../../../../lib/api/docker.js";

interface FailureBodyProps {
  readonly status: ReturnType<typeof useDockerStatus>["data"];
}

export function FailureBody({ status }: FailureBodyProps): JSX.Element {
  const probeFailed =
    status?.ok === true && status.data.engine.failure === "probe_error";
  const title = probeFailed
    ? "Docker probe failed"
    : "Docker check did not complete";
  const message =
    probeFailed
      ? "Docker probe failed — open the logs folder for details."
      : status?.ok === false
      ? status.error.message
      : status?.ok && !status.data.endpoint.accepted
        ? (status.data.endpoint.message ?? "Docker endpoint rejected.")
        : "Docker check did not complete.";
  return (
    <div className="flex flex-col gap-4">
      <SetupStatusCard tone="error" title={title} detail={message} />

      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs leading-relaxed text-[var(--color-text-secondary)]">
        <li>Ensure your user has access to the local Docker socket.</li>
        <li>
          Use a local Docker Engine or Docker Desktop endpoint — remote
          Docker contexts are blocked for local data safety.
        </li>
      </ul>

      <DocsLink href={DOCKER_ENGINE_LINUX_URL} label="View Docker install docs" />
      <OpenLogsLink />
    </div>
  );
}
