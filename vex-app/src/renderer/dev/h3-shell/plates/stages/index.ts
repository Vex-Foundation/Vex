/**
 * Our H3 plates for the screens before the shell (plan row S8-03;
 * docs/design/H3-DESKTOP.md section 4.9): the wake, the unlock, the system
 * check and two steps of the setup wizard, each on the stage frame
 * (`StageFrame.tsx`). Proposals for the owner to approve, not the product.
 */

import type { HarnessPlate } from "../types.js";
import { SystemCheckBlockedPlate, SystemCheckReadyPlate } from "./system-check.js";
import { UnlockAfterLaunchPlate, UnlockAfterLockPlate, WakePlate } from "./wake-unlock.js";
import { WizardPasswordPlate, WizardWalletsPlate } from "./wizard.js";

export const STAGE_PLATES: readonly HarnessPlate[] = [
  { id: "stage-wake", title: "The wake: the desk starting, step 3 of 5", Plate: WakePlate },
  {
    id: "stage-unlock",
    title: "Superseded by ?stage=unlock (owner, 2026-11-09): unlock after a launch on the stage",
    Plate: UnlockAfterLaunchPlate,
  },
  {
    id: "stage-unlock-locked",
    title: "Superseded by ?stage=unlock-locked (owner, 2026-11-09): unlock after Lock Vex on the stage",
    Plate: UnlockAfterLockPlate,
  },
  {
    id: "stage-system-check",
    title: "System check: six checks passed, setup to do",
    Plate: SystemCheckReadyPlate,
  },
  {
    id: "stage-system-check-blocked",
    title: "System check: no disk space for setup, Continue held",
    Plate: SystemCheckBlockedPlate,
  },
  {
    id: "stage-wizard-password",
    title: "Setup, step 1 of 7: the master password",
    Plate: WizardPasswordPlate,
  },
  {
    id: "stage-wizard-wallets",
    title: "Setup, step 2 of 7: the wallets, none set up yet",
    Plate: WizardWalletsPlate,
  },
];
