/**
 * Vex Cloud IPC (domain `vexCloud`): `signIn`, `account`, `signOut`; the
 * funding channels (phase 2) are mounted from `./vex-cloud-funding.ts`.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer names the wallets the user saw
 * beside the consent and nothing else. Main signs with the vault, against the
 * host it dials, and keeps the session bearer in the vault: no message,
 * signature, bearer or URL crosses in either direction.
 *
 * `signIn` SIGNS, so it sits behind the execution gate
 * (`lifecycle/execution-gate.ts`), after sender validation and before this
 * body, like every other channel that starts wallet work. At most one
 * sign-in runs at a time; a second is refused by name rather than racing the
 * first to the vault.
 *
 * NO NEW WIRE CODES, the `poolsLaunch` precedent: the owner's named refusal
 * kinds map onto codes that already exist, and the message carries the exact
 * cause and the next step.
 *
 * LOGGING records the operation, the outcome kind and `correlationId` only:
 * never an address, a message, a signature or a bearer.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  vexCloudAccountInputSchema,
  vexCloudAccountResultSchema,
  vexCloudSignInInputSchema,
  vexCloudSignInResultSchema,
  vexCloudSignOutInputSchema,
  vexCloudSignOutResultSchema,
  type VexCloudAccountResult,
  type VexCloudSignInResult,
  type VexCloudSignOutResult,
} from "@shared/schemas/vex-cloud.js";
import { log } from "../logger/index.js";
import { readVexCloudAccount, toVexCloudAccount } from "../vex-cloud/account.js";
import { vexCloudRefusalError, type VexCloudRefusal } from "../vex-cloud/outcome.js";
import { productionVexCloudDeps, type VexCloudDeps } from "../vex-cloud/production.js";
import { signInToVexCloud } from "../vex-cloud/sign-in.js";
import { registerHandler } from "./register-handler.js";
import { registerVexCloudFundingHandlers } from "./vex-cloud-funding.js";
import { registerVexCloudAutoTopUpHandlers } from "./vex-cloud-auto-top-up.js";
import { startVexInferenceRuntime, stopVexInferenceRuntime, type VexInferenceRuntime } from "../vex-cloud/runtime.js";

const DOMAIN = "vexCloud" as const;

function refuse(refusal: VexCloudRefusal, correlationId: string): Result<never, VexError> {
  const error = vexCloudRefusalError(refusal, correlationId);
  log.info(`[ipc:vex:vexCloud] refused kind=${refusal.kind} code=${error.code} correlationId=${correlationId}`);
  return err(error);
}

function unexpected(cause: unknown, correlationId: string, sentence: string): Result<never, VexError> {
  log.warn(
    `[ipc:vex:vexCloud] failed correlationId=${correlationId} type=${cause instanceof Error ? cause.name : typeof cause}`,
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

let signInRunning = false;

function registerSignInHandler(deps: VexCloudDeps): () => void {
  return registerHandler({
    channel: CH.vexCloud.signIn,
    domain: DOMAIN,
    inputSchema: vexCloudSignInInputSchema,
    outputSchema: vexCloudSignInResultSchema,
    handle: async (input, ctx): Promise<Result<VexCloudSignInResult>> => {
      if (signInRunning) {
        return refuse({ kind: "already_running", detail: "A Vex Inference sign-in is already running. Wait for it to finish." }, ctx.requestId);
      }
      signInRunning = true;
      try {
        const outcome = await signInToVexCloud(
          { ...deps.signIn, api: deps.api },
          input.wallets,
          ctx.signal,
          ctx.requestId,
        );
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        // The session is stored. Read the account with it so the screen shows
        // the balance at once; a failed read is not a failed sign-in.
        const read = await deps.api.readAccount(outcome.value.token, ctx.signal);
        const account = read.ok ? toVexCloudAccount(read.value, deps.account.now()) : null;
        return ok({
          accountId: outcome.value.accountId,
          created: outcome.value.created,
          linkedNow: outcome.value.linkedNow,
          account,
        });
      } catch (cause) {
        // A THROW cannot prove whether a session was stored, so the sentence
        // does not claim either; the account read answers.
        return unexpected(
          cause,
          ctx.requestId,
          "Vex Inference sign-in stopped unexpectedly. Open Settings, Inference, to see whether you are signed in, then try again.",
        );
      } finally {
        signInRunning = false;
      }
    },
  });
}

function registerAccountHandler(deps: VexCloudDeps): () => void {
  return registerHandler({
    channel: CH.vexCloud.account,
    domain: DOMAIN,
    inputSchema: vexCloudAccountInputSchema,
    outputSchema: vexCloudAccountResultSchema,
    handle: async (_input, ctx): Promise<Result<VexCloudAccountResult>> => {
      try {
        const outcome = await readVexCloudAccount({ ...deps.account, api: deps.api }, ctx.signal);
        if (!outcome.ok) return refuse(outcome.refusal, ctx.requestId);
        return ok(outcome.value);
      } catch (cause) {
        return unexpected(cause, ctx.requestId, "Your Vex Inference account could not be read. Try again in a moment.");
      }
    },
  });
}

function registerSignOutHandler(deps: VexCloudDeps): () => void {
  return registerHandler({
    channel: CH.vexCloud.signOut,
    domain: DOMAIN,
    inputSchema: vexCloudSignOutInputSchema,
    outputSchema: vexCloudSignOutResultSchema,
    handle: async (_input, ctx): Promise<Result<VexCloudSignOutResult>> => {
      // Removing the local session is the whole effect: the bearer leaves the
      // vault and the engine's provider cache is reset with it.
      const cleared = await deps.clearSession();
      if (!cleared.ok) return err({ ...cleared.error, domain: DOMAIN, correlationId: ctx.requestId });
      log.info(`[ipc:vex:vexCloud:signOut] ok correlationId=${ctx.requestId}`);
      return ok({ signedOut: true });
    },
  });
}

/**
 * Mount point for `register-all.ts`. Called with no arguments in production:
 * the Vex Inference runtime (engine host, auto top-up poller, balance watch)
 * is started over the production deps and every handler reads the account
 * through its tracker. A test passing its own `deps` gets no runtime (and no
 * alert or auto top-up channels) unless it passes one.
 */
export function registerVexCloudHandlers(
  deps?: VexCloudDeps,
  runtime?: VexInferenceRuntime,
): ReadonlyArray<() => void> {
  const resolved = deps ?? productionVexCloudDeps();
  const live = runtime ?? (deps === undefined ? startVexInferenceRuntime(resolved) : undefined);
  const effective: VexCloudDeps = live === undefined
    ? resolved
    : {
      ...resolved,
      api: { ...resolved.api, readAccount: live.deposit.api.readAccount },
      clearSession: live.deposit.clearSession,
      account: { ...resolved.account, clearSession: live.deposit.clearSession },
    };
  return [
    registerSignInHandler(effective),
    registerAccountHandler(effective),
    registerSignOutHandler(effective),
    ...registerVexCloudFundingHandlers(effective),
    ...(live === undefined
      ? []
      : [
        ...registerVexCloudAutoTopUpHandlers(live),
        () => {
          void stopVexInferenceRuntime();
        },
      ]),
  ];
}

