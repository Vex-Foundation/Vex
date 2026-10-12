/**
 * "Load into ticket" on a `lighter__order_preview` row (design §7.4): the
 * agent priced an order, the trader edits it in the ticket before review.
 * Renders nothing outside the desk or on args the ticket cannot fill.
 */

import { useMemo, type JSX } from "react";
import { useUiStore } from "../../../stores/uiStore.js";
import type { ToolCallActView } from "../transcriptRowModel.js";
import { parseDeskTicketLoad, useDeskTicketLoadStore } from "./desk-ticket-load.js";

export function DeskTicketLoadStamp({ act }: { readonly act: ToolCallActView }): JSX.Element | null {
  const onDesk = useUiStore((state) => state.runtimeMode === "lighter");
  const publish = useDeskTicketLoadStore((state) => state.publishDeskTicketLoad);
  const load = useMemo(
    () => (onDesk ? parseDeskTicketLoad(act.toolName, act.toolArgs) : null),
    [act.toolArgs, act.toolName, onDesk],
  );
  if (load === null) return null;
  return (
    <button
      type="button"
      data-vex-desk-ticket-load=""
      aria-label="Load this order preview into the trade ticket"
      onClick={() => publish(load)}
      className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {/* A V10 stamp: Departure Mono 11px caps, the blue word in a blue frame. */}
      <span className="inline-flex h-[22px] items-center border border-accent-primary px-2 font-mono text-[11px] uppercase tracking-chip text-accent-primary hover:bg-interactive-hover">
        Load into ticket
      </span>
    </button>
  );
}
