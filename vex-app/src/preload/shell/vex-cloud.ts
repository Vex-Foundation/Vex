import { CH } from "../../shared/ipc/channels.js";
import {
  vexCloudAccountInputSchema,
  vexCloudSignInInputSchema,
  vexCloudSignOutInputSchema,
  type VexCloudSignInInput,
} from "../../shared/schemas/vex-cloud.js";
import type { VexCloudBridge } from "../../shared/types/bridge/shell/vex-cloud.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

/**
 * Vex Cloud domain wrapper: three named methods, no channel string, no
 * `ipcRenderer`. The strict shared schemas validated here carry no message,
 * signature, bearer or URL field, so none can be smuggled in from this side.
 *
 * The preload validation is a fast, honest failure for our own renderer's
 * bugs; it is NOT the security boundary. Main re-validates every payload with
 * the same schema and re-checks the wallet set against its own inventory.
 */
export const vexCloud = {
  signIn(input: VexCloudSignInInput) {
    return abortableInvoke(CH.vexCloud.signIn, input, vexCloudSignInInputSchema);
  },
  account() {
    return invokeWithSchema(CH.vexCloud.account, {}, vexCloudAccountInputSchema);
  },
  signOut() {
    return invokeWithSchema(CH.vexCloud.signOut, {}, vexCloudSignOutInputSchema);
  },
} satisfies VexCloudBridge;
