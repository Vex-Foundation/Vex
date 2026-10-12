/**
 * BookInspectPanel — the BOOK's inspect view for one tool call (A32/E13):
 * tool identity, status as word + Swatch, and the full arguments/result
 * payloads. Rendered by `BookPanel` while the inspect store holds a payload;
 * closing returns to the card stack (which stays mounted underneath).
 * Payloads render COMPLETE — scrolling, never truncation (owner decree).
 * The JSON view is a placeholder <pre>; it swaps to the shared JsonTree when
 * that primitive lands (board note, transcript owner's T7).
 */

import type { JSX } from "react";
import { PxIcon } from "../../../../components/icons/index.js";
import {
  Swatch,
  type SwatchState,
} from "../../../../components/ui/swatch.js";
import {
  useToolInspectStore,
  type ToolInspectPayload,
  type ToolInspectStatus,
} from "./inspect-store.js";

const STATUS_DOT: Record<ToolInspectStatus, SwatchState> = {
  pending: "warning",
  running: "ongoing",
  done: "done",
  error: "error",
};

const STATUS_WORD: Record<ToolInspectStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  error: "Failed",
};

/**
 * Pretty-print an unknown payload for the placeholder view. BigInt and
 * circular payloads must not crash the panel — they degrade to String().
 */
function stringifyPayload(value: unknown): string {
  if (value === undefined) return "-";
  try {
    return JSON.stringify(
      value,
      (_key, entry: unknown) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      2,
    );
  } catch {
    return String(value);
  }
}

export function BookInspectPanel({
  inspect,
}: {
  readonly inspect: ToolInspectPayload;
}): JSX.Element {
  const closeToolInspect = useToolInspectStore((s) => s.closeToolInspect);
  return (
    <section
      data-vex-area="book-inspect"
      aria-label={`Tool call: ${inspect.toolName}`}
      className="vex-bk__body gap-3 overflow-hidden pt-4"
    >
      <header className="vex-bs__h">
        <h3 className="vex-bs__t">
          Inspect
        </h3>
        <button
          type="button"
          aria-label="Close inspect"
          onClick={closeToolInspect}
          className="vex-bk__key ml-auto"
          style={{ minWidth: 20, height: 20 }}
        >
          <PxIcon name="close" />
        </button>
      </header>

      <div className="flex items-center justify-between gap-2">
        <span className="vex-bs__t min-w-0 truncate">
          {inspect.toolName}
        </span>
        <span className="vex-bs__m inline-flex shrink-0 items-center gap-1.5">
          <Swatch state={STATUS_DOT[inspect.status]} size={8} />
          {STATUS_WORD[inspect.status]}
        </span>
      </div>

      <div className="vex-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <PayloadSection label="Arguments" value={inspect.args} />
        {"result" in inspect && inspect.result !== undefined ? (
          <PayloadSection label="Result" value={inspect.result} />
        ) : null}
      </div>
    </section>
  );
}

function PayloadSection({
  label,
  value,
}: {
  readonly label: string;
  readonly value: unknown;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="vex-bs__k">
        {label}
      </span>
      <pre className="vex-bk__pre">
        {stringifyPayload(value)}
      </pre>
    </div>
  );
}
