/**
 * The plates, in the order the index lists them (`types.ts` says what a plate
 * is). Each surface's plates live in their own folder and add their entries
 * here: Studio (S8-01), the Lighter desk (S8-02), and the wizard, unlock and
 * the screens before the shell (S8-03).
 */

import { STAGE_PLATES } from "./stages/index.js";
import type { HarnessPlate } from "./types.js";

export const HARNESS_PLATES: readonly HarnessPlate[] = [...STAGE_PLATES];

export function plateById(id: string | null): HarnessPlate | null {
  if (id === null) return null;
  return HARNESS_PLATES.find((plate) => plate.id === id) ?? null;
}
