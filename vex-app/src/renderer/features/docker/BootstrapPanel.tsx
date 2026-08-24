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
 * State machine, driven by the `engine.state` discriminated union rather
 * than by collapsed booleans:
 *   loading     - Docker probe in flight, OR engine missing + platform
 *                 still resolving (data wins when platform irrelevant).
 *   A           - state `ready` → ReadyBody + Continue.
 *   B           - state `engine_stopped` / `engine_starting` → DaemonStoppedBody;
 *                 per-platform copy (Linux shows `sudo systemctl start`
 *                 because the main process only attempts the user-mode
 *                 Docker Desktop unit, never sudo).
 *   C-desktop   - mac/win, state `not_installed` → DesktopInstallBody (in-app
 *                 installer download via LicenseNotice - the license
 *                 dialog ALWAYS precedes any download IPC).
 *   C-linux     - linux, state `not_installed` → LinuxInstallBody (auto-fetch
 *                 `linux_manual_instructions` IPC).
 *   D           - IPC/Result error, endpoint rejected, engine socket
 *                 permission denied, or probe error → FailureBody.
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
  const engineState = dockerStatus.data?.ok
    ? dockerStatus.data.data.engine.state
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
              // The engine also counts as starting inside the bounded
              // window after Vex launched Docker, not only while the start
              // IPC is still in flight.
              starting={
                startMutation.isPending ||
                engineState?.kind === "engine_starting"
              }
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
            className="min-w-[208px] text-ink-secondary"
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

/**
 * Maps the authoritative `engine.state` union onto a rendered branch.
 * Branching on the union (rather than on `present` + `daemon.running`) is
 * what lets "not installed", "stopped", "starting" and "denied" reach
 * different screens instead of sharing one.
 */
function decideBranch(
  result: ReturnType<typeof useDockerStatus>["data"],
  platform: string | null,
  platformPending: boolean,
): Branch {
  if (!result) return "loading";
  if (!result.ok) return "D";
  const status = result.data;
  if (!status.endpoint.accepted) return "D";

  const state = status.engine.state;
  switch (state.kind) {
    // A - data wins when platform irrelevant; don't flicker to loading
    // while the health probe is pending (codex round 11 SHOULD-FIX #2).
    case "ready":
      return "A";
    case "error":
    case "permission_denied":
      return "D";
    // Below: platform matters (B copy varies by OS; C dispatches per OS).
    case "engine_stopped":
    case "engine_starting":
      return platformPending ? "loading" : "B";
    case "not_installed": {
      if (platformPending) return "loading";
      if (platform === "darwin" || platform === "win32") return "C-desktop";
      if (platform === "linux") return "C-linux";
      return "D";
    }
    default: {
      const exhaustive: never = state;
      void exhaustive;
      return "D";
    }
  }
}
