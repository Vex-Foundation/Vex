import { CH } from "../../shared/ipc/channels.js";
import {
  sessionCreateInputSchema,
  sessionDeleteInputSchema,
  sessionExportMarkdownInputSchema,
  sessionGetInputSchema,
  sessionGetModelInputSchema,
  sessionSetPinnedInputSchema,
} from "../../shared/schemas/sessions.js";
import type {
  SessionCreateInput,
  SessionDeleteInput,
  SessionExportMarkdownInput,
  SessionGetInput,
  SessionGetModelInput,
  SessionSetPinnedInput,
} from "../../shared/schemas/sessions.js";
import {
  planGetInputSchema,
  planSetEnabledInputSchema,
  planAcceptInputSchema,
} from "../../shared/schemas/session-plan.js";
import type {
  PlanGetInput,
  PlanSetEnabledInput,
  PlanAcceptInput,
} from "../../shared/schemas/session-plan.js";
import type { SessionsBridge } from "../../shared/types/bridge/agent/sessions.js";
import { invokeWithSchema } from "../_dispatch.js";

export const sessions = {
  create(input: SessionCreateInput) {
    return invokeWithSchema(CH.sessions.create, input, sessionCreateInputSchema);
  },
  list() {
    return invokeWithSchema(CH.sessions.list, {});
  },
  get(input: SessionGetInput) {
    return invokeWithSchema(CH.sessions.get, input, sessionGetInputSchema);
  },
  setPinned(input: SessionSetPinnedInput) {
    return invokeWithSchema(
      CH.sessions.setPinned,
      input,
      sessionSetPinnedInputSchema
    );
  },
  delete(input: SessionDeleteInput) {
    return invokeWithSchema(
      CH.sessions.delete,
      input,
      sessionDeleteInputSchema
    );
  },
  exportMarkdown(input: SessionExportMarkdownInput) {
    return invokeWithSchema(
      CH.sessions.exportMarkdown,
      input,
      sessionExportMarkdownInputSchema
    );
  },
  getModel(input: SessionGetModelInput) {
    return invokeWithSchema(
      CH.sessions.getModel,
      input,
      sessionGetModelInputSchema
    );
  },
  plan: {
    get(input: PlanGetInput) {
      return invokeWithSchema(CH.sessions.planGet, input, planGetInputSchema);
    },
    setEnabled(input: PlanSetEnabledInput) {
      return invokeWithSchema(
        CH.sessions.planSetEnabled,
        input,
        planSetEnabledInputSchema
      );
    },
    accept(input: PlanAcceptInput) {
      return invokeWithSchema(
        CH.sessions.planAccept,
        input,
        planAcceptInputSchema
      );
    },
  },
} satisfies SessionsBridge;
