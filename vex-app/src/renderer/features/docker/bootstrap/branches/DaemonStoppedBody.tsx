/**
 * Branch B - engine installed, daemon stopped. Platform-branched copy:
 *
 *   Linux:  the main-process `useDockerStart()` only attempts the
 *           user-mode Docker Desktop unit (`systemctl --user start
 *           docker-desktop`), it never runs `sudo systemctl start
 *           docker`. So the prominent path on Linux is the sudo command
 *           as a COPY-PASTE block (never auto-run), with "Try Start
 *           Docker Desktop" as a subordinate quiet button for users
 *           running user-mode Docker Desktop.
 *
 *   macOS / Windows:  the standard launch flow - Vex calls the system
 *                     "open" handler which boots Docker Desktop.
 *
 *   unknown platform: generic fallback copy, no docs link.
 *
 * Shape (`docs/design/R3-MINIMAL.md section 10.3`): the card with "Paused" (the dotted
 * outline), the steps, the primary key with Recheck beside it, then the blue links.
 */

import type { JSX, ReactNode } from "react";

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
  /** The Recheck key, drawn beside this branch's primary key. */
  readonly recheck: ReactNode;
}

export function DaemonStoppedBody({
  platform,
  starting,
  startMessage,
  onStart,
  recheck,
}: DaemonStoppedBodyProps): JSX.Element {
  if (platform === "linux") {
    return (
      <>
        <SetupStatusCard
          tone="warn"
          state="sleeping"
          word="Paused"
          title="Docker daemon is not running"
          detail="On Linux the Docker daemon is a system service and requires sudo to start."
        />

        <div className="flex w-full flex-col gap-2">
          <p className="vex-fr-eyebrow">Run this in a terminal</p>
          <pre className="vex-fr-code">
            <code>sudo systemctl start docker</code>
          </pre>
          <p className="vex-fr-text">Then click Recheck below.</p>
        </div>

        <div className="vex-fr-acts">
          <div className="vex-fr-row">
            <Button variant="quiet" disabled={starting} onClick={onStart}>
              {starting ? "Starting…" : "Try Start Docker Desktop"}
            </Button>
            {recheck}
          </div>
          {startMessage ? <p className="vex-fr-text">{startMessage}</p> : null}
          <div className="vex-fr-row vex-fr-row--links">
            <DocsLink href={DOCKER_ENGINE_LINUX_URL} label="View Docker Engine docs" />
            <OpenLogsLink className="vex-fr-link" />
          </div>
        </div>
      </>
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
    <>
      <SetupStatusCard
        tone="warn"
        state="sleeping"
        word="Paused"
        title={tileTitle}
        detail={tileDetail}
      />

      {isDesktopPlatform ? (
        <ol className="vex-fr-steps">
          <li>Click Start Docker (launches Docker Desktop).</li>
          <li>Wait ~30s for the daemon to answer.</li>
          <li>Click Recheck below.</li>
        </ol>
      ) : null}

      <div className="vex-fr-acts">
        <div className="vex-fr-row">
          <Button disabled={starting} onClick={onStart} className="w-[260px] max-w-full">
            {starting ? "Starting…" : "Start Docker"}
          </Button>
          {recheck}
        </div>
        {startMessage ? <p className="vex-fr-text">{startMessage}</p> : null}
        <div className="vex-fr-row vex-fr-row--links">
          {docsUrl ? <DocsLink href={docsUrl} label="View Docker Desktop docs" /> : null}
          <OpenLogsLink className="vex-fr-link" />
        </div>
      </div>
    </>
  );
}
