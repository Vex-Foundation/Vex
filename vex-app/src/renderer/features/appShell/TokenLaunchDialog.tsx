/**
 * TOKEN LAUNCH — the launch surface's public entry point.
 *
 * This file is the FACADE and stays one: `TokenLaunchButton` and
 * `AgentLaunchFormHost` import `TokenLaunchDialog` from here, and the split
 * below changed no caller's import. The implementation lives in the sibling
 * `TokenLaunchDialog/` folder, one responsibility per file (rules/04): the
 * shared consent vocabulary (`phase.ts`, `PhaseNote.tsx`, `preview-state.ts`),
 * the launchpad selector, and one LANE component per launchpad.
 *
 * WHY LANES AND NOT ONE PARAMETERIZED DIALOG. The launchpads do not share an
 * authorization machine. Trench Express arms Deploy from a continuously
 * refetched background preview; pools.fun runs two explicit stages, where a
 * verified calldata fingerprint is produced first and the Deploy click
 * authorizes exactly that. Multiplexing both through one component is how a
 * click ends up authorizing the other lane's number, so each lane owns its own
 * machine and its own dialog chrome, and only the vocabulary is shared.
 *
 * PLATFORM DEFAULTS TO TRENCH. An agent-requested form (`AgentLaunchFormHost`)
 * answers a Trench intent today and does not pass a platform, so the default is
 * the one that keeps that path exactly as it was.
 *
 * MOUNTING IS NOT MINE: `AppShell.tsx` / `BookPanel.tsx` composition is
 * coordinator-owned (§4b). This file exports the symbols ready to mount and
 * touches nothing else.
 */

import { useState, type JSX } from "react";
import type { LaunchLaneProps } from "./TokenLaunchDialog/lane-props.js";
import type { LaunchPlatform } from "./TokenLaunchDialog/LaunchPlatformChips.js";
import { PoolsLaunchLane } from "./TokenLaunchDialog/PoolsLaunchLane.js";
import { TrenchLaunchLane } from "./TokenLaunchDialog/TrenchLaunchLane.js";

export type { LaunchPlatform } from "./TokenLaunchDialog/LaunchPlatformChips.js";

export interface TokenLaunchDialogProps extends LaunchLaneProps {
  /** Which launchpad the dialog opens on. Defaults to Trench Express. */
  readonly platform?: LaunchPlatform;
  /**
   * Lifts the selection when the HOST owns it (the launchpad card's chips).
   * Omitted, the dialog keeps its own selection.
   */
  readonly onPlatformChange?: (next: LaunchPlatform) => void;
}

export function TokenLaunchDialog({
  platform,
  onPlatformChange,
  ...lane
}: TokenLaunchDialogProps): JSX.Element {
  // Controlled when the host passes both, uncontrolled otherwise — the standard
  // React pattern, so a host that only wants to OPEN the dialog on a platform
  // does not have to own the state machine of the chips.
  const [ownPlatform, setOwnPlatform] = useState<LaunchPlatform>(platform ?? "trench");
  const active = platform ?? ownPlatform;
  const change = (next: LaunchPlatform): void => {
    setOwnPlatform(next);
    onPlatformChange?.(next);
  };

  return active === "pools" ? (
    <PoolsLaunchLane {...lane} platform={active} onPlatformChange={change} />
  ) : (
    <TrenchLaunchLane {...lane} platform={active} onPlatformChange={change} />
  );
}
