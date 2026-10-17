/**
 * Branch C-desktop - mac/win, engine missing. Vex offers an in-app
 * installer download via the LicenseNotice modal (the orchestrator owns
 * the modal, and the license dialog ALWAYS precedes the download IPC);
 * this body provides the numbered install steps + primary Download CTA
 * with Recheck beside it + docs link.
 */

import type { JSX, ReactNode } from "react";

import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { DocsLink } from "../../../../components/onboarding/DocsLink.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import {
  DOCKER_DESKTOP_MAC_URL,
  DOCKER_DESKTOP_WIN_URL,
} from "../constants.js";

interface DesktopInstallBodyProps {
  readonly platform: string | null;
  readonly installing: boolean;
  readonly onInstall: () => void;
  /** The Recheck key, drawn beside this branch's primary key. */
  readonly recheck: ReactNode;
}

export function DesktopInstallBody({
  platform,
  installing,
  onInstall,
  recheck,
}: DesktopInstallBodyProps): JSX.Element {
  const platformLabel =
    platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : "your system";
  const docsUrl =
    platform === "darwin"
      ? DOCKER_DESKTOP_MAC_URL
      : platform === "win32"
        ? DOCKER_DESKTOP_WIN_URL
        : null;

  return (
    <>
      <SetupStatusCard
        tone="info"
        word="Missing"
        title="Docker CLI not found"
        detail={`Vex needs Docker Desktop on ${platformLabel}.`}
      />

      <p className="vex-fr-text">
        If Docker is installed, enable Docker Desktop&apos;s CLI symlinks
        (Settings → Advanced) or reinstall Docker Desktop, then click Recheck.
      </p>

      <ol className="vex-fr-steps">
        <li>Click Download installer (Vex fetches the official build for you).</li>
        <li>Run the installer with admin privileges.</li>
        <li>Launch Docker Desktop.</li>
        <li>Click Recheck below.</li>
      </ol>

      <div className="vex-fr-acts">
        <div className="vex-fr-row">
          <Button disabled={installing} onClick={onInstall} className="w-[260px] max-w-full">
            {installing ? "Downloading…" : "Download installer"}
          </Button>
          {recheck}
        </div>
        <div className="vex-fr-row vex-fr-row--links">
          {docsUrl ? (
            <DocsLink href={docsUrl} label="View official Docker Desktop docs" />
          ) : null}
          <OpenLogsLink className="vex-fr-link" />
        </div>
      </div>
    </>
  );
}
