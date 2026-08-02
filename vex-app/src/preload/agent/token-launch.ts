import { CH, EV } from "../../shared/ipc/channels.js";
import {
  launchFormEventSchema,
  tokenLaunchCancelInputSchema,
  tokenLaunchGetAwaitingInputSchema,
  tokenLaunchMyLaunchesInputSchema,
  tokenLaunchPreviewInputSchema,
  tokenLaunchSubmitInputSchema,
  type TokenLaunchCancelInput,
  type TokenLaunchGetAwaitingInput,
  type TokenLaunchMyLaunchesInput,
  type TokenLaunchPreviewInput,
  type TokenLaunchSubmitInput,
} from "../../shared/schemas/token-launch.js";
import type { TokenLaunchBridge } from "../../shared/types/bridge/agent/token-launch.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * Token launch (C5) domain wrapper. Five named domain methods plus one
 * subscription, and nothing else
 * — no channel string, no `ipcRenderer`, and in particular no way for the
 * renderer to name an amount: the shared schemas validated here are `.strict()`
 * and carry no fee, value, recipient, deadline or gas field, so an extra
 * money-shaped key is rejected on THIS side of the boundary as well as in main.
 *
 * The preload validation is a fast, honest failure for our own renderer's bugs;
 * it is NOT the security boundary. Main re-validates every payload with the
 * same schema, because a compromised renderer can reach `ipcRenderer` by other
 * means and the process that can sign never trusts the one that cannot.
 */
export const tokenLaunch = {
  preview(input: TokenLaunchPreviewInput) {
    return invokeWithSchema(CH.tokenLaunch.preview, input, tokenLaunchPreviewInputSchema);
  },
  submit(input: TokenLaunchSubmitInput) {
    return invokeWithSchema(CH.tokenLaunch.submit, input, tokenLaunchSubmitInputSchema);
  },
  cancel(input: TokenLaunchCancelInput) {
    return invokeWithSchema(CH.tokenLaunch.cancel, input, tokenLaunchCancelInputSchema);
  },
  myLaunches(input: TokenLaunchMyLaunchesInput) {
    return invokeWithSchema(
      CH.tokenLaunch.myLaunches,
      input,
      tokenLaunchMyLaunchesInputSchema,
    );
  },
  getAwaiting(input: TokenLaunchGetAwaitingInput) {
    return invokeWithSchema(
      CH.tokenLaunch.getAwaiting,
      input,
      tokenLaunchGetAwaitingInputSchema,
    );
  },
  /**
   * The §C3b push. `subscribe` re-validates the payload against the shared
   * schema and DROPS anything off-contract — the third validation layer, after
   * the engine type-check and the main-side bridge. An event that cannot be
   * trusted must not be able to open a spend-consent dialog.
   */
  onFormRequested(cb) {
    return subscribe(EV.launch.formRequested, launchFormEventSchema, cb);
  },
} satisfies TokenLaunchBridge;
