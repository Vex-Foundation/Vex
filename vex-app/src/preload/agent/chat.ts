import { CH } from "../../shared/ipc/channels.js";
import {
  chatSteerInputSchema,
  chatSubmitInputSchema,
} from "../../shared/schemas/chat.js";
import type {
  ChatSteerInput,
  ChatSubmitInput,
  ChatSubmitResult,
} from "../../shared/schemas/chat.js";
import type { ChatBridge } from "../../shared/types/bridge/agent/chat.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

export const chat = {
  submit(input: ChatSubmitInput) {
    // Abortable (9-5b): the renderer cancels an in-flight chat turn by
    // firing `vex:cancel` for this requestId. Same `vex:chat:submit`
    // channel; the handler now threads `ctx.signal` into the engine.
    return abortableInvoke<ChatSubmitResult, ChatSubmitInput>(
      CH.chat.submit,
      input,
      chatSubmitInputSchema,
    );
  },
  steer(input: ChatSteerInput) {
    return invokeWithSchema(CH.chat.steer, input, chatSteerInputSchema);
  },
} satisfies ChatBridge;
