/**
 * The real wake and unlock on the stage, beside the plates `stage-wake`,
 * `stage-unlock` and `stage-unlock-locked`: the gate's own content at the
 * launch's third stage, the unlock the launch hands to, and the unlock after
 * Lock Vex. The unlock's bridge refuses every password as wrong, so a capture
 * that types one and presses Unlock shows the failure row; it never holds a
 * vault, a key or a password of its own.
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
  title: "Unlock after a launch: the master password, Kimm ready",
  view: "unlock",
  Screen: UnlockScreen,
  answers: () => WRONG_PASSWORD,
  // The launch's pipeline has handed off to the unlock.
  setup: stageVexPipelineReady,
  ready: '[data-vex-screen="unlock"]',
};

export const unlockAfterLock: HarnessStage = {
  id: "unlock-locked",
  title: "Unlock after Lock Vex: Kimm asleep, where the password lives",
  view: "unlock",
  Screen: UnlockScreen,
  answers: () => WRONG_PASSWORD,
  setup: stageVexEnd,
  ready: '[data-vex-screen="unlock"]',
};
