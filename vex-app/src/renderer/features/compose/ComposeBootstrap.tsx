/**
 * Compose bootstrap surface — the "Starting services" slide on the
 * cobalt continuum. Runs `composeUpAbortable`, parses the streamed log
 * lines into per-service substate, dispatches to the right branch body
 * based on the IPC result kind, and (on success) lets the user
 * continue to the migrations screen.
 *
 * Visual system (Chronos rebrand, AMENDMENT A2): `SetupFrame` paints
 * the SetupGate plate, a serif "Starting services" title sits above
 * one ink-glass card. The running branch is the VexLoader hero above
 * the two service rows; terminal branches are quiet status stanzas
 * with paper-pill actions. Per-branch render delegates to the body
 * components in `bootstrap/branches/`.
 *
 * Cancellation contract (PR3 — `vex:cancel` IPC) is preserved verbatim:
 * the Cancel button calls the `cancel` handle returned by
 * `composeUpAbortable`. We DO NOT call cancel() from the effect cleanup
 * function — React StrictMode double-mount would race the cancel
 * against the main-process single-flight join. The cleanup `cancelled`
 * flag only suppresses stale promise resolutions; user-initiated
 * cancellation goes through the button. Tests in
 * `__tests__/ComposeBootstrap.test.tsx` pin this contract.
 *
 * Log parser is COSMETIC ONLY (codex plan v2): it feeds per-service
 * substate but never flips the orchestrator phase — phase transitions
 * are driven solely by the IPC `ComposeUpResult.kind` discriminator.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposeLog } from "@shared/schemas/docker.js";

import { useUiStore } from "../../stores/uiStore.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { Button } from "../../components/ui/button.js";
import { COMPOSE_LOG_BUFFER_MAX } from "./bootstrap/constants.js";
import type { Phase } from "./bootstrap/types.js";
import {
  parseComposeLog,
  type ParsedLogEvent,
} from "./bootstrap/parseComposeLog.js";
import { useAggregatedServiceState } from "./bootstrap/useAggregatedServiceState.js";
import { RunningBody } from "./bootstrap/branches/RunningBody.js";
import { ReadyBody } from "./bootstrap/branches/ReadyBody.js";
import { PortCollisionBody } from "./bootstrap/branches/PortCollisionBody.js";
import { ForeignListenerBody } from "./bootstrap/branches/ForeignListenerBody.js";
import { UnhealthyBody } from "./bootstrap/branches/UnhealthyBody.js";
import { FailedBody } from "./bootstrap/branches/FailedBody.js";
import { CancelledBody } from "./bootstrap/branches/CancelledBody.js";
import { useStopPreviousInstallStacks } from "../../lib/api/docker.js";

export function ComposeBootstrap(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const [logs, setLogs] = useState<ReadonlyArray<ComposeLog>>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "running" });
  const [retryToken, setRetryToken] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);
  const stopPreviousInstall = useStopPreviousInstallStacks();

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "running" });

    const invocation = window.vex.docker.composeUpAbortable({});
    cancelRef.current = invocation.cancel;

    void (async () => {
      try {
        const result = await invocation.promise;
        if (cancelled) return;
        if (!result.ok) {
          if (result.error.code === "internal.cancelled") {
            setPhase({ kind: "error.cancelled" });
          } else {
            setPhase({
              kind: "error.failed",
              message: result.error.message,
            });
          }
          return;
        }
        const data = result.data;
        switch (data.kind) {
          case "running":
          case "reused":
            setPhase({ kind: "ready", result: data });
            return;
          case "port_collision":
            setPhase({
              kind: "error.port_collision",
              message: data.message,
              previousInstallHoldingPorts:
                data.previousInstallHoldingPorts,
            });
            return;
          case "foreign_listener":
            setPhase({
              kind: "error.foreign_listener",
              message: data.message,
            });
            return;
          case "unhealthy":
            setPhase({ kind: "error.unhealthy", message: data.message });
            return;
          case "failed":
            setPhase({ kind: "error.failed", message: data.message });
            return;
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setPhase({
          kind: "error.failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    })();

    return () => {
      cancelled = true;
      // Intentionally NOT calling invocation.cancel() — StrictMode
      // double-mount race; user-initiated cancellation goes through
      // the button handler. See header comment.
      cancelRef.current = null;
    };
  }, [retryToken]);

  useEffect(() => {
    const off = window.vex.docker.onComposeLog((payload) => {
      setLogs((prev) =>
        [...prev, payload].slice(-COMPOSE_LOG_BUFFER_MAX),
      );
    });
    return () => off();
  }, []);

  const parsedEvents = useMemo<readonly ParsedLogEvent[]>(() => {
    const out: ParsedLogEvent[] = [];
    for (const log of logs) {
      const parsed = parseComposeLog(log.line);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }, [logs]);

  const services = useAggregatedServiceState(parsedEvents);

  const handleRetry = useCallback((): void => {
    setLogs([]);
    setRetryToken((n) => n + 1);
  }, []);

  const handleStopPreviousInstall = useCallback((): void => {
    stopPreviousInstall.mutate(undefined, {
      onSuccess: (result) => {
        if (result.ok) handleRetry();
      },
    });
  }, [handleRetry, stopPreviousInstall]);

  const handleCancel = useCallback((): void => {
    const cancel = cancelRef.current;
    if (cancel === null) return;
    setPhase({ kind: "cancelling" });
    cancel();
  }, []);

  const handleContinue = useCallback((): void => {
    setCurrentView("migrations");
  }, [setCurrentView]);

  const recentLogLines = useMemo<readonly string[]>(
    () => logs.map((l) => l.line),
    [logs],
  );

  return (
    <SetupFrame
      screen="composeBootstrap"
      maxWidth="lg"
      title="Starting services"
      subline="Postgres and embeddings are coming up locally through Docker."
    >
      {/* THE BODY — the active phase, directly on the plate (AMENDMENT
       * A3: the container card and its inner scroll well are retired;
       * the page column scrolls). */}
      <div className="vex-rise vex-rise-d1">
          {phase.kind === "running" || phase.kind === "cancelling" ? (
            <RunningBody
              services={services}
              onCancel={handleCancel}
              cancelling={phase.kind === "cancelling"}
            />
          ) : phase.kind === "ready" ? (
            <ReadyBody result={phase.result} />
          ) : phase.kind === "error.port_collision" ? (
            <PortCollisionBody
              message={phase.message}
              previousInstallHoldingPorts={
                phase.previousInstallHoldingPorts
              }
              stoppingPreviousInstall={stopPreviousInstall.isPending}
              stopPreviousInstallError={
                stopPreviousInstall.data?.ok === false
                  ? stopPreviousInstall.data.error.message
                  : (stopPreviousInstall.error?.message ?? null)
              }
              onStopPreviousInstall={handleStopPreviousInstall}
              onRetry={handleRetry}
            />
          ) : phase.kind === "error.foreign_listener" ? (
            <ForeignListenerBody
              message={phase.message}
              onRetry={handleRetry}
            />
          ) : phase.kind === "error.unhealthy" ? (
            <UnhealthyBody message={phase.message} onRetry={handleRetry} />
          ) : phase.kind === "error.failed" ? (
            <FailedBody
              message={phase.message}
              recentLogs={recentLogLines}
              onRetry={handleRetry}
            />
          ) : phase.kind === "error.cancelled" ? (
            <CancelledBody onRetry={handleRetry} />
          ) : null}
      </div>

      {/* FOOTER — the paper-pill Continue appears only when the stack
       * is ready (body CTAs carry the action everywhere else). */}
      {phase.kind === "ready" ? (
        <div className="vex-rise vex-rise-d2 mt-6 flex justify-center">
          <Button
            size="lg"
            className="min-w-[208px]"
            onClick={handleContinue}
            aria-label="Continue to database migrations"
          >
            Continue
          </Button>
        </div>
      ) : null}
    </SetupFrame>
  );
}
