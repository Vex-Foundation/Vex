/**
 * Branch: running - Docker Compose up is in flight. The two services
 * (Postgres + Embeddings) render as probe rows reading aggregated substate
 * from the parsed log stream: the label, the detail in the figure face and a
 * state word with its fill (`docs/design/R3-MINIMAL.md section 10.3`). Vex's
 * face on the plate says "Working" with the real time. A quiet Cancel sits
 * under the rows (the Continue appears only once the phase flips to `ready`).
 *
 * The `data-vex-compose-cancel` / `data-vex-compose-cancelling`
 * attribute pair on the Cancel button is a public test contract (PR3
 * cancellation) - do not rename.
 */

import type { JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { StateWord } from "../../../../components/ui/state-word.js";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import type { AggregatedServiceState, ServiceStatus } from "../types.js";

interface RunningBodyProps {
  readonly services: AggregatedServiceState[];
  readonly onCancel: () => void;
  readonly cancelling: boolean;
}

/** The word and the fill of a service: the dot screen while it comes up, solid once ready. */
const STATUS_WORD: Record<ServiceStatus, { readonly word: string; readonly fill: SwatchState }> = {
  starting: { word: "Starting", fill: "ongoing" },
  probing: { word: "Probing", fill: "ongoing" },
  ready: { word: "Ready", fill: "done" },
  failed: { word: "Failed", fill: "error" },
};

export function RunningBody({
  services,
  onCancel,
  cancelling,
}: RunningBodyProps): JSX.Element {
  return (
    <>
      {/* The wait is announced once; the rows below carry the words. */}
      <p role="status" className="sr-only">
        Starting services
      </p>

      {/* SERVICE ROWS: one probe row per service. */}
      <ul className="vex-fr-probes">
        {services.map((s) => (
          <li
            key={s.service}
            className="vex-fr-probe"
            data-service={s.service}
            data-status={s.status}
            data-live={s.status === "probing" ? "" : undefined}
          >
            <span className="vex-fr-probe__l">{s.service}</span>
            <span className="vex-fr-probe__d vex-num">{s.detail}</span>
            <StateWord state={STATUS_WORD[s.status].fill} word={STATUS_WORD[s.status].word} />
          </li>
        ))}
      </ul>

      <Button
        variant="quiet"
        disabled={cancelling}
        onClick={onCancel}
        {...(cancelling
          ? { "data-vex-compose-cancelling": "" }
          : { "data-vex-compose-cancel": "" })}
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </Button>
    </>
  );
}
