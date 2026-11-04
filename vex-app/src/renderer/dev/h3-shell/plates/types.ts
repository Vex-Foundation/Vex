/**
 * THE PLATE CONTRACT - one of our own H3 plates for a desktop surface H3
 * does not draw (docs/design/H3-DESKTOP.md section 4.9; rows S8-01 to S8-03).
 *
 * A plate is a DESIGN PROPOSAL, not a state. A state points the real
 * `AppShell` somewhere; a plate composes a screen the product does not have
 * yet - Studio, the Lighter desk, the wizard, unlock and the screens before
 * the shell - in H3's tokens and cells, so the owner can approve it before
 * any code for that screen is written. It may mount real H3 parts that
 * already exist (the shell's header, columns and bottom row) and draw the rest
 * as static markup on the same tokens. Its sample words and figures are a
 * plate's: nothing in it is read from the app, and nothing in it ships
 * (`scripts/check-build-artifacts.mjs` refuses this directory in `dist/`).
 *
 * `Plate` renders the whole window's content at the window's size, inside
 * the harness frame; `?plate=<id>` opens it, with `?os=` for the chrome.
 */

import type { JSX } from "react";
import type { BridgeAnswers } from "../bridge.js";
import type { HarnessUi } from "../states/types.js";

export interface HarnessPlate {
  /** The `?plate=` value. */
  readonly id: string;
  /** One line for the index and the capture's name. */
  readonly title: string;
  /** The window's content, at the window's size. */
  readonly Plate: () => JSX.Element;
  /**
   * For a plate that mounts real H3 parts which read the bridge: what the
   * stand-in bridge answers, as a state's `answers` (`states/types.ts`).
   * A plate of static markup only leaves it out, and no bridge is installed.
   */
  readonly answers?: () => BridgeAnswers;
  /** Where the UI store points before the first render, as a state's `ui`. */
  readonly ui?: HarnessUi;
}
