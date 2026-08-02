/**
 * Token-launch IPC (C5-main) — `preview`, `submit`, `cancel`, `myLaunches`.
 *
 * THE BOUNDARY THIS FILE DEFENDS: the renderer describes the TOKEN; main decides
 * the MONEY. Nothing that becomes a spend crosses inward. There is no fee, value,
 * recipient, deadline or gas field in the input schemas, every object is
 * `.strict()`, and the creation fee, `msg.value` and calldata are all derived on
 * this side by `../token-launch/index.js`. A renderer-supplied amount reaching
 * the signing path is the exact failure rule 90 exists to prevent.
 *
 * `previewId` is the staleness anchor. The user consents to a figure they were
 * SHOWN; if the creation fee has moved since, main refuses with
 * `tokenLaunch.preview_stale` carrying both readings rather than signing a
 * number the user never saw. That check is the same re-derive-and-compare the
 * authorization gate uses — one mechanism, not two.
 *
 * LOGGING records the operation, the status, the refusal code and
 * `correlationId` only. Never the form, never an address, never an amount.
 *
 * SESSION SCOPE: `sessionId` is not ambient in main, so every session-scoped
 * channel takes it in the validated input and the intents repo's own
 * session-scoped predicates enforce ownership — another session's intent id
 * MISSES even when it is known. `registerHandler`'s `assertTrustedSender` is the
 * sender check underneath all of it.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  tokenLaunchCancelInputSchema,
  tokenLaunchCancelResultSchema,
  tokenLaunchMyLaunchesInputSchema,
  tokenLaunchMyLaunchesResultSchema,
  tokenLaunchPreviewInputSchema,
  tokenLaunchPreviewResultSchema,
  tokenLaunchSubmitInputSchema,
  tokenLaunchSubmitResultSchema,
  type TokenLaunchCancelResult,
  type TokenLaunchMyLaunchesResult,
  type TokenLaunchPreviewResult,
  type TokenLaunchSubmitResult,
} from "@shared/schemas/token-launch.js";
import type { TokenLaunchRefusal } from "../token-launch/index.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

const DOMAIN = "tokenLaunch" as const;

/** Map a main-side refusal onto its named wire code. */
function refuse(refusal: TokenLaunchRefusal, correlationId: string): Result<never, VexError> {
  const code = ((): VexError["code"] => {
    switch (refusal.kind) {
      case "preview_stale":
        return "tokenLaunch.preview_stale";
      case "value_ceiling_exceeded":
        return "tokenLaunch.value_ceiling_exceeded";
      case "launch_count_exceeded":
        return "tokenLaunch.launch_count_exceeded";
      case "ceiling_not_set":
        return "tokenLaunch.ceiling_not_set";
      case "invalid":
        return "validation.invalid_input";
    }
  })();

  log.warn(`[ipc:vex:tokenLaunch] refused code=${code} correlationId=${correlationId}`);
  return err({
    code,
    domain: DOMAIN,
    message: refusal.detail,
    // A stale preview IS retryable — the user re-previews and sees the new
    // numbers. A breached ceiling is not: the amount is never clamped for them.
    retryable: refusal.kind === "preview_stale",
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function notWired(correlationId: string, what: string): Result<never, VexError> {
  log.warn(`[ipc:vex:tokenLaunch] not wired: ${what} correlationId=${correlationId}`);
  return err({
    code: "internal.unexpected",
    domain: DOMAIN,
    message:
      "The launch could not be completed because part of the desktop wiring is not in place yet. "
      + "Nothing was signed and no funds moved.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

// ── preview ─────────────────────────────────────────────────────────────────

function registerPreviewHandler(): () => void {
  return registerHandler({
    channel: CH.tokenLaunch.preview,
    domain: DOMAIN,
    inputSchema: tokenLaunchPreviewInputSchema,
    outputSchema: tokenLaunchPreviewResultSchema,
    handle: async (_input, ctx): Promise<Result<TokenLaunchPreviewResult>> => {
      // REQUIRES the signing-wallet + chain-client resolution that lives in the
      // agent runtime's main mount. Refuses rather than guessing a fee.
      return notWired(ctx.requestId, "preview needs the main-side wallet/client mount");
    },
  });
}

// ── submit ──────────────────────────────────────────────────────────────────

function registerSubmitHandler(): () => void {
  return registerHandler({
    channel: CH.tokenLaunch.submit,
    domain: DOMAIN,
    inputSchema: tokenLaunchSubmitInputSchema,
    outputSchema: tokenLaunchSubmitResultSchema,
    handle: async (_input, ctx): Promise<Result<TokenLaunchSubmitResult>> => {
      return notWired(ctx.requestId, "submit needs the main-side wallet/client mount");
    },
  });
}

// ── cancel ──────────────────────────────────────────────────────────────────

function registerCancelHandler(): () => void {
  return registerHandler({
    channel: CH.tokenLaunch.cancel,
    domain: DOMAIN,
    inputSchema: tokenLaunchCancelInputSchema,
    outputSchema: tokenLaunchCancelResultSchema,
    handle: async (_input, ctx): Promise<Result<TokenLaunchCancelResult>> => {
      return notWired(ctx.requestId, "cancel needs the §C3b resume mount");
    },
  });
}

// ── my launches ─────────────────────────────────────────────────────────────

function registerMyLaunchesHandler(): () => void {
  return registerHandler({
    channel: CH.tokenLaunch.myLaunches,
    domain: DOMAIN,
    inputSchema: tokenLaunchMyLaunchesInputSchema,
    outputSchema: tokenLaunchMyLaunchesResultSchema,
    handle: async (_input, ctx): Promise<Result<TokenLaunchMyLaunchesResult>> => {
      return notWired(ctx.requestId, "myLaunches needs the main-side wallet scope resolver");
    },
  });
}

/** Mount point for `register-all.ts` (coordinator-owned). */
export function registerTokenLaunchHandlers(): ReadonlyArray<() => void> {
  return [
    registerPreviewHandler(),
    registerSubmitHandler(),
    registerCancelHandler(),
    registerMyLaunchesHandler(),
  ];
}

export { refuse as __refuseForTests };
