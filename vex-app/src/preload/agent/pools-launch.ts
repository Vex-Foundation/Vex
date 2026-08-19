import { CH } from "../../shared/ipc/channels.js";
import {
  poolsClaimInputSchema,
  poolsLaunchCancelInputSchema,
  poolsLaunchDeployInputSchema,
  poolsLaunchGetAwaitingInputSchema,
  poolsLaunchMyLaunchesInputSchema,
  poolsLaunchPrepareInputSchema,
  type PoolsClaimInput,
  type PoolsLaunchCancelInput,
  type PoolsLaunchDeployInput,
  type PoolsLaunchGetAwaitingInput,
  type PoolsLaunchMyLaunchesInput,
  type PoolsLaunchPrepareInput,
} from "../../shared/schemas/pools-launch.js";
import type { PoolsLaunchBridge } from "../../shared/types/bridge/agent/pools-launch.js";
import { invokeWithSchema } from "../_dispatch.js";

/**
 * pools.fun launch domain wrapper. Seven named domain methods and nothing else
 * — no channel string, no `ipcRenderer`, and no way for the renderer to name an
 * amount that becomes a spend: the shared schemas validated here are `.strict()`
 * and carry no fee, value, deadline or gas field, so an extra money-shaped key
 * is rejected on THIS side of the boundary as well as in main.
 *
 * `deploy` takes only the opaque `fingerprintId`. That is the whole point of the
 * two-stage split: there is no field here through which a renderer could change
 * what it already showed the user.
 *
 * The preload validation is a fast, honest failure for our own renderer's bugs;
 * it is NOT the security boundary. Main re-validates every payload with the same
 * schema, because a compromised renderer can reach `ipcRenderer` by other means
 * and the process that can sign never trusts the one that cannot.
 */
export const poolsLaunch = {
  prepare(input: PoolsLaunchPrepareInput) {
    return invokeWithSchema(CH.poolsLaunch.prepare, input, poolsLaunchPrepareInputSchema);
  },
  deploy(input: PoolsLaunchDeployInput) {
    return invokeWithSchema(CH.poolsLaunch.deploy, input, poolsLaunchDeployInputSchema);
  },
  cancel(input: PoolsLaunchCancelInput) {
    return invokeWithSchema(CH.poolsLaunch.cancel, input, poolsLaunchCancelInputSchema);
  },
  myLaunches(input: PoolsLaunchMyLaunchesInput) {
    return invokeWithSchema(
      CH.poolsLaunch.myLaunches,
      input,
      poolsLaunchMyLaunchesInputSchema,
    );
  },
  getAwaiting(input: PoolsLaunchGetAwaitingInput) {
    return invokeWithSchema(
      CH.poolsLaunch.getAwaiting,
      input,
      poolsLaunchGetAwaitingInputSchema,
    );
  },
  claimPreview(input: PoolsClaimInput) {
    return invokeWithSchema(CH.poolsLaunch.claimPreview, input, poolsClaimInputSchema);
  },
  claim(input: PoolsClaimInput) {
    return invokeWithSchema(CH.poolsLaunch.claim, input, poolsClaimInputSchema);
  },
} satisfies PoolsLaunchBridge;
