import { CH } from "../../shared/ipc/channels.js";
import {
  vexCloudAccountInputSchema,
  vexCloudSignInInputSchema,
  vexCloudSignOutInputSchema,
  type VexCloudSignInInput,
} from "../../shared/schemas/vex-cloud.js";
import {
  vexCloudActivityInputSchema,
  vexCloudClaimCashbackInputSchema,
  vexCloudDepositsInputSchema,
  vexCloudDepositWalletsInputSchema,
  vexCloudPrepareDepositInputSchema,
  vexCloudPrepareWithdrawalInputSchema,
  vexCloudSubmitDepositInputSchema,
  vexCloudSubmitWithdrawalInputSchema,
  vexCloudUsageInputSchema,
  vexCloudWithdrawalStatusInputSchema,
  type VexCloudPageInput,
  type VexCloudPrepareDepositInput,
  type VexCloudPrepareWithdrawalInput,
  type VexCloudSubmitDepositInput,
  type VexCloudSubmitWithdrawalInput,
  type VexCloudWithdrawalStatusInput,
} from "../../shared/schemas/vex-cloud-funding.js";
import type { VexCloudBridge } from "../../shared/types/bridge/shell/vex-cloud.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

/**
 * Vex Cloud domain wrapper: named methods only, no channel string, no
 * `ipcRenderer`. The strict shared schemas validated here carry no message,
 * signature, bearer, URL, deposit destination or fee field, so none can be
 * smuggled in from this side.
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
  depositWallets() {
    return abortableInvoke(CH.vexCloud.depositWallets, {}, vexCloudDepositWalletsInputSchema);
  },
  prepareDeposit(input: VexCloudPrepareDepositInput) {
    return abortableInvoke(CH.vexCloud.prepareDeposit, input, vexCloudPrepareDepositInputSchema);
  },
  submitDeposit(input: VexCloudSubmitDepositInput) {
    return abortableInvoke(CH.vexCloud.submitDeposit, input, vexCloudSubmitDepositInputSchema);
  },
  prepareWithdrawal(input: VexCloudPrepareWithdrawalInput) {
    return abortableInvoke(CH.vexCloud.prepareWithdrawal, input, vexCloudPrepareWithdrawalInputSchema);
  },
  submitWithdrawal(input: VexCloudSubmitWithdrawalInput) {
    return invokeWithSchema(CH.vexCloud.submitWithdrawal, input, vexCloudSubmitWithdrawalInputSchema);
  },
  withdrawal(input: VexCloudWithdrawalStatusInput) {
    return invokeWithSchema(CH.vexCloud.withdrawal, input, vexCloudWithdrawalStatusInputSchema);
  },
  claimCashback() {
    return invokeWithSchema(CH.vexCloud.claimCashback, {}, vexCloudClaimCashbackInputSchema);
  },
  activity(input: VexCloudPageInput) {
    return invokeWithSchema(CH.vexCloud.activity, input, vexCloudActivityInputSchema);
  },
  usage(input: VexCloudPageInput) {
    return invokeWithSchema(CH.vexCloud.usage, input, vexCloudUsageInputSchema);
  },
  deposits(input: VexCloudPageInput) {
    return invokeWithSchema(CH.vexCloud.deposits, input, vexCloudDepositsInputSchema);
  },
} satisfies VexCloudBridge;
