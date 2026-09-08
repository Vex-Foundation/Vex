/**
 * pools.fun launch IPC (domain `poolsLaunch`) — `prepare`, `deploy`, `cancel`,
 * `cancelAwaitingForm`, `myLaunches`, `getAwaiting`, `claimPreview`, `claim`.
 *
 * THE BOUNDARY THIS FILE DEFENDS: the renderer describes the TOKEN; main decides
 * the MONEY. Every input schema is `.strict()` and carries no fee, value,
 * deadline, gas or wallet-address field. `deploy` takes ONLY the opaque
 * `fingerprintId`, so between the screen the user approved and the signature
 * there is no field through which the renderer could change anything.
 *
 * THE ONE RECIPIENT FIELD is a documented carve-out, not a leak: the manual form
 * may name who receives the future fee stream (owner decision, 2026-08-18), main
 * resolves it, and the resolved address comes back for the user to confirm
 * before Deploy. See `@shared/schemas/pools-launch.js`.
 *
 * NO NEW WIRE CODES. P3 mints nothing on the `VEX_ERROR_CODES` surface: the
 * runtime's named refusal kinds map onto codes that already exist, exactly as
 * `token-launch.ts` maps two of its own kinds onto `internal.unexpected` rather
 * than growing the contract from a handler. A kind that genuinely cannot be
 * expressed is a stop-and-ask, not a new entry.
 *
 * LOGGING records the operation, the status, the refusal kind and
 * `correlationId` only. Never the form, never an address, never an amount.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  poolsClaimedFeesSchema,
  poolsClaimInputSchema,
  poolsClaimPreviewSchema,
  poolsDeployedLaunchSchema,
  poolsLaunchCancelAwaitingFormInputSchema,
  poolsLaunchCancelAwaitingFormResultSchema,
  poolsLaunchCancelInputSchema,
  poolsLaunchCancelResultSchema,
  poolsLaunchDeployInputSchema,
  poolsLaunchGetAwaitingInputSchema,
  poolsLaunchGetAwaitingResultSchema,
  poolsLaunchMyLaunchesInputSchema,
  poolsLaunchMyLaunchesResultSchema,
  poolsLaunchPrepareInputSchema,
  poolsPreparedLaunchSchema,
} from "@shared/schemas/pools-launch.js";
import {
  claimPoolsFees,
  cancelAwaitingPoolsLaunchForm,
  cancelPoolsLaunch,
  deployPoolsLaunch,
  getAwaitingPoolsLaunchForm,
  listPoolsMyLaunches,
  preparePoolsLaunch,
  previewPoolsClaim,
  type PoolsLaunchRefusalOutcome,
} from "../pools-launch/index.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

const DOMAIN = "poolsLaunch" as const;

/**
 * Map a runtime refusal onto an EXISTING wire code.
 *
 * The kinds that map onto `internal.unexpected` do so for the reason
 * `token-launch.ts` already establishes: they are not the user's input to fix,
 * and minting a code from a handler would grow the wire contract without the
 * tests that pin it. The MESSAGE carries the precise cause in every case — a
 * verifier refusal names which check failed, a ceiling names the numbers.
 */
