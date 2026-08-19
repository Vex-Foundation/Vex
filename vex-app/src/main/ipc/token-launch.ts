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
  tokenLaunchGetAwaitingInputSchema,
  tokenLaunchGetAwaitingResultSchema,
  tokenLaunchMyLaunchesInputSchema,
  tokenLaunchMyLaunchesResultSchema,
  tokenLaunchPreviewInputSchema,
  tokenLaunchPreviewResultSchema,
  tokenLaunchSubmitInputSchema,
  tokenLaunchSubmitResultSchema,
  type TokenLaunchCancelResult,
  type TokenLaunchGetAwaitingResult,
  type TokenLaunchMyLaunchesResult,
  type TokenLaunchPreviewResult,
  type TokenLaunchSubmitResult,
} from "@shared/schemas/token-launch.js";
import { listWallets } from "@vex-lib/wallet.js";
import { buildSubmittedLaunchExecutor } from "../token-launch/execute-seam.js";
import {
  cancelLaunch,
  getAwaitingLaunchForm,
  listMyLaunches,
  previewLaunch,
  submitLaunch,
  TRENCH_LAUNCH_CHAIN_ID,
  type TokenLaunchRefusal,
} from "../token-launch/index.js";
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
      case "no_wallet":
        return "wallets.invalid_selection";
      case "image_not_found":
        return "images.not_found";
      case "image_unavailable":
        return "images.store_unavailable";
      // The EXISTING `images.too_large` code, not a new one: it already means
      // exactly this, and the detail carries the plan's own prose naming the
      // budget, the reason it exists, and that pools.fun can still launch it.
      case "image_over_onchain_budget":
        return "images.too_large";
      case "insufficient_funds":
        return "wallet.insufficient_funds";
      // No `tokenLaunch.refused` code exists on the shared surface, and minting
      // one from a handler would grow the wire contract without the tests that
      // pin it. The MESSAGE carries the executor's precise reason; the code says
      // only that this was not the user's input to fix.
      case "launch_refused":
        return "internal.unexpected";
      // No `tokenLaunch.*` code is minted for "the chain would not price this":
      // the existing generic is honest (it is OUR read that failed, not the
      // user's input), and inventing a code the shared surface tests do not pin
      // would grow the wire contract from a handler.
      case "unpriceable":
        return "internal.unexpected";
    }
  })();

  log.warn(`[ipc:vex:tokenLaunch] refused code=${code} correlationId=${correlationId}`);
  return err({
    code,
    domain: DOMAIN,
    message: refusal.detail,
    // A stale preview IS retryable — the user re-previews and sees the new
    // numbers. A breached ceiling is not: the amount is never clamped for them.
    // A read that failed on OUR side (chain unreachable, locker unreadable) is
    // retryable too, and is the one class the user cannot act on by editing.
    // A refused launch is NOT retryable from the dialog: the two live causes are
    // a lost double-submit race (retrying is how you double-spend) and
    // authorization drift (which needs a fresh preview, not a repeat).
    retryable:
      refusal.kind === "preview_stale"
      || refusal.kind === "unpriceable"
      || refusal.kind === "image_unavailable",
    userActionable: refusal.kind !== "unpriceable",
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
    handle: async (input, ctx): Promise<Result<TokenLaunchPreviewResult>> => {
      // READ-ONLY. Priced by the SAME pipeline the execute leg signs from, so
      // the figure shown and the figure charged cannot diverge.
      const outcome = await previewLaunch({ sessionId: input.sessionId, form: input.form });
      if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
      log.info(
        `[ipc:vex:tokenLaunch:preview] ok chainId=${outcome.preview.chainId} `
          + `correlationId=${ctx.requestId}`,
      );
      return ok(outcome.preview);
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
    handle: async (input, ctx): Promise<Result<TokenLaunchSubmitResult>> => {
      // THE SPEND CONSENT. Everything that becomes money is re-derived main-side
      // from the form and the `previewId` the user was shown; the renderer named
      // no amount, and the schema above has no field for one.
      const outcome = await submitLaunch(input, buildSubmittedLaunchExecutor());
      if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
      log.info(
        `[ipc:vex:tokenLaunch:submit] ${outcome.result.status} `
          + `intentId=${outcome.result.intentId} correlationId=${ctx.requestId}`,
      );
      return ok(outcome.result);
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
    handle: async (input, ctx): Promise<Result<TokenLaunchCancelResult>> => {
      // Only reachable from `awaiting_user_form`, so a cancel can never race an
      // in-flight signature. When an agent asked for the form, this also wakes
      // its parked turn — `resumedAgentTurn` reports whether that actually
      // happened, never merely that it was attempted.
      const outcome = await cancelLaunch(input);
      if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
      log.info(
        `[ipc:vex:tokenLaunch:cancel] cancelled=${String(outcome.result.cancelled)} `
          + `resumed=${String(outcome.result.resumedAgentTurn)} correlationId=${ctx.requestId}`,
      );
      return ok(outcome.result);
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
    handle: async (input, ctx): Promise<Result<TokenLaunchMyLaunchesResult>> => {
      // WALLET SCOPE IS SERVER-RESOLVED. The renderer never names an address;
      // the scope is the user's own EVM inventory, whose addresses are public
      // and whose keys never come near this read.
      const walletAddresses = listWallets("evm").map((entry) => entry.address);
      if (walletAddresses.length === 0) return ok({ launches: [] });
      try {
        const launches = await listMyLaunches(
          walletAddresses,
          TRENCH_LAUNCH_CHAIN_ID,
          input.limit,
        );
        log.info(
          `[ipc:vex:tokenLaunch:myLaunches] ok count=${launches.length} `
            + `correlationId=${ctx.requestId}`,
        );
        return ok({ launches });
      } catch (cause) {
        // Structural only — a DB error message can carry a connection string.
        log.warn(
          `[ipc:vex:tokenLaunch:myLaunches] read failed correlationId=${ctx.requestId} `
            + `type=${cause instanceof Error ? cause.name : typeof cause}`,
        );
        return err({
          code: "internal.unexpected",
          domain: DOMAIN,
          message:
            "Your past launches could not be read. Check that Vex services are running and retry.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
    },
  });
}

// ── getAwaiting ─────────────────────────────────────────────────────────────

function registerGetAwaitingHandler(): () => void {
  return registerHandler({
    channel: CH.tokenLaunch.getAwaiting,
    domain: DOMAIN,
    inputSchema: tokenLaunchGetAwaitingInputSchema,
    outputSchema: tokenLaunchGetAwaitingResultSchema,
    handle: async (input, ctx): Promise<Result<TokenLaunchGetAwaitingResult>> => {
      // READ-ONLY, session-scoped, and NOT a spend surface: it returns the token
      // the agent proposed so the dialog can prefill. Nothing here is an amount
      // the signing path consumes — `preview` and `submit` still derive every
      // figure main-side from the form the user finally confirms.
      try {
        const awaiting = await getAwaitingLaunchForm(input.sessionId);
        // Logged at DEBUG-equivalent volume: this is polled/pushed often, and
        // an INFO line per idle read would drown the log. Ids only, never the
        // proposed name or amount.
        if (awaiting !== null) {
          log.info(
            `[ipc:vex:tokenLaunch:getAwaiting] form open intentId=${awaiting.intentId} `
              + `correlationId=${ctx.requestId}`,
          );
        }
        return ok({ awaiting });
      } catch (cause) {
        // Structural only — a DB error message can carry a connection string.
        log.warn(
          `[ipc:vex:tokenLaunch:getAwaiting] read failed correlationId=${ctx.requestId} `
            + `type=${cause instanceof Error ? cause.name : typeof cause}`,
        );
        return err({
          code: "internal.unexpected",
          domain: DOMAIN,
          message:
            "Vex could not check whether a launch form is waiting. Check that Vex services "
            + "are running and retry.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
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
    registerGetAwaitingHandler(),
  ];
}

export { refuse as __refuseForTests };
