/**
 * The wake and the unlock on the stage (plan row S8-03; S8-15 builds them).
 *
 * The wake is the launch's own story: the five steps of `gate-timeline.ts`
 * in the left column, the live step in the title cell, the progress as a
 * segmented cell. The unlock follows on the same frame. Its words are
 * today's (`features/secrets/UnlockScreen.tsx`): "Welcome back.", the
 * master password, Unlock, the forgot link and, after Lock Vex, the line
 * that says where the password lives. The password sits where the
 * composer's field stands in a chat, with Unlock where SEND stands, so the
 * way in is the row the person goes on to talk to Vex from.
 *
 * Sample content only: the dots stand for a typed password and are never a
 * value.
 */

import type { JSX } from "react";
import { LineLock } from "../../../../components/icons/line/index.js";
import { Arrow, StageFrame, type StageStep } from "./StageFrame.js";

/** The wake's steps, as `GATE_STEPS` names them. */
const WAKE_STEPS = [
  "Waking the desk",
  "Starting services",
  "Preparing the ledger",
  "Reading your setup",
  "Ready",
] as const;

function wakeSteps(current: number | null): readonly StageStep[] {
  return WAKE_STEPS.map((name, index) => {
    if (current === null || index < current) return { name, at: "done" };
    if (index === current) return { name, at: "now", square: "running", word: null };
    return { name, at: "next" };
  });
}

/** The wake: the desk starting, step 3 of 5 (`STAGE_PROGRESS.schema`, 0.72). */
export function WakePlate(): JSX.Element {
  const lit = Math.round(0.72 * 20);
  return (
    <StageFrame
      title="Preparing the ledger"
      sub="Step 3 of 5"
      vex={{ word: "Waking up" }}
      where={{ head: "Waking the desk", count: "3/5", steps: wakeSteps(2) }}
      kimm="rest"
      acts={
        // The progress stands where the password will: the unlock that
        // follows puts its field in this row.
        <div
          className="vex-stg__meter-row"
          role="progressbar"
          aria-label="Waking the desk"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={72}
        >
          <span aria-hidden className="vex-stg__segments">
            {Array.from({ length: 20 }, (_, i) => (
              <i key={i} data-on={i < lit ? "" : undefined} />
            ))}
          </span>
          <span className="vex-stg__figure">72%</span>
        </div>
      }
    >
      <div className="vex-stg__body">
        <p className="vex-stg__row vex-stg__row--first">
          Vex is starting the local services on this machine.
        </p>
      </div>
    </StageFrame>
  );
}

/**
 * The unlock. `locked`: Vex was locked from the shell (Lock Vex), so she is
 * asleep and the line about where the password lives shows; otherwise the
 * launch woke the desk and she is ready.
 */
function UnlockPlate({ locked }: { readonly locked: boolean }): JSX.Element {
  return (
    <StageFrame
      title="Unlock"
      sub="Local vault · Locked"
      vex={locked ? { word: "Sleeping" } : { word: "Ready" }}
      where={{ head: "Waking the desk", count: "5/5", steps: wakeSteps(null) }}
      kimm={locked ? "rest" : "hi"}
      acts={
        <>
          <div className="vex-stg__entry">
            <LineLock size={16} className="vex-stg__entry-glyph" />
            <span aria-hidden className="vex-stg__value">
              <span className="vex-stg__dots">••••••••••••</span>
              <span className="vex-stg__caret" />
            </span>
          </div>
          <button type="button" className="vex-stg__show">
            Show
          </button>
          <button type="button" className="vex-stg__primary">
            Unlock
            <Arrow className="vex-stg__primary-arrow" />
          </button>
        </>
      }
    >
      <div className="vex-stg__body">
        <div className="vex-welcome">
          <p className="vex-welcome__greeting">Welcome back.</p>
          <ul className="vex-welcome__notes">
            <li className="vex-welcome__note">
              Your master password decrypts the local vault on this machine.
            </li>
            <li className="vex-welcome__note">Your keys stay on this computer.</li>
          </ul>
        </div>
        <div className="vex-stg__spacer" />
        {locked ? (
          <p className="vex-stg__aside">
            That password lives only in the app&apos;s memory while Vex is unlocked - never
            written to disk, never sent anywhere.
          </p>
        ) : null}
        <button type="button" className="vex-stg__row vex-stg__row--link">
          I forgot my password - set up a new vault
          <Arrow />
        </button>
      </div>
      <div className="vex-stg__strip">
        <span className="vex-stg__strip-cell">Master password</span>
      </div>
    </StageFrame>
  );
}

export function UnlockAfterLaunchPlate(): JSX.Element {
  return <UnlockPlate locked={false} />;
}

export function UnlockAfterLockPlate(): JSX.Element {
  return <UnlockPlate locked />;
}
