/**
 * Render the docker.com apt-repo bootstrap as a copy-paste block.
 * `instructions` arrives from the main process so we don't ship the
 * exact command list in the renderer bundle (privacy + bundle size).
 *
 * Visual: the first run's log block (the figure face on the second paper behind a
 * quiet rule, `docs/design/R3-MINIMAL.md section 10.3`), embedded into the BootstrapPanel's
 * C-linux body. The Copy key writes to the system clipboard via
 * `navigator.clipboard.writeText()` with visible "Copied" / "Copy failed"
 * feedback per codex post-v3 SHOULD-FIX.
 *
 * Recheck lives in the orchestrator's actions (single source of truth for
 * the rerun action - codex post-impl SHOULD-FIX #3 removed the
 * duplicate inner button here).
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import { Button } from "../../components/ui/button.js";
import { LineCopy } from "../../components/icons/line/index.js";

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
  // blocking cleanup - mirrors the AddressDisplay pattern).
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
    <div className="flex w-full flex-col gap-3">
      <pre className="vex-fr-code">
        <code>{instructions}</code>
      </pre>
      <div>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => void handleCopy()}
          aria-label="Copy install commands to clipboard"
        >
          <LineCopy size={14} />
          <span aria-live="polite">{copyLabel}</span>
        </Button>
      </div>

      <p className="vex-fr-text">
        After install: log out and back in (or reboot) so your user joins the{" "}
        <code className="font-code text-ink-primary">docker</code> group, then
        click Recheck below.
      </p>
    </div>
  );
}
