/**
 * Markdown export control: a page key at the head of the title bar's right
 * cluster (docs/design/R3-MINIMAL.md section 3), a 32 x 32 icon key with the
 * line download icon, and its status word beside it.
 *
 * Moved out of `SessionContext` (session-UI redesign, owner decree
 * 2026-07-29): the session register line it used to sit on is gone, so the
 * export key lives in the title bar above the chat column.
 *
 * The FLOW IS UNCHANGED and deliberately so: clicking opens
 * `SessionExportDialog` (the privacy-contract confirmation) rather than
 * exporting immediately, and the mutation fires only after that confirmation.
 * A native-dialog cancellation (`outcome === "cancelled"`) stays silent per
 * the export's cancellation contract; a save or a failure announces itself in
 * the polite live region for ~2.5s. Renders nothing without a resolved
 * session: there is nothing to export.
 *
 * It resolves the session itself through `useSession` rather than taking it as
 * a prop: the header mounts outside the session panel's tree, and the query
 * key is the one `SessionPanel` already mounts, so this costs no extra IPC.
 */

import { useEffect, useState, type JSX } from "react";
import { LineCheck, LineDownload } from "../../components/icons/line/index.js";
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

  const ExportGlyph = exportStatus === "saved" ? LineCheck : LineDownload;

  return (
    <>
      <span aria-live="polite" className="vex-tb-key-status">
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
        className="vex-tb-key"
      >
        <ExportGlyph />
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
