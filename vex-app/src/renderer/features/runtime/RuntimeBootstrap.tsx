/**
 * Runtime bootstrap surface: the "Preparing local runtime" page on the
 * pre-shell stage, shown only on the native runtime. Main starts the runtime
 * at boot (plan D8); this screen only watches it: the database, the
 * embeddings model (downloaded once, on the first run) and the embeddings
 * server, as three rows with live state. Setup does not continue until all
 * three are ready (D14); then the screen advances to the migrations on its
 * own after a short confirmation, the way an up-to-date schema does.
 *
 * Visual system: the same `SetupFrame` leaf as the container bootstrap it
 * replaces on this runtime. In flight, the VexLoader hero sits above the
 * rows; settled, the rows stay as the record of what happened, above a ready
 * stanza or the failure branch for the failed step's kind.
 *
 * There is no Cancel: nothing here can continue without the runtime, and a
 * download left by quitting resumes on the next start.
 */

import { useEffect, useMemo, type JSX } from "react";

import { useUiStore } from "../../stores/uiStore.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { SetupStatusCard } from "../../components/onboarding/SetupStatusCard.js";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { READY_AUTO_ADVANCE_MS } from "./bootstrap/constants.js";
import { FailureBody } from "./bootstrap/FailureBody.js";
import { StepRows } from "./bootstrap/StepRows.js";
import { stepRows } from "./bootstrap/steps.js";
import { useNativeRuntimeStatus } from "./bootstrap/useNativeRuntimeStatus.js";

export function RuntimeBootstrap(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const { status, retry } = useNativeRuntimeStatus();
  const rows = useMemo(() => stepRows(status), [status]);
  const phase = status?.phase ?? null;

  useEffect(() => {
    if (phase !== "ready") return;
    const timer = window.setTimeout(() => setCurrentView("migrations"), READY_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, setCurrentView]);

  return (
    <SetupFrame
      screen="runtimeBootstrap"
      title="Preparing local runtime"
      subline="Your database and embeddings run on this computer. The first run downloads the embeddings model once."
    >
      <div className="vex-rise vex-rise-d1 flex flex-col gap-6">
        {phase !== "ready" && phase !== "failed" ? (
          <div className="flex pt-2">
            <VexLoader size={40} stroke={2} label="Preparing local runtime" />
          </div>
        ) : null}

        <StepRows rows={rows} />

        {status?.phase === "ready" ? (
          <SetupStatusCard
            tone="ok"
            word="Ready"
            title="Local runtime ready"
            detail="Advancing to the database…"
          />
        ) : status?.phase === "failed" ? (
          <FailureBody kind={status.kind} step={status.step} message={status.message} onRetry={retry} />
        ) : null}
      </div>
    </SetupFrame>
  );
}
