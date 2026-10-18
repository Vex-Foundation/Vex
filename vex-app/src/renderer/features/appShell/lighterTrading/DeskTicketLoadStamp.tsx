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
      className="inline-flex min-h-[28px] shrink-0 items-center font-sans text-[13px] font-medium text-accent-primary hover:underline hover:underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {/* The tool row's link register (docs/design/R3-MINIMAL.md section 6):
          a blue 13 / 500 word in sentence case, no frame, underlined on hover. */}
      Load into ticket
    </button>
  );
}
