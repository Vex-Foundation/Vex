/**
 * The real wake on the stage, beside the plate `stage-wake`, and the real
 * lock screen (docs/design/H3-DESKTOP.md section 4.13; owner decision
 * 2026-11-09): the gate's own content at the launch's third stage, the
 * unlock the launch hands to ("Welcome back.") and the unlock after Lock Vex
 * ("Vex is locked."). The lock screen stands on no stage, so the harness's
 * `StagePlate` draws nothing beside it and the screen is the whole window:
 * Kimm's panel at the left (`?vex=closed` keeps her field without her
 * figure), the password's column at the right. It supersedes the plates
 * `stage-unlock` and `stage-unlock-locked`. The unlock's bridge refuses every
 * password as wrong, so a capture that types one and presses Unlock (or
 * Enter) shows the failure line; it never holds a vault, a key or a password
 * of its own.
 */

import { createElement, type JSX } from "react";
import { GateActs } from "../../../features/setup/ChronosGate/GateActs.js";
import { UnlockScreen } from "../../../features/secrets/UnlockScreen.js";
import { stageVexEnd, stageVexPipelineReady } from "../../../components/onboarding/stage-vex.js";
import { H3_HARNESS_MARK } from "../mark.js";
import type { BridgeAnswers } from "../bridge.js";
import type { HarnessStage } from "./types.js";

/** The gate as `ChronosGate` lays it (z 50, over her column), at the launch's third stage. */
function WakeAtTheLedger(): JSX.Element {
  return createElement(
    "div",
    {
      "data-vex-screen": "chronos-gate",
      "data-vex-gate": "true",
      className: "pointer-events-none fixed inset-0 z-50 overflow-hidden",
    },
    createElement(GateActs, { status: { key: "schema", label: "Preparing the ledger" } }),
  );
}

/** Every password is refused as the wrong one, as main answers a wrong one. */
const WRONG_PASSWORD: BridgeAnswers = {
  secrets: {
    unlock: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "wallet.password_invalid",
          domain: "wallet",
          message: "Master password is incorrect.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: H3_HARNESS_MARK,
        },
      }),
  },
};

export const wake: HarnessStage = {
  id: "wake",
  title: "The wake: the desk starting, step 3 of 5",
  view: "splash",
  Screen: WakeAtTheLedger,
  ui: { setupGateActive: true },
  answers: () => ({}),
  ready: '[data-vex-screen="wake"]',
};

export const unlockAfterLaunch: HarnessStage = {
  id: "unlock",
  title: "The lock screen after a launch: Welcome back., Kimm resting on her field",
  view: "unlock",
  Screen: UnlockScreen,
  answers: () => WRONG_PASSWORD,
  // The launch's pipeline has handed off to the unlock.
  setup: stageVexPipelineReady,
  ready: '[data-vex-screen="unlock"]',
};

export const unlockAfterLock: HarnessStage = {
  id: "unlock-locked",
  title: "The lock screen after Lock Vex: Vex is locked., Kimm resting on her field",
  view: "unlock",
  Screen: UnlockScreen,
  answers: () => WRONG_PASSWORD,
  setup: stageVexEnd,
  ready: '[data-vex-screen="unlock"]',
};
