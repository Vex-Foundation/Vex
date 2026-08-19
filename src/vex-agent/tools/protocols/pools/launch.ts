/**
 * The pools.fun launch RUNTIME - the module the Electron main process imports.
 *
 * This is the gate the desktop lane reaches through: the published contract
 * (`./launch/runtime-contract.ts`) declares the types, and this file exports the
 * implementations bound to them. Main imports from HERE and never reaches into a
 * handler, a store or a plan builder - those are implementation details of this
 * lane and are free to move without a boundary negotiation.
 *
 * ALL SEVEN CONTRACT METHODS LIVE HERE: `prepare`, `deploy`, `cancel`,
 * `previewClaim`, `claim`, `myLaunches` and `getAwaiting`. The desktop lane can
 * therefore swap its `null` runtime for this one in a single change - which was
 * the point of waiting: a half-wired domain must never be reachable from the
 * app.
 */

export {
  cancelPoolsLaunch,
  deployPoolsLaunch,
  preparePoolsLaunch,
} from "./launch/desktop-launch.js";

export {
  claimPoolsFees,
  getAwaitingPoolsLaunchForm,
  listPoolsMyLaunches,
  previewPoolsClaim,
} from "./launch/desktop-claims.js";

/**
 * The `previewed` intents Agent Scan surfaces as considered-but-not-launched.
 * Not one of the seven contract methods - it feeds a FEED, not a money path -
 * but it lives behind this same gate so main still reaches the lane through one
 * door.
 */
export { listPreviewedForSession as listPoolsLaunchPreviews } from "@vex-agent/db/repos/token-launch-intents.js";

export type * from "./launch/runtime-contract.js";
