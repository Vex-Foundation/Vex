import { z } from "zod";
import { CH } from "../../shared/ipc/channels.js";
import { err, VEX_ERROR_CODES, VEX_DOMAINS, type Result } from "../../shared/ipc/result.js";
import {
  answerTerminalLinkInputSchema,
  cancelTerminalLinkInputSchema,
  openTerminalLinkInputSchema,
  openTerminalLinkValueSchema,
  type OpenTerminalLinkValue,
} from "../../shared/schemas/terminal-links.js";
import type { TerminalLinksBridge } from "../../shared/types/bridge/shell/terminal-links.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: openTerminalLinkValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(VEX_ERROR_CODES), domain: z.enum(VEX_DOMAINS),
    message: z.string(), correlationId: z.string().min(1),
    retryable: z.boolean(), userActionable: z.boolean(), redacted: z.literal(true),
  }).strict() }).strict(),
]);

async function checkedOutput(pending: Promise<Result<OpenTerminalLinkValue>>): Promise<Result<OpenTerminalLinkValue>> {
  try {
    const result = await pending;
    const parsed = resultSchema.safeParse(result);
    if (parsed.success) return parsed.data;
  } catch {
    // Transport errors may carry private URLs. Never forward their message.
  }
  return err({
    code: "internal.contract_violation", domain: "preload",
    message: "The terminal link request could not be completed. Try again.",
    retryable: false, userActionable: true, redacted: true, correlationId: crypto.randomUUID(),
  });
}

export const terminalLinks = {
  open(input) {
    const invocation = abortableInvoke<OpenTerminalLinkValue>(CH.terminal.openLink, input, openTerminalLinkInputSchema);
    return { promise: checkedOutput(invocation.promise), cancel: invocation.cancel };
  },
  answer(input) {
    const invocation = abortableInvoke<OpenTerminalLinkValue>(CH.terminal.answerLink, input, answerTerminalLinkInputSchema);
    return { promise: checkedOutput(invocation.promise), cancel: invocation.cancel };
  },
  cancel(input) {
    return checkedOutput(invokeWithSchema(CH.terminal.cancelLink, input, cancelTerminalLinkInputSchema));
  },
} satisfies TerminalLinksBridge;
