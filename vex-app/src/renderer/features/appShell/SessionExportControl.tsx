/**
 * Markdown export control — the status strip's right-edge key.
 *
 * Moved verbatim out of `SessionContext` (session-UI redesign, owner decree
 * 2026-07-29): the session register line it used to sit on is gone — the
 * session title now lives only in the left rail — so the export key relocated
 * to the trailing edge of the thin status strip above the chat column.
 *
 * The FLOW IS UNCHANGED and deliberately so: clicking opens
 * `SessionExportDialog` (the privacy-contract confirmation) rather than
 * exporting immediately, and the mutation fires only after that confirmation.
 * A native-dialog cancellation (`outcome === "cancelled"`) stays silent per
 * the export's cancellation contract; a save or a failure announces itself in
 * the polite live region for ~2.5s. Renders nothing without a resolved
 * session — there is nothing to export.
 *
 * It resolves the session itself through `useSession` rather than taking it as
 * a prop: the header mounts outside the session panel's tree, and the query
 * key is the one `SessionPanel` already mounts, so this costs no extra IPC.
 */

import { useEffect, useState, type JSX } from "react";
import {
  CircleCheckBigIcon,
  DownloadIcon,
  VexIcon,
} from "../../components/icons/index.js";
import { useExportSessionMarkdown, useSession } from "../../lib/api/sessions.js";
import { SessionExportDialog } from "./SessionExportDialog.js";

const STATUS_CLEAR_MS = 2_500;

export function SessionExportControl({
  activeSessionId,
}: {
  readonly activeSessionId: string | null;
}): JSX.Element | null {
  const detailQuery = useSession(activeSessionId);
  const exportMutation = useExportSessionMarkdown();
  const [exportStatus, setExportStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);

  useEffect(() => {
    if (exportStatus === "idle") return;
    const timeout = window.setTimeout(
      () => setExportStatus("idle"),
      STATUS_CLEAR_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [exportStatus]);

  const detail = detailQuery.data;
  const activeSession =
    activeSessionId !== null && detail !== undefined && detail.ok
      ? detail.data
      : null;

  if (activeSession === null) return null;

  function confirmExport(): void {
    if (activeSession === null) return;
    setExportStatus("idle");
    exportMutation.mutate(
      { id: activeSession.id },
      {
        onSuccess: (result) => {
          setExportConfirmOpen(false);
          if (result.ok && result.data.outcome === "saved") {
            setExportStatus("saved");
          } else if (!result.ok) {
            setExportStatus("error");
          }
          // `result.ok && outcome === "cancelled"` (native dialog dismissed)
          // stays idle and silent per the export's cancellation contract.
        },
        onError: () => {
          setExportConfirmOpen(false);
          setExportStatus("error");
        },
      },
    );
  }

  return (
    <>
      <span
        aria-live="polite"
        className="vex-micro text-[9px] text-[var(--vex-text-3)]"
      >
        {exportStatus === "saved"
          ? "Exported"
          : exportStatus === "error"
            ? "Export failed"
            : ""}
      </span>
      <button
        type="button"
        aria-label="Export session as Markdown"
        title="Export session as Markdown"
        disabled={exportMutation.isPending}
        onClick={() => setExportConfirmOpen(true)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--vex-text-3)] transition-colors hover:bg-[var(--vex-surface-2)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vex-accent)] disabled:cursor-wait disabled:opacity-50"
      >
        <VexIcon
          icon={exportStatus === "saved" ? CircleCheckBigIcon : DownloadIcon}
          size={15}
          aria-hidden
          className={exportMutation.isPending ? "animate-pulse" : undefined}
        />
      </button>
      <SessionExportDialog
        session={exportConfirmOpen ? activeSession : null}
        pending={exportMutation.isPending}
        onCancel={() => setExportConfirmOpen(false)}
        onConfirm={confirmExport}
      />
    </>
  );
}
