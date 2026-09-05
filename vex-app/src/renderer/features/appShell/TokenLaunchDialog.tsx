/**
 * TOKEN LAUNCH - the launch surface's public entry point.
 *
 * This file is the FACADE and stays one: `TokenLaunchButton` and
 * `AgentLaunchFormHost` import `TokenLaunchDialog` from here, and no caller's
 * import has changed through two restructurings. The implementation lives in
 * the sibling `TokenLaunchDialog/` folder, one responsibility per file
 * (rules/04): the shared consent vocabulary (`phase.ts`, `PhaseNote.tsx`) and
 * the lane itself.
 *
 * ── ONE LANE, AND WHY THERE IS NO SELECTOR ────────────────────────────────
 * There were two: Trench Express armed Deploy from a continuously refetched
 * background preview, pools.fun runs two explicit stages where a verified
 * calldata fingerprint is produced first and the Deploy click authorizes
 * exactly that. They did not share an authorization machine, which is why each
 * owned its own dialog chrome rather than being multiplexed through one
 * component - multiplexing is how a click ends up authorizing the other lane's
 * number.
 *
 * Migration 108 retired Trench Express, so pools.fun is the only launchpad and
 * the platform selector, its chips and the dialog's platform prop went with it.
 * The facade is kept rather than collapsed into the lane: it is the stable
 * public name of the launch surface, and a future second launchpad reintroduces
 * the choice HERE, in one place, instead of at every mount site.
 *
 * MOUNTING IS NOT MINE: `AppShell.tsx` / `BookPanel.tsx` composition is
 * coordinator-owned (§4b). This file exports the symbols ready to mount and
 * touches nothing else.
 */

import type { JSX } from "react";
import type { LaunchLaneProps } from "./TokenLaunchDialog/lane-props.js";
import { PoolsLaunchLane } from "./TokenLaunchDialog/PoolsLaunchLane.js";

export type TokenLaunchDialogProps = LaunchLaneProps;

export function TokenLaunchDialog(props: TokenLaunchDialogProps): JSX.Element {
  return <PoolsLaunchLane {...props} />;
}
