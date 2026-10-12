/**
 * THE LEFT PAGE'S MAST (docs/design/V10-SPREAD.md sections 3 and 8): the
 * open page's 44px head row, set on the print. The macOS traffic lights sit
 * on the photograph at its left inset (96px; 18 where the OS draws its own
 * buttons at the right), then the vx mark, then the `Agent | Studio` capsule
 * at the right edge. The row is a window drag region; the mark and the
 * capsule opt out.
 *
 * WHY THE CAPSULE LIVES HERE, in every agent state. The mode switch must be on
 * screen whatever the centre shows (UX after-audit N1: a door that exists on
 * one screen of a mode is not a door out of that mode), and the page's head
 * row is the one surface whose controls do not depend on whether a session is
 * open. On the welcome stage it now sits beside the vx mark here, rather than
 * under the hero's mark (owner decree 2026-09-04 kept it with the mark); the
 * hero mounts its copy only while the page is a spine (`useLeftPageOpen`), so
 * the page still carries exactly ONE `Runtime mode` radiogroup
 * (`e2e/studio.spec.ts` pins the count).
 *
 * THE MAST IS OPEN-PAGE ONLY. The spine has no head row of its own (its paper
 * cap belongs to the running head), so the way into Studio from a spine is to
 * open the page. The Studio rail makes the same call in the other direction,
 * so neither mode is a one-way door.
 *
 * The search and the collapse control used to share this row; with the
 * lights, the mark and the capsule they ran about 40px past the 300px page on
 * macOS, so they moved down into the tabs row (`SessionsList`).
 */

import type { JSX } from "react";
import { useUiStore } from "../../stores/uiStore.js";
import { RuntimeModeToggle } from "./RuntimeModeToggle.js";
import { SidebarHomeSigil } from "./SidebarHomeSigil.js";

export function AgentSidebarHeader(): JSX.Element {
  // The header holds its own store subscription: `RuntimeModeToggle` takes the
  // value and the setter as props by contract.
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);

  return (
    <header className="vex-lp-mast vex-drag vex-lights-start">
      <SidebarHomeSigil sidebarOpen />
      <RuntimeModeToggle
        runtimeMode={runtimeMode}
        onChange={setRuntimeMode}
        className="vex-lp-mast__modes"
      />
    </header>
  );
}
