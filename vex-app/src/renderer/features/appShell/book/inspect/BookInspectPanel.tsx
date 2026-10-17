/**
 * BookInspectPanel: the inspect view for one tool call, which takes over the
 * Vex sidebar's body while the inspect store holds a payload of the open
 * session (docs/design/R3-MINIMAL.md section 5.1). The sidebar owns the Back
 * key and the takeover; this panel is the call itself: its name, its status
 * as a fill and a word, and the full arguments and result. Payloads render
 * COMPLETE, scrolling and never truncated (owner decree). The JSON view is a
 * placeholder <pre>; it swaps to the shared JsonTree when that primitive
 * lands.
 */

import type { JSX } from "react";
import { StateWord } from "../../../../components/ui/state-word.js";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import type { ToolInspectPayload, ToolInspectStatus } from "./inspect-store.js";

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
 * circular payloads must not crash the panel: they degrade to String().
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
  return (
    <section
      data-vex-area="book-inspect"
      aria-label={`Tool call: ${inspect.toolName}`}
      className="vex-vs-inspect"
    >
      <header className="vex-vs-inspect__head">
        <h3 className="vex-vs-inspect__title">{inspect.toolName}</h3>
        <StateWord
          state={STATUS_DOT[inspect.status]}
          word={STATUS_WORD[inspect.status]}
          className="vex-vs-inspect__state"
        />
      </header>

      <div className="vex-vs-inspect__scroll vex-scroll">
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
    <div className="vex-vs-inspect__payload">
      <span className="vex-vs-inspect__label">{label}</span>
      <pre className="vex-vs-inspect__pre">{stringifyPayload(value)}</pre>
    </div>
  );
}
