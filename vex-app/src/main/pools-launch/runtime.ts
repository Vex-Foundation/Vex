/**
 * THE SEAM between main's pools.fun launch surface and the agent runtime that
 * actually prepares, verifies, signs and claims.
 *
 * WHY THIS FILE IS ONE LINE OF INDIRECTION. The runtime contract
 * (`@vex-agent/tools/protocols/pools/launch/runtime-contract.js`) is published
 * separately from its implementations, and main is bound to the contract's
 * function TYPES. Main and the runtime therefore cannot drift: a change to
 * either side that breaks the other is a compile error here.
 *
 * WHY THE IMPORT IS LAZY. `@vex-agent/tools/protocols/pools/launch.js` pulls in
 * the provider client, the calldata verifier, the intents repository and the
 * database. None of that belongs in main's startup path, and the same reasoning
 * already governs `main/token-launch/execute-seam.ts`, which reaches the agent
 * runtime through `await import(...)` inside the call rather than at module
 * load. The runtime is resolved on first use and the getter stays synchronous,
 * so no caller had to change shape when the implementations landed.
 */

import type {
  CancelPoolsLaunch,
  ClaimPoolsFees,
  DeployPoolsLaunch,
  GetAwaitingPoolsLaunchForm,
  ListPoolsMyLaunches,
  PreparePoolsLaunch,
  PreviewPoolsClaim,
} from "@vex-agent/tools/protocols/pools/launch/runtime-contract.js";

/** The seven entry points, exactly as the runtime contract types them. */
export interface PoolsLaunchRuntime {
  readonly prepare: PreparePoolsLaunch;
  readonly deploy: DeployPoolsLaunch;
  readonly cancel: CancelPoolsLaunch;
  readonly previewClaim: PreviewPoolsClaim;
  readonly claim: ClaimPoolsFees;
  readonly myLaunches: ListPoolsMyLaunches;
  readonly getAwaiting: GetAwaitingPoolsLaunchForm;
}

/**
 * The lane's single door. `launch.ts` is the module the agent side publishes for
 * main; nothing here reaches past it into a handler, a store or a plan builder.
 */
function loadPoolsLaunchModule(): Promise<
  typeof import("@vex-agent/tools/protocols/pools/launch.js")
> {
  return import("@vex-agent/tools/protocols/pools/launch.js");
}

/**
 * The live runtime.
 *
 * A function rather than a constant so no module-load order can capture a stale
 * value. Each method forwards to the published implementation of the same name;
 * this file adds no behavior of its own, deliberately, because a money path with
 * a second opinion in the seam has two places to be wrong.
 */
export function getPoolsLaunchRuntime(): PoolsLaunchRuntime {
  return {
    prepare: async (session, inputs) =>
      (await loadPoolsLaunchModule()).preparePoolsLaunch(session, inputs),
    deploy: async (session, inputs) =>
      (await loadPoolsLaunchModule()).deployPoolsLaunch(session, inputs),
    cancel: async (session, inputs) =>
      (await loadPoolsLaunchModule()).cancelPoolsLaunch(session, inputs),
    previewClaim: async (session, inputs) =>
      (await loadPoolsLaunchModule()).previewPoolsClaim(session, inputs),
    claim: async (session, inputs) =>
      (await loadPoolsLaunchModule()).claimPoolsFees(session, inputs),
    myLaunches: async (session, inputs) =>
      (await loadPoolsLaunchModule()).listPoolsMyLaunches(session, inputs),
    getAwaiting: async (session) =>
      (await loadPoolsLaunchModule()).getAwaitingPoolsLaunchForm(session),
  };
}
