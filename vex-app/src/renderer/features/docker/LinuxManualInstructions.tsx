/**
 * Render the docker.com apt-repo bootstrap as a copy-paste block.
 * `instructions` arrives from the main process so we don't ship the
 * exact command list in the renderer bundle (privacy + bundle size).
 *
 * Visual: recessed (surface-down) terminal block behind a hairline —
 * no glass, no inset highlight — embedded into the BootstrapPanel's
 * C-linux body. Copy button writes to the system clipboard via
 * `navigator.clipboard.writeText()` with visible "Copied" /
 * "Copy failed" feedback per codex post-v3 SHOULD-FIX.
 *
 * Recheck lives in the orchestrator footer (single source of truth for
 * the rerun action — codex post-impl SHOULD-FIX #3 removed the
 * duplicate inner button here).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { cn } from "../../lib/utils.js";

interface LinuxManualInstructionsProps {
  readonly instructions: string;
}

type CopyState = "idle" | "ok" | "fail";

export function LinuxManualInstructions({
  instructions,
}: LinuxManualInstructionsProps): JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  // Track the most recent reset timer so rapid double-copy doesn't
  // stack timers and unmount clears the pending tick (codex non-
  // blocking cleanup — mirrors the AddressDisplay pattern).
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(instructions);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 2000);
  }, [instructions]);

  const copyLabel =
    copyState === "ok"
      ? "Copied"
      : copyState === "fail"
        ? "Copy failed"
        : "Copy";

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <pre className="max-h-72 overflow-auto rounded-lg border border-[var(--color-border)] bg-black/40 p-3 pr-12 text-xs leading-relaxed text-[var(--color-text-primary)]">
          <code className="font-mono">{instructions}</code>
        </pre>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="Copy install commands to clipboard"
          className={cn(
            "absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--vex-onboarding-bg,var(--color-bg-primary))] px-2.5 py-1 vex-micro text-[var(--color-text-primary)] transition-colors duration-150",
            "hover:border-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg-primary)]",
            copyState === "ok"
              ? "border-[color-mix(in_oklab,var(--color-success)_45%,transparent)] text-[var(--color-success)]"
              : copyState === "fail"
                ? "border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] text-[var(--color-danger)]"
                : "",
          )}
        >
          <HugeiconsIcon icon={Copy01Icon} size={12} aria-hidden />
          <span aria-live="polite">{copyLabel}</span>
        </button>
      </div>

      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
        After install: log out and back in (or reboot) so your user joins the{" "}
        <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[var(--color-text-primary)]">
          docker
        </code>{" "}
        group, then click Recheck below.
      </p>
    </div>
  );
}
