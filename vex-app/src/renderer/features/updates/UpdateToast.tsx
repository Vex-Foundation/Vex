/**
 * Bottom-right update toast (M13 redesign) — replaces the retired top
 * `UpdateBanner` + `UpdateModal`. Presentational: renders the current
 * `UpdateStatus` and calls back into `UpdateLayer` for every action. Anchored
 * `fixed bottom-4 right-4`; the production build never shows `DevDiagnostics`
 * in that corner (DEV-only, see App.tsx), so the toast owns it outright.
 *
 * Design law (shell rebrand): solid ink card (`bg-card` / `--vex-surface-1`),
 * hairline `border-border` (`--vex-line-strong`), mono-uppercase title, cobalt
 * `--vex-accent` primary CTA via the shared `Button` component's `default`
 * variant. NO glass/backdrop-blur, NO resting glow, NO raw hex — Tailwind
 * semantic tokens only. `.vex-rise` entrance; the global reduced-motion rule
 * in globals.css collapses every animation to ~instant, so no extra
 * media-query handling is needed here. The ONLY inline style is the download
 * progress-bar width — CSP-safe per MOTION-POLICY.md (a CSSOM property
 * assignment via React's `style` prop, not a parsed inline-style string).
 */

import { useEffect, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowUp01Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
} from "@hugeicons/core-free-icons";
import type { UpdateStatus } from "@shared/schemas/updater.js";
import { Button } from "../../components/ui/button.js";

/** The five states that render a toast; `current/checking/idle` render nothing. */
export type ToastableUpdateStatus = Extract<
  UpdateStatus,
  {
    kind:
      | "available"
      | "downloading"
      | "downloaded"
      | "blockedByOperation"
      | "error";
  }
>;

const TOAST_KINDS: ReadonlySet<UpdateStatus["kind"]> = new Set([
  "available",
  "downloading",
  "downloaded",
  "blockedByOperation",
  "error",
]);

export function isToastKind(
  status: UpdateStatus,
): status is ToastableUpdateStatus {
  return TOAST_KINDS.has(status.kind);
}

/** `severity` is a UX-only convention (sanitize.ts), not a security signal. */
function isCritical(status: ToastableUpdateStatus): boolean {
  return "severity" in status && status.severity === "critical";
}

interface UpdateToastProps {
  readonly status: ToastableUpdateStatus;
  readonly busy: boolean;
  /** Renderer-local per-version snooze (available/downloaded only). */
  readonly onLater: () => void;
  readonly onUpdateNow: () => void;
  readonly onCancel: () => void;
  readonly onRestart: () => void;
  /** Re-invokes the blocked action (blockedByOperation) or re-checks (error). */
  readonly onTryAgain: () => void;
  readonly onReleaseNotes: () => void;
  readonly onDismissError: () => void;
}

