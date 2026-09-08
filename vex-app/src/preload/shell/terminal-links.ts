import { z } from "zod";
import { CH } from "../../shared/ipc/channels.js";
import { err, VEX_ERROR_CODES, VEX_DOMAINS, type Result } from "../../shared/ipc/result.js";
import {
  openTerminalLinkInputSchema,
  openTerminalLinkValueSchema,
  terminalLinkOpenOptionsSchema,
  type OpenTerminalLinkInput,
  type TerminalLinkOpenOptions,
  type OpenTerminalLinkValue,
} from "../../shared/schemas/terminal-links.js";
import type { AbortableInvocation } from "../../shared/types/bridge/common.js";
import type { TerminalLinksBridge } from "../../shared/types/bridge/shell/terminal-links.js";
import { abortableInvoke } from "../_dispatch.js";

const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: openTerminalLinkValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(VEX_ERROR_CODES), domain: z.enum(VEX_DOMAINS),
    message: z.string(), correlationId: z.string().min(1),
    retryable: z.boolean(), userActionable: z.boolean(), redacted: z.literal(true),
  }).strict() }).strict(),
]);

export async function checkedTerminalLinkOutput(pending: Promise<Result<OpenTerminalLinkValue>>): Promise<Result<OpenTerminalLinkValue>> {
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

function open(input: OpenTerminalLinkInput): Promise<Result<OpenTerminalLinkValue>>;
function open(input: OpenTerminalLinkInput, options: TerminalLinkOpenOptions): AbortableInvocation<OpenTerminalLinkValue>;
function open(input: OpenTerminalLinkInput, options?: TerminalLinkOpenOptions): Promise<Result<OpenTerminalLinkValue>> | AbortableInvocation<OpenTerminalLinkValue> {
  if (options !== undefined && !terminalLinkOpenOptionsSchema.safeParse(options).success) {
    return { promise: Promise.resolve(err({
      code: "validation.invalid_input", domain: "preload",
      message: "Invalid terminal link options.", retryable: false,
      userActionable: false, redacted: true, correlationId: crypto.randomUUID(),
    })), cancel: () => undefined };
  }
  const invocation = abortableInvoke<OpenTerminalLinkValue>(CH.terminal.openLink, input, openTerminalLinkInputSchema);
  const promise = checkedTerminalLinkOutput(invocation.promise);
  return options === undefined ? promise : { promise, cancel: invocation.cancel };
}

export const terminalLinks = { open } satisfies TerminalLinksBridge;
