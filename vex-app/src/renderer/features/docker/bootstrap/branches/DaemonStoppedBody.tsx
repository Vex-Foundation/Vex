/**
 * Branch B — engine installed, daemon stopped. Platform-branched copy:
 *
 *   Linux:  the main-process `useDockerStart()` only attempts the
 *           user-mode Docker Desktop unit (`systemctl --user start
 *           docker-desktop`), it never runs `sudo systemctl start
 *           docker`. So the prominent path on Linux is the sudo command
 *           as a COPY-PASTE block (never auto-run), with "Try Start
 *           Docker Desktop" as a subordinate ghost button for users
 *           running user-mode Docker Desktop.
 *
 *   macOS / Windows:  the standard launch flow — Vex calls the system
 *                     "open" handler which boots Docker Desktop.
 *
 *   unknown platform: generic fallback copy, no docs link.
 */

import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { DocsLink } from "../../../../components/onboarding/DocsLink.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import {
  DOCKER_DESKTOP_MAC_URL,
  DOCKER_DESKTOP_WIN_URL,
  DOCKER_ENGINE_LINUX_URL,
} from "../constants.js";

interface DaemonStoppedBodyProps {
  readonly platform: string | null;
  readonly starting: boolean;
  readonly startMessage: string | null;
  readonly onStart: () => void;
}

export function DaemonStoppedBody({
  platform,
  starting,
  startMessage,
  onStart,
}: DaemonStoppedBodyProps): JSX.Element {
  if (platform === "linux") {
    return (
      <div className="flex flex-col gap-4">
        <SetupStatusCard
          tone="warn"
          word="Paused"
          title="Docker daemon is not running"
          detail="On Linux the Docker daemon is a system service and requires sudo to start."
        />

        <div className="flex flex-col gap-2">
          <p className="vex-micro text-ink-secondary">
            Run this in a terminal
          </p>
          <pre className="overflow-auto rounded-lg border border-[var(--color-border)] bg-gate-code p-3 font-mono text-xs leading-relaxed text-ink-primary">
            <code>sudo systemctl start docker</code>
          </pre>
          <p className="text-xs text-ink-secondary">
            Then click Recheck below.
          </p>
        </div>

        <Button
          variant="ghost"
          disabled={starting}
          onClick={onStart}
          className="self-start text-ink-secondary"
        >
          {starting ? "Starting…" : "Try Start Docker Desktop"}
        </Button>
        {startMessage ? (
          <p className="text-xs leading-relaxed text-ink-secondary">
            {startMessage}
          </p>
        ) : null}

        <DocsLink href={DOCKER_ENGINE_LINUX_URL} label="View Docker Engine docs" />
        <OpenLogsLink />
      </div>
    );
  }

  const docsUrl =
    platform === "darwin"
      ? DOCKER_DESKTOP_MAC_URL
      : platform === "win32"
        ? DOCKER_DESKTOP_WIN_URL
        : null;
  const isDesktopPlatform = platform === "darwin" || platform === "win32";
  const tileTitle = isDesktopPlatform
    ? "Docker installed, daemon stopped"
    : "Docker daemon is not running";
  const tileDetail = isDesktopPlatform
    ? "macOS may need ~30 seconds before the daemon answers."
    : "Start Docker from your system tools, then click Recheck below.";

  return (
    <div className="flex flex-col gap-4">
      <SetupStatusCard
        tone="warn"
        word="Paused"
        title={tileTitle}
        detail={tileDetail}
      />

      {isDesktopPlatform ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs leading-relaxed text-ink-secondary">
          <li>Click Start Docker (launches Docker Desktop).</li>
          <li>Wait ~30s for the daemon to answer.</li>
          <li>Click Recheck below.</li>
        </ol>
      ) : null}

      <Button
        size="lg"
        className="w-full"
        disabled={starting}
        onClick={onStart}
      >
        {starting ? "Starting…" : "Start Docker"}
      </Button>
      {startMessage ? (
        <p className="text-xs leading-relaxed text-ink-secondary">
          {startMessage}
        </p>
      ) : null}

      {docsUrl ? <DocsLink href={docsUrl} label="View Docker Desktop docs" /> : null}
      <OpenLogsLink />
    </div>
  );
}
