import { ok, type Result } from "@shared/ipc/result.js";
import type { OpenTerminalLinkValue } from "@shared/schemas/terminal-links.js";
import type { AbortableInvocation } from "@shared/types/bridge/common.js";

async function awaitLinkInvocation(
  invocation: AbortableInvocation<OpenTerminalLinkValue>, signal?: AbortSignal,
): Promise<Result<OpenTerminalLinkValue>> {
  const cancel = (): void => invocation.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await invocation.promise;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** The exact terminal text is preserved through consent and opening. */
export function openTerminalLink(url: string, signal?: AbortSignal): Promise<Result<OpenTerminalLinkValue>> {
  if (signal?.aborted) return Promise.resolve(ok({ kind: "cancelled" }));
  return awaitLinkInvocation(window.vex.terminalLinks.open({ url }, { cancellable: true }), signal);
}