export function UpdateToast({
  status,
  busy,
  onLater,
  onUpdateNow,
  onCancel,
  onRestart,
  onTryAgain,
  onReleaseNotes,
  onDismissError,
}: UpdateToastProps): JSX.Element {
  const critical = isCritical(status);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (status.kind === "error") {
        event.preventDefault();
        onDismissError();
        return;
      }
      if (
        (status.kind === "available" && !critical) ||
        status.kind === "downloaded"
      ) {
        event.preventDefault();
        onLater();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [status, critical, onDismissError, onLater]);

  return (
    <div
      className="vex-rise fixed bottom-4 right-4 z-[60] w-80 max-w-[90vw] rounded-lg border border-border bg-card p-4 text-foreground"
      data-vex-screen="updateToast"
      role={critical ? "alert" : "status"}
      aria-label={`${titleFor(status)}. ${bodyFor(status)}`}
    >
      <div className="flex items-start gap-2">
        <ToastIcon status={status} />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em]">
            {titleFor(status)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {bodyFor(status)}
          </p>
          {status.kind === "available" && status.summary ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {status.summary}
            </p>
          ) : null}
          {status.kind === "downloading" ? (
            <ToastProgress percent={status.percent} />
          ) : null}
        </div>
        {status.kind === "error" ? (
          <button
            type="button"
            aria-label="Dismiss update notification"
            onClick={onDismissError}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {renderActions(status, {
          busy,
          onLater,
          onUpdateNow,
          onCancel,
          onRestart,
          onTryAgain,
          onReleaseNotes,
        })}
      </div>
    </div>
  );
}

interface ToastActions {
  readonly busy: boolean;
  readonly onLater: () => void;
  readonly onUpdateNow: () => void;
  readonly onCancel: () => void;
  readonly onRestart: () => void;
  readonly onTryAgain: () => void;
  readonly onReleaseNotes: () => void;
}

function renderActions(
  status: ToastableUpdateStatus,
  a: ToastActions,
): JSX.Element {
  switch (status.kind) {
    case "available":
      return (
        <>
          <Button
            variant="link"
            size="sm"
            className="mr-auto px-0"
            onClick={a.onReleaseNotes}
          >
            Release notes
          </Button>
          {!isCritical(status) ? (
            <Button variant="ghost" size="sm" onClick={a.onLater}>
              Later
            </Button>
          ) : null}
          <Button size="sm" onClick={a.onUpdateNow} disabled={a.busy}>
            Update now
          </Button>
        </>
      );
    case "downloading":
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={a.onCancel}
          disabled={a.busy}
        >
          Cancel
        </Button>
      );
    case "downloaded":
      return (
        <>
          <Button variant="ghost" size="sm" onClick={a.onLater}>
            Later
          </Button>
          <Button size="sm" onClick={a.onRestart} disabled={a.busy}>
            Restart &amp; install
          </Button>
        </>
      );
    case "blockedByOperation":
      return (
        <Button size="sm" onClick={a.onTryAgain} disabled={a.busy}>
          Try again
        </Button>
      );
    case "error":
      return (
        <>
          <Button
            variant="link"
            size="sm"
            className="mr-auto px-0"
            onClick={a.onReleaseNotes}
          >
            Open download page
          </Button>
          <Button size="sm" onClick={a.onTryAgain} disabled={a.busy}>
            Try again
          </Button>
        </>
      );
  }
}

function titleFor(status: ToastableUpdateStatus): string {
  switch (status.kind) {
    case "available":
      return isCritical(status)
        ? `Critical update — Vex ${status.latestVersion}`
        : `Vex ${status.latestVersion} available`;
    case "downloading":
      return `Downloading Vex ${status.latestVersion}`;
    case "downloaded":
      return "Ready to install";
    case "blockedByOperation": {
      const step = status.blockedAction === "install" ? "Install" : "Download";
      return isCritical(status) ? `Critical update — ${step.toLowerCase()} blocked` : `${step} blocked`;
    }
    case "error":
      return "Update failed";
  }
}

function bodyFor(status: ToastableUpdateStatus): string {
  switch (status.kind) {
    case "available":
      return "Downloads the update now. Restart whenever you're ready.";
    case "downloading":
      return `${Math.round(status.percent)}% complete.`;
    case "downloaded":
      return `Vex ${status.latestVersion} is ready. Restart to finish installing.`;
    case "blockedByOperation":
      return status.reason;
    case "error":
      return status.message;
  }
}

function ToastIcon({
  status,
}: {
  readonly status: ToastableUpdateStatus;
}): JSX.Element {
  if (status.kind === "downloading") {
    return (
      <span
        aria-hidden
        className="vex-pulse-dot mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
      />
    );
  }
  if (status.kind === "downloaded") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        size={14}
        className="mt-0.5 shrink-0 text-primary"
        aria-hidden
      />
    );
  }
  if (status.kind === "blockedByOperation" || status.kind === "error") {
    return (
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={14}
        className="mt-0.5 shrink-0 text-destructive"
        aria-hidden
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ArrowUp01Icon}
      size={14}
      className="mt-0.5 shrink-0 text-primary"
      aria-hidden
    />
  );
}

function ToastProgress({
  percent,
}: {
  readonly percent: number;
}): JSX.Element {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-primary transition-[width] duration-150 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
