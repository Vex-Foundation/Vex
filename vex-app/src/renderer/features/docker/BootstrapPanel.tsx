/**
 * Docker bootstrap orchestrator — the Docker slide on the cobalt
 * continuum (Chronos rebrand, AMENDMENT A2): `SetupFrame` paints the
 * SetupGate plate, a serif "Docker" title sits above one ink-glass
 * card holding the active branch body, and the footer carries exactly
 * one CTA per state — the paper-pill Continue (branch A) or the quiet
 * ghost Recheck (everywhere else).
 *
 * Branch dispatch lives here; the per-branch render is delegated to
 * the body components in `bootstrap/branches/`. Shared visual
 * primitives (SetupStatusCard, DocsLink) live in `components/onboarding/`.
 *
 * State machine (unchanged):
 *   loading     — Docker probe in flight, OR engine missing + platform
 *                 still resolving (data wins when platform irrelevant).
 *   A           — engine + daemon running → ReadyBody + Continue.
 *   B           — engine present + daemon stopped → DaemonStoppedBody;
 *                 per-platform copy (Linux shows `sudo systemctl start`
 *                 because the main process only attempts the user-mode
 *                 Docker Desktop unit, never sudo).
 *   C-desktop   — mac/win, Docker CLI missing → DesktopInstallBody (in-app
 *                 installer download via LicenseNotice — the license
 *                 dialog ALWAYS precedes any download IPC).
 *   C-linux     — linux, engine missing → LinuxInstallBody (auto-fetch
 *                 `linux_manual_instructions` IPC).
 *   D           — IPC/Result error, endpoint rejected, or version probe
 *                 failure → FailureBody.
 *
 * Recheck (footer, always visible non-A) calls `dockerStatus.refetch()`
 * so the user never has to restart the app after fixing Docker.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  useDockerInstall,
  useDockerStart,
  useDockerStatus,
} from "../../lib/api/docker.js";
import { useSystemHealth } from "../../lib/api/system.js";
import { useUiStore } from "../../stores/uiStore.js";
import { InstallProgressStrip } from "./InstallProgress.js";
import { LicenseNotice } from "./LicenseNotice.js";
import type {
  ActiveInstallMethod,
  Branch,
  ManualFetchState,
} from "./bootstrap/types.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { Button } from "../../components/ui/button.js";
import { LoadingBody } from "./bootstrap/branches/LoadingBody.js";
import { ReadyBody } from "./bootstrap/branches/ReadyBody.js";
import { DaemonStoppedBody } from "./bootstrap/branches/DaemonStoppedBody.js";
import { DesktopInstallBody } from "./bootstrap/branches/DesktopInstallBody.js";
import { LinuxInstallBody } from "./bootstrap/branches/LinuxInstallBody.js";
import { FailureBody } from "./bootstrap/branches/FailureBody.js";

export function BootstrapPanel(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const dockerStatus = useDockerStatus();
  const systemHealth = useSystemHealth();
  const installMutation = useDockerInstall();
  const startMutation = useDockerStart();

  const [licenseOpen, setLicenseOpen] = useState(false);
  const [activeInstallMethod, setActiveInstallMethod] =
    useState<ActiveInstallMethod>(null);
  const [manualFetchState, setManualFetchState] = useState<ManualFetchState>({
    kind: "idle",
  });
  const manualFetchRequestedRef = useRef(false);

  const platform = systemHealth.data?.ok
    ? systemHealth.data.data.os.platform
    : null;
  const branch = decideBranch(
    dockerStatus.data,
    platform,
    systemHealth.isPending,
  );

  // Single source of truth for the Linux manual-instructions IPC call.
  // Called both from the auto-fetch effect (on C-linux mount) and from
  // the explicit "Retry instructions fetch" handler (codex post-impl
  // SHOULD-FIX #1 — bare ref reset didn't re-trigger the effect because
  // neither `branch` nor `installMutation` changed).
  const fetchLinuxInstructions = useCallback(() => {
    manualFetchRequestedRef.current = true;
    setActiveInstallMethod("linux_manual_instructions");
    setManualFetchState({ kind: "loading" });
    installMutation.mutate(
      { method: "linux_manual_instructions" },
      {
        onSuccess: (data) => {
          if (data.ok && data.data.fallbackInstructions !== null) {
            setManualFetchState({
              kind: "ready",
              instructions: data.data.fallbackInstructions,
            });
          } else {
            setManualFetchState({
              kind: "error",
              message: data.ok
                ? "No instructions returned"
                : data.error.message,
            });
          }
        },
        onError: (err) => {
          setManualFetchState({
            kind: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        },
        onSettled: () => {
          setActiveInstallMethod(null);
        },
      },
    );
  }, [installMutation]);

  // Auto-fetch on entering C-linux. `manualFetchRequestedRef` guards
  // against effect re-runs while a fetch is in flight. Explicit retry
  // calls `fetchLinuxInstructions` directly so the effect deps don't
  // need to change.
  useEffect(() => {
    if (branch !== "C-linux") return;
    if (manualFetchRequestedRef.current) return;
    fetchLinuxInstructions();
  }, [branch, fetchLinuxInstructions]);

  const handleContinue = useCallback(() => {
    setCurrentView("composeBootstrap");
  }, [setCurrentView]);

  const handleStart = useCallback(() => {
    startMutation.mutate(undefined, {
      onSettled: () => {
        void dockerStatus.refetch();
      },
    });
  }, [startMutation, dockerStatus]);

  const handleDesktopInstall = useCallback(() => {
    setLicenseOpen(true);
  }, []);

  const handleLicenseAccepted = useCallback(() => {
    setLicenseOpen(false);
    setActiveInstallMethod("desktop_download");
    installMutation.mutate(
      { method: "desktop_download" },
      {
        onSettled: () => {
          setActiveInstallMethod(null);
          void dockerStatus.refetch();
        },
      },
    );
  }, [installMutation, dockerStatus]);

  const handleLicenseDismiss = useCallback(() => {
    setLicenseOpen(false);
  }, []);

  const handleRecheck = useCallback(() => {
    void dockerStatus.refetch();
  }, [dockerStatus]);

  const handleRetryInstructionsFetch = useCallback(() => {
    fetchLinuxInstructions();
  }, [fetchLinuxInstructions]);

  const showInstallProgress =
    activeInstallMethod === "desktop_download" && installMutation.isPending;
  // Disable Recheck while any probe/mutation is in flight, OR while the
  // branch is "loading" (which covers `systemHealth.isPending` cases
  // where dockerStatus may not be fetching but platform is still
  // resolving). Codex post-impl SHOULD-FIX #2.
  const recheckDisabled =
    installMutation.isPending ||
    startMutation.isPending ||
    dockerStatus.isFetching ||
    branch === "loading";

  return (
    <SetupFrame
      screen="dockerBootstrap"
      maxWidth="lg"
      title="Docker"
      subline="Vex runs Postgres and embeddings locally through Docker."
    >
      {/* THE BODY — the active branch, directly on the plate (AMENDMENT
       * A3: the container card and its inner scroll well are retired;
       * the page column scrolls, so long Linux instructions scroll the
       * page, not a well). */}
      <div className="vex-rise vex-rise-d1">
          {showInstallProgress ? (
            <InstallProgressStrip active />
          ) : branch === "loading" ? (
            <LoadingBody />
          ) : branch === "A" ? (
            <ReadyBody
              status={dockerStatus.data?.ok ? dockerStatus.data.data : null}
            />
          ) : branch === "B" ? (
            <DaemonStoppedBody
              platform={platform}
              starting={startMutation.isPending}
              startMessage={
                startMutation.data?.ok
                  ? startMutation.data.data.message ?? null
                  : null
              }
              onStart={handleStart}
            />
          ) : branch === "C-desktop" ? (
            <DesktopInstallBody
              platform={platform}
              installing={installMutation.isPending}
              onInstall={handleDesktopInstall}
            />
          ) : branch === "C-linux" ? (
            <LinuxInstallBody
              state={manualFetchState}
              onRetryFetch={handleRetryInstructionsFetch}
            />
          ) : (
            <FailureBody status={dockerStatus.data} />
          )}
      </div>

      {/* FOOTER — one CTA per state: paper-pill Continue on branch A,
       * quiet ghost Recheck everywhere else. */}
      <div className="vex-rise vex-rise-d2 mt-6 flex justify-center">
        {branch === "A" ? (
          <Button
            size="lg"
            className="min-w-[208px]"
            onClick={handleContinue}
            aria-label="Continue to services startup"
          >
            Continue
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="lg"
            className="min-w-[208px] text-[var(--color-text-secondary)]"
            onClick={handleRecheck}
            disabled={recheckDisabled}
          >
            Recheck
          </Button>
        )}
      </div>

      <LicenseNotice
        open={licenseOpen}
        onAccept={handleLicenseAccepted}
        onDismiss={handleLicenseDismiss}
      />
    </SetupFrame>
  );
}

function decideBranch(
  result: ReturnType<typeof useDockerStatus>["data"],
  platform: string | null,
  platformPending: boolean,
): Branch {
  if (!result) return "loading";
  if (!result.ok) return "D";
  const status = result.data;
  if (!status.endpoint.accepted) return "D";
  if (!status.engine.present && status.engine.failure === "probe_error") {
    return "D";
  }

  // A — data wins when platform irrelevant; don't flicker to loading
  // while the health probe is pending (codex round 11 SHOULD-FIX #2).
  if (status.engine.present && status.daemon.running) return "A";

  // Below: platform matters (B copy varies by OS; C dispatches per OS).
  if (status.engine.present && !status.daemon.running) {
    if (platformPending) return "loading";
    return "B";
  }
  if (!status.engine.present) {
    if (platformPending) return "loading";
    if (platform === "darwin" || platform === "win32") return "C-desktop";
    if (platform === "linux") return "C-linux";
  }
  return "D";
}
