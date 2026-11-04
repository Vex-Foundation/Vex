/**
 * THE STATE CONTRACT - what one harness state is: the answers its bridge
 * gives, the store slots it writes, and the element that proves it rendered.
 *
 * A state is DATA, not a component. The harness always mounts the same real
 * `AppShell`; a state only decides what the process boundary answers and
 * where the UI store points (which chat is open, which page, whether the Vex
 * column is shown), which are exactly the two inputs the product's shell has.
 * So a state can never render a component the product would not, and every
 * difference between two captures is a difference the product can produce.
 *
 * `ready` names the element whose presence means the state is on screen (the
 * card, the turn, the page). The harness stamps `data-vex-h3-ready` only after
 * it is present AND no query is still fetching, which is what a spec waits
 * for. `afterMount` is for what only arrives as an event in the product - a
 * live stream delta, a control-state push - and receives the bridge's `emit`;
 * the ready stamp also waits for the promise it returns.
 */

import type { UiState } from "../../../stores/uiStore.js";
import type { BridgeAnswers, HarnessBridge } from "../bridge.js";

/** The UI store slots a state may write: where the shell is pointed. */
export type HarnessUi = Partial<
  Pick<
    UiState,
    | "activeSessionId"
    | "activeProjectId"
    | "shellRoute"
    | "runtimeMode"
    | "leftOpen"
    | "sidebarOpen"
    | "vexOpenChat"
    | "vexOpenPages"
    | "reasoningEffortBySession"
    | "modelPickBySession"
  >
>;

export interface HarnessState {
  /** The `?state=` value. */
  readonly id: string;
  /** One line for the index and the capture's name. */
  readonly title: string;
  readonly answers: () => BridgeAnswers;
  readonly ui: HarnessUi;
  /** A selector that is on screen once this state has rendered. */
  readonly ready: string;
  /** Settles when what it delivered is on screen; the ready stamp waits for it. */
  readonly afterMount?: (bridge: HarnessBridge) => Promise<void>;
}
