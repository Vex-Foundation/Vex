/**
 * THE STAGE INDEX - the real screens before the shell, by their `?stage=`
 * id (`types.ts` says what a stage is). Each one stands beside the approved
 * plate it was built from (`?plate=stage-*`). The parity spec does not read
 * this list: the screens have no Cloud capture to be compared with.
 */

import { runtimeMovePending, runtimeOffline } from "./first-run.js";
import { systemCheckBlocked, systemCheckReady } from "./system-check.js";
import type { HarnessStage } from "./types.js";
import { unlockAfterLaunch, unlockAfterLock, wake } from "./wake-unlock.js";
import { wizardPassword, wizardWallets } from "./wizard.js";

export const HARNESS_STAGES: readonly HarnessStage[] = [
  wake,
  unlockAfterLaunch,
  unlockAfterLock,
  systemCheckReady,
  systemCheckBlocked,
  runtimeOffline,
  runtimeMovePending,
  wizardPassword,
  wizardWallets,
];

export function stageById(id: string | null): HarnessStage | null {
  if (id === null) return null;
  return HARNESS_STAGES.find((stage) => stage.id === id) ?? null;
}
