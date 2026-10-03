import { CH, EV } from "../../shared/ipc/channels.js";
import {
  approvalActionInputSchema,
  approvalDispatchEventSchema,
  approvalGetHistoryInputSchema,
  approvalGetInputSchema,
  approvalListPendingAllInputSchema,
  approvalListPendingInputSchema,
} from "../../shared/schemas/approvals.js";
import type {
  ApprovalActionInput,
  ApprovalGetHistoryInput,
  ApprovalGetInput,
  ApprovalListPendingAllInput,
  ApprovalListPendingInput,
} from "../../shared/schemas/approvals.js";
import type { ApprovalsBridge } from "../../shared/types/bridge/agent/approvals.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

export const approvals = {
  listPending(input: ApprovalListPendingInput) {
    return invokeWithSchema(
      CH.approvals.listPending,
      input,
      approvalListPendingInputSchema
    );
  },
  listPendingAll(input: ApprovalListPendingAllInput) {
    // A6: pass the strict empty input schema explicitly so a malformed payload
    // is rejected at the preload boundary, not just main-side.
    return invokeWithSchema(
      CH.approvals.listPendingAll,
      input,
      approvalListPendingAllInputSchema
    );
  },
  get(input: ApprovalGetInput) {
    return invokeWithSchema(CH.approvals.get, input, approvalGetInputSchema);
  },
  approve(input: ApprovalActionInput) {
    return invokeWithSchema(
      CH.approvals.approve,
      input,
      approvalActionInputSchema
    );
  },
  reject(input: ApprovalActionInput) {
    return invokeWithSchema(
      CH.approvals.reject,
      input,
      approvalActionInputSchema
    );
  },
  getHistory(input: ApprovalGetHistoryInput) {
    return invokeWithSchema(
      CH.approvals.getHistory,
      input,
      approvalGetHistoryInputSchema
    );
  },
  onDispatchEvent(callback) {
    return subscribe(EV.approvals.dispatch, approvalDispatchEventSchema, callback);
  },
} satisfies ApprovalsBridge;
