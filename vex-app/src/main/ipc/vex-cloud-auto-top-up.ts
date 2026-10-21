/**
 * Vex Inference low-balance alert and auto top-up IPC (domain `vexCloud`).
 * Mounted by `registerVexCloudHandlers` over the composed runtime
 * (`vex-cloud/runtime.ts`), so the funding page, the poller and the agent
 * tool share one store and one set of deps.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer sends a percent, the form's
 * fields (a wallet it picked, amounts as text, a count, a number of days), or
 * a proposal id with the action and bounds the user saw. It never sends a
 * destination (the pinned deposit address), a rate, a cap it did not type, a
 * rule version it did not read, a key or a bearer.
 *
 * `submitAutoTopUp` creates or changes the authority automatic deposits are
 * signed under, so it is execution-gated (`EXECUTION_GATED_CHANNELS`). The
 * alert setting moves nothing and is not.
 */

import type { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  vexCloudAlertGetInputSchema,
  vexCloudAlertSchema,
  vexCloudAlertSetInputSchema,
  vexCloudAutoTopUpGetInputSchema,
  vexCloudAutoTopUpGetResultSchema,
  vexCloudAutoTopUpProposalSchema,
  vexCloudPrepareAutoTopUpInputSchema,
  vexCloudSubmitAutoTopUpInputSchema,
  vexCloudSubmitAutoTopUpResultSchema,
  type VexCloudAlert,
} from "@shared/schemas/vex-cloud-auto-top-up.js";
import { log } from "../logger/index.js";
import { prepareAutoTopUp, readAutoTopUp, submitAutoTopUp } from "../vex-cloud/auto-top-up/rule-proposals.js";
import { requireBearer } from "../vex-cloud/funding/backend-call.js";
import { refused, vexCloudRefusalError, type VexCloudOutcome } from "../vex-cloud/outcome.js";
import type { VexInferenceRuntime } from "../vex-cloud/runtime.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

const DOMAIN = "vexCloud" as const;

function settle<T>(operation: string, outcome: VexCloudOutcome<T>, correlationId: string): Result<T, VexError> {
  if (outcome.ok) return ok(outcome.value);
  const error = vexCloudRefusalError(outcome.refusal, correlationId);
  log.info(`[ipc:vex:vexCloud:${operation}] refused kind=${outcome.refusal.kind} code=${error.code} correlationId=${correlationId}`);
  return err(error);
}

function mount<I, O>(args: {
  readonly operation: string;
  readonly channel: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly run: (input: I, ctx: HandlerContext) => Promise<VexCloudOutcome<O>>;
  readonly onThrow: string;
}): () => void {
  return registerHandler({
    channel: args.channel,
    domain: DOMAIN,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    handle: async (input, ctx): Promise<Result<O>> => {
      try {
        return settle(args.operation, await args.run(input, ctx), ctx.requestId);
      } catch (cause) {
        log.warn(
          `[ipc:vex:vexCloud:${args.operation}] failed correlationId=${ctx.requestId} type=${cause instanceof Error ? cause.name : typeof cause}`,
        );
        return err({
          code: "internal.unexpected",
          domain: DOMAIN,
          message: args.onThrow,
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
    },
  });
}

/** The alert setting plus the stored observation of the signed-in account. */
async function readAlert(runtime: VexInferenceRuntime): Promise<VexCloudOutcome<VexCloudAlert>> {
  const alertPercent = await runtime.store.readAlertPercent();
  const bearer = await requireBearer(runtime.deposit);
  if (!bearer.ok) return { ok: true, value: { alertPercent, observation: null } };
  const accountId = runtime.conditions().signedInAccountId;
  const row = accountId === null ? null : await runtime.store.readBalanceWatch(accountId);
  if (row === null) return { ok: true, value: { alertPercent, observation: null } };
  const thresholdWei = (row.referenceWei * BigInt(alertPercent)) / 100n;
  return {
    ok: true,
    value: {
      alertPercent,
      observation: {
        balanceWei: row.lastBalanceWei.toString(),
        referenceWei: row.referenceWei.toString(),
        thresholdWei: thresholdWei.toString(),
        belowAlert: row.lastBalanceWei < thresholdWei,
      },
    },
  };
}

export function registerVexCloudAutoTopUpHandlers(runtime: VexInferenceRuntime): ReadonlyArray<() => void> {
  return [
    mount({
      operation: "alertGet",
      channel: CH.vexCloud.alertGet,
      inputSchema: vexCloudAlertGetInputSchema,
      outputSchema: vexCloudAlertSchema,
      run: () => readAlert(runtime),
      onThrow: "The low-balance alert could not be read. Try again in a moment.",
    }),
    mount({
      operation: "alertSet",
      channel: CH.vexCloud.alertSet,
      inputSchema: vexCloudAlertSetInputSchema,
      outputSchema: vexCloudAlertSchema,
      run: async (input, ctx) => {
        if (ctx.signal.aborted) return refused("cancelled", "Cancelled. The alert was not changed.");
        await runtime.store.writeAlertPercent(input.alertPercent);
        return readAlert(runtime);
      },
      onThrow: "The low-balance alert could not be saved. Nothing was changed; try again in a moment.",
    }),
    mount({
      operation: "autoTopUpGet",
      channel: CH.vexCloud.autoTopUpGet,
      inputSchema: vexCloudAutoTopUpGetInputSchema,
      outputSchema: vexCloudAutoTopUpGetResultSchema,
      run: (_input, ctx) => readAutoTopUp(runtime.ruleOwner, ctx.signal),
      onThrow: "Your auto top-up rule could not be read. Try again in a moment.",
    }),
    mount({
      operation: "prepareAutoTopUp",
      channel: CH.vexCloud.prepareAutoTopUp,
      inputSchema: vexCloudPrepareAutoTopUpInputSchema,
      outputSchema: vexCloudAutoTopUpProposalSchema,
      run: (input, ctx) => prepareAutoTopUp(runtime.ruleOwner, input, ctx.signal),
      onThrow: "The auto top-up change could not be prepared. Nothing was changed; try again in a moment.",
    }),
    mount({
      operation: "submitAutoTopUp",
      channel: CH.vexCloud.submitAutoTopUp,
      inputSchema: vexCloudSubmitAutoTopUpInputSchema,
      outputSchema: vexCloudSubmitAutoTopUpResultSchema,
      run: (input, ctx) => submitAutoTopUp(runtime.ruleOwner, input, ctx.signal, ctx.requestId),
      // A THROW cannot prove whether the change was stored; the Auto top-up tab reads it back.
      onThrow: "Vex lost track of this auto top-up change. Reload the Auto top-up tab to see the rule as it is stored before trying again.",
    }),
  ];
}
