/**
 * The first run's furniture on the stage plate (`docs/design/R3-MINIMAL.md section 10.3`): the
 * crumb that says where you are (System check, Docker, Services, Database, Setup) and what Vex
 * shows for what the screen is doing.
 *
 * A screen names its step and its mood to `SetupFrame`; the mood is a fill and a word on the plate
 * ("Working 0:14", "Ready", "Concerned", "Error") and the fill of the crumb's current step. The
 * timer beside "Working" is the real time since the screen began its work, never a loop.
 *
 *   working    the screen is doing something now (probing, starting, applying)
 *   ready      nothing is in flight and nothing is wrong
 *   concerned  the screen needs the user to do something (Docker stopped, a port is taken)
 *   error      something failed
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { cn } from "../../lib/utils.js";
import { Swatch, type SwatchState } from "../ui/swatch.js";
import {
  formatCountdown,
  stageVexFace,
  stageVexFaceClear,
  type StageVexView,
} from "./stage-vex.js";

export type FirstRunStep = "systemCheck" | "docker" | "services" | "database";
export type FirstRunMood = "working" | "ready" | "concerned" | "error";

/** The five stages of the first run, in order. The wizard is the last. */
export const FIRST_RUN_STAGES: readonly { readonly id: FirstRunStep | "setup"; readonly label: string }[] = [
  { id: "systemCheck", label: "System check" },
  { id: "docker", label: "Docker" },
  { id: "services", label: "Services" },
  { id: "database", label: "Database" },
  { id: "setup", label: "Setup" },
];

/** What Vex shows on the plate for a mood: her emotion, the fill and the word. */
export function moodFace(mood: FirstRunMood, timer: string | null): StageVexView {
  switch (mood) {
    case "working":
      return { emotion: "working", swatch: "done", word: "Working", note: timer };
    case "ready":
      return { emotion: "idle", swatch: "idle", word: "Ready", note: null };
    case "concerned":
      return { emotion: "concerned", swatch: "concerned", word: "Concerned", note: null };
    case "error":
      return { emotion: "error", swatch: "error", word: "Error", note: null };
  }
}

/** The fill of the crumb's current step: solid while it works or is done, a target when it waits on you. */
export function moodCrumbFill(mood: FirstRunMood): SwatchState {
  switch (mood) {
    case "working":
    case "ready":
      return "done";
    case "concerned":
      return "awaiting";
    case "error":
      return "error";
  }
}

const MOOD_WORD: Record<FirstRunMood, string> = {
  working: "Working",
  ready: "Ready",
  concerned: "Concerned",
  error: "Error",
};

/**
 * The real time since `active` became true, as m:ss, or null while idle. One tick a second, in
 * its own component so only the face re-renders.
 */
function useElapsedNote(active: boolean): string | null {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? formatCountdown(seconds) : null;
}

/**
 * Says what Vex shows while this screen stands on the plate (renders nothing). The face is set when
 * it changes and cleared once, when the screen leaves, so a crossfade between two screens never
 * flickers through the launch's own words.
 */
export function StageFace({ mood }: { readonly mood: FirstRunMood }): null {
  const timer = useElapsedNote(mood === "working");
  const { emotion, swatch, word, note } = moodFace(mood, timer);
  const mine = useRef<StageVexView | null>(null);
  useEffect(() => {
    const face: StageVexView = { emotion, swatch, word, note };
    mine.current = face;
    stageVexFace(face);
  }, [emotion, swatch, word, note]);
  useEffect(
    () => () => {
      if (mine.current !== null) stageVexFaceClear(mine.current);
    },
    [],
  );
  return null;
}

/** Where you are: System check, Docker, Services, Database, Setup. The current step is blue. */
export function FirstRunCrumb({
  step,
  mood,
  className,
}: {
  readonly step: FirstRunStep;
  readonly mood: FirstRunMood;
  readonly className?: string;
}): JSX.Element {
  const at = FIRST_RUN_STAGES.findIndex((stage) => stage.id === step);
  return (
    <nav aria-label="First run" className={cn("vex-fr-crumb", className)}>
      <ol>
        {FIRST_RUN_STAGES.map((stage, index) => {
          const position = index < at ? "done" : index === at ? "now" : "next";
          const fill: SwatchState =
            position === "done" ? "done" : position === "now" ? moodCrumbFill(mood) : "idle";
          return (
            <li
              key={stage.id}
              data-state={position}
              aria-current={position === "now" ? "step" : undefined}
            >
              <Swatch
                state={fill}
                size={10}
                {...(position === "done"
                  ? { label: "Done" }
                  : position === "now"
                    ? { label: MOOD_WORD[mood] }
                    : {})}
              />
              <span>{stage.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
