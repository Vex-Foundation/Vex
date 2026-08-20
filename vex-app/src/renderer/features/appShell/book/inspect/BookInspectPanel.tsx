/**
 * BookInspectPanel — the BOOK's inspect view for one tool call (A32/E13):
 * tool identity, status as word + StateDot, and the full arguments/result
 * payloads. Rendered by `BookPanel` while the inspect store holds a payload;
 * closing returns to the card stack (which stays mounted underneath).
 * Payloads render COMPLETE — scrolling, never truncation (owner decree).
 * The JSON view is a placeholder <pre>; it swaps to the shared JsonTree when
 * that primitive lands (board note, transcript owner's T7).
 */

import type { JSX } from "react";
import { IconClose } from "../../../../components/icons/index.js";
import {
  StateDot,
  type StateDotState,
} from "../../../../components/ui/state-dot.js";
import {
  useToolInspectStore,
  type ToolInspectPayload,
  type ToolInspectStatus,
} from "./inspect-store.js";

const STATUS_DOT: Record<ToolInspectStatus, StateDotState> = {
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
  if (value === undefined) return "—";
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
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl border border-line-2 bg-surface-1 p-4 shadow-lv1"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-doto text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-tertiary">
          Inspect
        </h3>
        <button
          type="button"
          aria-label="Close inspect"
          onClick={closeToolInspect}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-ink-tertiary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <IconClose size={14} />
        </button>
      </header>

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] text-ink-primary">
          {inspect.toolName}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-ink-secondary">
          <StateDot state={STATUS_DOT[inspect.status]} size={8} />
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
      <span className="font-doto text-[9px] uppercase tracking-[0.18em] text-ink-tertiary">
        {label}
      </span>
      <pre className="overflow-x-auto rounded-lg border border-line-1 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-ink-secondary">
        {stringifyPayload(value)}
      </pre>
    </div>
  );
}
