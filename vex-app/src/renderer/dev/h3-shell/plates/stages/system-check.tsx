/**
 * The system check on the stage (plan row S8-03; S8-13 builds it), the
 * first of the first run's four stages (`FIRST_RUN_STAGES`). Its six rows and
 * their words are today's (`features/systemCheck/`): the label, the detail in
 * the figure face, the state at the right as a square and its word. The
 * runtime, migration and database screens that follow stand on the same
 * frame, with their own rows in this table's grammar.
 *
 * Sample content only: the versions, sizes and latency are a plate's.
 */

import type { JSX } from "react";
import { OpenLogsLinkStandin } from "./links.js";
import { StageFrame, Status, type SquareKind, type StageStep } from "./StageFrame.js";

interface Probe {
  readonly label: string;
  readonly detail: string;
  readonly square: SquareKind;
  readonly word: string;
}

/** The first run's four stages; the current one's square follows the screen's mood, as today. */
function firstRun(blocked: boolean): readonly StageStep[] {
  return [
    { name: "System check", at: "now", square: blocked ? "failed" : "ink" },
    { name: "Local runtime", at: "next" },
    { name: "Database", at: "next" },
    { name: "Setup", at: "next" },
  ];
}

/** A first run that can go on: every check passed, setup still to do. */
const READY_PROBES: readonly Probe[] = [
  { label: "Operating system", detail: "macOS · Electron 38.2.1", square: "done", word: "OK" },
  { label: "Network connectivity", detail: "online · 42 ms", square: "done", word: "OK" },
  {
    label: "Local runtime",
    detail: "Database and embeddings server · macOS arm64",
    square: "done",
    word: "Ready",
  },
  { label: "Disk space", detail: "212 GB free of 494 GB", square: "done", word: "OK" },
  { label: "Memory", detail: "16 GB · 9.4 GB free", square: "done", word: "OK" },
  {
    label: "Vex configuration",
    detail: "First run - guided setup required.",
    square: "ink",
    word: "Setup",
  },
];

/** A first run the disk holds back: Continue stays off. */
const BLOCKED_PROBES: readonly Probe[] = READY_PROBES.map((probe) =>
  probe.label === "Disk space"
    ? { ...probe, detail: "4.1 GB free · setup needs 6.0 GB", square: "failed", word: "No space" }
    : probe,
);

function SystemCheckPlate({ blocked }: { readonly blocked: boolean }): JSX.Element {
  const probes = blocked ? BLOCKED_PROBES : READY_PROBES;
  return (
    <StageFrame
      title="System check"
      sub="First run · Step 1 of 4"
      vex={blocked ? { word: "Error" } : { word: "Ready" }}
      where={{ head: "First run", count: "1/4", steps: firstRun(blocked) }}
      kimm={blocked ? "offer" : "hi"}
      footLink={<OpenLogsLinkStandin />}
      acts={
        <>
          <div className="vex-stg__gap" />
          <button
            type="button"
            className="vex-stg__primary"
            disabled={blocked}
            aria-label="Continue setup"
          >
            Continue
          </button>
        </>
      }
    >
      <div className="vex-stg__body">
        <p className="vex-stg__row vex-stg__row--first">Six quick checks before setup begins.</p>
        <ol className="vex-stg__probes">
          {probes.map((probe) => (
            <li key={probe.label} className="vex-stg__probe">
              <span className="vex-stg__probe-label">{probe.label}</span>
              <Status kind={probe.square} word={probe.word} />
              <span className="vex-stg__probe-detail">{probe.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </StageFrame>
  );
}

export function SystemCheckReadyPlate(): JSX.Element {
  return <SystemCheckPlate blocked={false} />;
}

export function SystemCheckBlockedPlate(): JSX.Element {
  return <SystemCheckPlate blocked />;
}