function refuse(
  refusal: PoolsLaunchRefusalOutcome,
  correlationId: string,
): Result<never, VexError> {
  const code = ((): VexError["code"] => {
    switch (refusal.kind) {
      case "invalid_inputs":
        return "validation.invalid_input";
      case "no_wallet":
        return "wallets.invalid_selection";
      case "wallet_unavailable":
        return "wallets.invalid_selection";
      case "insufficient_funds":
        return "wallet.insufficient_funds";
      // OUR read or OUR verifier refused, not the user's input. The message is
      // the actionable part; the code only says this was not a form mistake.
      case "pair_not_allowlisted":
      case "verifier_refused":
      case "fingerprint_expired":
      case "provider_unavailable":
      case "claim_ceiling_exceeded":
      // The ROW moved, not the input: the id the renderer sent is the one it
      // was given, so this is never the user's typing to fix. The MESSAGE names
      // the state the form is actually in, which is the only actionable part.
      case "form_not_cancellable":
        return "internal.unexpected";
    }
  })();

  log.warn(
    `[ipc:vex:poolsLaunch] refused kind=${refusal.kind} code=${code} `
      + `correlationId=${correlationId}`,
  );
  return err({
    code,
    domain: DOMAIN,
    message: refusal.detail,
    // An EXPIRED fingerprint is retryable: the user prepares again and reads the
    // new figures. A provider outage is retryable. A breached ceiling and a
    // refused verifier are NOT — retrying an unchanged launch repeats the same
    // refusal, and for a claim ceiling it is the mission contract that decides.
    retryable:
      refusal.kind === "fingerprint_expired" || refusal.kind === "provider_unavailable",
    // A verifier refusal and a ceiling are not things the user edits their way
    // out of from this form.
    userActionable:
      refusal.kind === "invalid_inputs"
      || refusal.kind === "no_wallet"
      || refusal.kind === "insufficient_funds"
      || refusal.kind === "fingerprint_expired",
    redacted: true,
    correlationId,
  });
}

/** One structural failure shape for a THROWN error — never the message. */
function unexpected(
  cause: unknown,
  correlationId: string,
  sentence: string,
): Result<never, VexError> {
  log.warn(
    `[ipc:vex:poolsLaunch] failed correlationId=${correlationId} `
      + `type=${cause instanceof Error ? cause.name : typeof cause}`,
  );
  return err({
    code: "internal.unexpected",
    domain: DOMAIN,
    message: sentence,
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function registerPrepareHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.prepare,
    domain: DOMAIN,
    inputSchema: poolsLaunchPrepareInputSchema,
    outputSchema: poolsPreparedLaunchSchema,
    handle: async (input, ctx) => {
      // STAGE 1. Uploads the image, prepares, and runs the FULL calldata
      // verifier. Signs nothing and spends nothing.
      try {
        const outcome = await preparePoolsLaunch(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        log.info(
          `[ipc:vex:poolsLaunch:prepare] ok imageLanded=${String(outcome.value.imageLanded)} `
            + `correlationId=${ctx.requestId}`,
        );
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Vex could not prepare that launch. Nothing was signed or spent. Retry, and check "
            + "that Vex services are running.",
        );
      }
    },
  });
}

function registerDeployHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.deploy,
    domain: DOMAIN,
    inputSchema: poolsLaunchDeployInputSchema,
    outputSchema: poolsDeployedLaunchSchema,
    handle: async (input, ctx) => {
      // STAGE 2 — THE SPEND CONSENT. The payload is the opaque fingerprint and
      // nothing else; main re-verifies it and authorizes exactly that calldata
      // and value.
      try {
        const outcome = await deployPoolsLaunch(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        log.info(
          `[ipc:vex:poolsLaunch:deploy] broadcast activityId=${outcome.value.activityId} `
            + `correlationId=${ctx.requestId}`,
        );
        return ok(outcome.value);
      } catch (cause) {
        // A THROW here cannot prove whether anything was signed, so the sentence
        // does not claim it was not. It points at the record that knows.
        return unexpected(
          cause,
          ctx.requestId,
          "Vex lost track of that launch while deploying it. Check Agent Scan and your "
            + "launches before trying again, so you do not launch twice.",
        );
      }
    },
  });
}

function registerCancelHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.cancel,
    domain: DOMAIN,
    inputSchema: poolsLaunchCancelInputSchema,
    outputSchema: poolsLaunchCancelResultSchema,
    handle: async (input, ctx) => {
      try {
        const outcome = await cancelPoolsLaunch(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Vex could not cancel that prepared launch. It expires on its own, and nothing "
            + "was signed.",
        );
      }
    },
  });
}

function registerCancelAwaitingFormHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.cancelAwaitingForm,
    domain: DOMAIN,
    inputSchema: poolsLaunchCancelAwaitingFormInputSchema,
    outputSchema: poolsLaunchCancelAwaitingFormResultSchema,
    handle: async (input, ctx) => {
      // THE DISMISSAL. It ends a DRAFT and wakes the agent turn parked on it;
      // it holds no fingerprint, builds no plan and touches no signer, and the
      // runtime refuses every status but `awaiting_user_form` by name, so it
      // cannot race a signature.
      try {
        const outcome = await cancelAwaitingPoolsLaunchForm(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        log.info(
          `[ipc:vex:poolsLaunch:cancelAwaitingForm] cancelled=${String(outcome.value.cancelled)} `
            + `resumed=${String(outcome.value.resumedAgentTurn)} correlationId=${ctx.requestId}`,
        );
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Vex could not cancel that launch request. Nothing was signed, and the form expires on "
            + "its own if it stays open.",
        );
      }
    },
  });
}

function registerMyLaunchesHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.myLaunches,
    domain: DOMAIN,
    inputSchema: poolsLaunchMyLaunchesInputSchema,
    outputSchema: poolsLaunchMyLaunchesResultSchema,
    handle: async (input, ctx) => {
      try {
        const outcome = await listPoolsMyLaunches(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Your pools.fun launches could not be read. Check that Vex services are running "
            + "and retry.",
        );
      }
    },
  });
}

function registerGetAwaitingHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.getAwaiting,
    domain: DOMAIN,
    inputSchema: poolsLaunchGetAwaitingInputSchema,
    outputSchema: poolsLaunchGetAwaitingResultSchema,
    handle: async (input, ctx) => {
      // `awaiting: null` is the ORDINARY answer and is a SUCCESS. It is polled
      // often, so only an open form is logged.
      try {
        const outcome = await getAwaitingPoolsLaunchForm(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        if (outcome.value.awaiting !== null) {
          log.info(
            `[ipc:vex:poolsLaunch:getAwaiting] form open `
              + `intentId=${outcome.value.awaiting.intentId} correlationId=${ctx.requestId}`,
          );
        }
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Vex could not check whether a pools.fun launch form is waiting. Check that Vex "
            + "services are running and retry.",
        );
      }
    },
  });
}

function registerClaimPreviewHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.claimPreview,
    domain: DOMAIN,
    inputSchema: poolsClaimInputSchema,
    outputSchema: poolsClaimPreviewSchema,
    handle: async (input, ctx) => {
      // READ-ONLY: an `eth_call` simulation. Nothing is signed.
      try {
        const outcome = await previewPoolsClaim(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Vex could not simulate that fee claim, so it will not guess what it would pay "
            + "out. Nothing was signed. Retry in a moment.",
        );
      }
    },
  });
}

function registerClaimHandler(): () => void {
  return registerHandler({
    channel: CH.poolsLaunch.claim,
    domain: DOMAIN,
    inputSchema: poolsClaimInputSchema,
    outputSchema: poolsClaimedFeesSchema,
    handle: async (input, ctx) => {
      try {
        const outcome = await claimPoolsFees(input);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        log.info(
          `[ipc:vex:poolsLaunch:claim] claimed activityId=${outcome.value.activityId} `
            + `correlationId=${ctx.requestId}`,
        );
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(
          cause,
          ctx.requestId,
          "Vex lost track of that fee claim. Check Agent Scan before retrying, so you do "
            + "not claim twice.",
        );
      }
    },
  });
}

/** Mount point for `register-all.ts` (coordinator-owned). */
export function registerPoolsLaunchHandlers(): ReadonlyArray<() => void> {
  return [
    registerPrepareHandler(),
    registerDeployHandler(),
    registerCancelHandler(),
    registerCancelAwaitingFormHandler(),
    registerMyLaunchesHandler(),
    registerGetAwaitingHandler(),
    registerClaimPreviewHandler(),
    registerClaimHandler(),
  ];
}

export { refuse as __refuseForTests };
