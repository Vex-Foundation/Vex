/**
 * Vex Cloud funding IPC (domain `vexCloud`, phase 2): deposit, withdraw,
 * cashback and history. Mounted by `registerVexCloudHandlers`.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer sends a wallet it picked, an
 * amount as text, or a proposal id with the figures the user saw. It never
 * sends a destination for a deposit (main pins it), never a free address for
 * a withdrawal (main accepts only a wallet linked AND in this app), never a
 * fee, a rate, a key or a bearer.
 *
 * `submitDeposit` SIGNS, `submitWithdrawal` and `claimCashback` move the
 * account's funds: all three sit behind the execution gate
 * (`lifecycle/execution-gate.ts`), after sender validation and before this
 * body. The deposit owner re-checks the gate again right before the key.
 *
 * NO NEW WIRE CODES: the owners' named refusal kinds map onto existing codes
 * (`vex-cloud/outcome.ts`), and every message names the cause and the next
 * step. LOGGING: operation, outcome kind and correlation id only.
 */

import type { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  vexCloudActivityInputSchema,
  vexCloudActivityResultSchema,
  vexCloudClaimCashbackInputSchema,
  vexCloudClaimCashbackResultSchema,
  vexCloudDepositProposalSchema,
  vexCloudDepositsInputSchema,
  vexCloudDepositsResultSchema,
  vexCloudDepositWalletsInputSchema,
  vexCloudDepositWalletsResultSchema,
  vexCloudPrepareDepositInputSchema,
  vexCloudPrepareWithdrawalInputSchema,
  vexCloudSubmitDepositInputSchema,
  vexCloudSubmitDepositResultSchema,
  vexCloudSubmitWithdrawalInputSchema,
  vexCloudSubmitWithdrawalResultSchema,
  vexCloudUsageInputSchema,
  vexCloudUsageResultSchema,
  vexCloudWithdrawalProposalSchema,
  vexCloudWithdrawalStatusInputSchema,
  vexCloudWithdrawalStatusResultSchema,
} from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../logger/index.js";
import { claimCashbackToBalance } from "../vex-cloud/funding/cashback.js";
import {
  listDepositWallets,
  prepareDeposit,
  submitDeposit,
} from "../vex-cloud/funding/deposit.js";
import type { DepositDeps } from "../vex-cloud/funding/deposit-core.js";
import { readActivity, readDeposits, readUsage, type HistoryDeps } from "../vex-cloud/funding/history.js";
import {
  prepareWithdrawal,
  readWithdrawalStatus,
  submitWithdrawal,
  type WithdrawDeps,
} from "../vex-cloud/funding/withdraw.js";
import { vexCloudRefusalError, type VexCloudOutcome } from "../vex-cloud/outcome.js";
import type { VexCloudDeps } from "../vex-cloud/production.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

const DOMAIN = "vexCloud" as const;

function settle<T>(operation: string, outcome: VexCloudOutcome<T>, correlationId: string): Result<T, VexError> {
  if (outcome.ok) return ok(outcome.value);
  const error = vexCloudRefusalError(outcome.refusal, correlationId);
  log.info(`[ipc:vex:vexCloud:${operation}] refused kind=${outcome.refusal.kind} code=${error.code} correlationId=${correlationId}`);
  return err(error);
}

function unexpected(operation: string, cause: unknown, correlationId: string, sentence: string): Result<never, VexError> {
  log.warn(
    `[ipc:vex:vexCloud:${operation}] failed correlationId=${correlationId} type=${cause instanceof Error ? cause.name : typeof cause}`,
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

function mount<I, O>(args: {
  readonly operation: string;
  readonly channel: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly run: (input: I, ctx: HandlerContext) => Promise<VexCloudOutcome<O>>;
  /** What the user reads when the owner THROWS: it must not claim more than is known. */
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
        return unexpected(args.operation, cause, ctx.requestId, args.onThrow);
      }
    },
  });
}

/** Mount point used by `registerVexCloudHandlers`. */
export function registerVexCloudFundingHandlers(deps: VexCloudDeps): ReadonlyArray<() => void> {
  const session = { readSession: deps.account.readSession, clearSession: deps.clearSession };
  const deposit: DepositDeps = { ...deps.deposit, ...session, api: deps.api };
  const withdraw: WithdrawDeps = { ...session, api: deps.api, localWallets: deps.account.localWallets, now: deps.account.now };
  const history: HistoryDeps = { ...session, api: deps.api };

  return [
    mount({
      operation: "depositWallets",
      channel: CH.vexCloud.depositWallets,
      inputSchema: vexCloudDepositWalletsInputSchema,
      outputSchema: vexCloudDepositWalletsResultSchema,
      run: (_input, ctx) => listDepositWallets(deposit, ctx.signal),
      onThrow: "Your wallets' VEX balances could not be read. Try again in a moment.",
    }),
    mount({
      operation: "prepareDeposit",
      channel: CH.vexCloud.prepareDeposit,
      inputSchema: vexCloudPrepareDepositInputSchema,
      outputSchema: vexCloudDepositProposalSchema,
      run: (input, ctx) => prepareDeposit(deposit, input, ctx.signal),
      onThrow: "The deposit could not be prepared. Nothing was signed; try again in a moment.",
    }),
    mount({
      operation: "submitDeposit",
      channel: CH.vexCloud.submitDeposit,
      inputSchema: vexCloudSubmitDepositInputSchema,
      outputSchema: vexCloudSubmitDepositResultSchema,
      run: (input, ctx) => submitDeposit(deposit, input, ctx.signal, ctx.requestId),
      // A THROW cannot prove whether the transfer was sent; History and the wallet do.
      onThrow:
        "Vex lost track of this deposit while sending it. Check History and the wallet's balance before depositing again, so you do not send twice.",
    }),
    mount({
      operation: "prepareWithdrawal",
      channel: CH.vexCloud.prepareWithdrawal,
      inputSchema: vexCloudPrepareWithdrawalInputSchema,
      outputSchema: vexCloudWithdrawalProposalSchema,
      run: (input, ctx) => prepareWithdrawal(withdraw, input, ctx.signal),
      onThrow: "The withdrawal could not be prepared. Nothing was sent; try again in a moment.",
    }),
    mount({
      operation: "submitWithdrawal",
      channel: CH.vexCloud.submitWithdrawal,
      inputSchema: vexCloudSubmitWithdrawalInputSchema,
      outputSchema: vexCloudSubmitWithdrawalResultSchema,
      run: (input, ctx) => submitWithdrawal(withdraw, input, ctx.signal, ctx.requestId),
      onThrow: "Vex lost track of this withdrawal while sending it. Check History before trying again.",
    }),
    mount({
      operation: "withdrawal",
      channel: CH.vexCloud.withdrawal,
      inputSchema: vexCloudWithdrawalStatusInputSchema,
      outputSchema: vexCloudWithdrawalStatusResultSchema,
      run: (input, ctx) => readWithdrawalStatus(withdraw, input.withdrawalId, ctx.signal),
      onThrow: "The withdrawal status could not be read. Try again in a moment.",
    }),
    mount({
      operation: "claimCashback",
      channel: CH.vexCloud.claimCashback,
      inputSchema: vexCloudClaimCashbackInputSchema,
      outputSchema: vexCloudClaimCashbackResultSchema,
      run: (_input, ctx) => claimCashbackToBalance({ ...session, api: deps.api }, ctx.signal, ctx.requestId),
      onThrow: "Vex lost track of this cashback claim. Check your balance before claiming again.",
    }),
    mount({
      operation: "activity",
      channel: CH.vexCloud.activity,
      inputSchema: vexCloudActivityInputSchema,
      outputSchema: vexCloudActivityResultSchema,
      run: (input, ctx) => readActivity(history, input, ctx.signal),
      onThrow: "Your Vex Inference activity could not be read. Try again in a moment.",
    }),
    mount({
      operation: "usage",
      channel: CH.vexCloud.usage,
      inputSchema: vexCloudUsageInputSchema,
      outputSchema: vexCloudUsageResultSchema,
      run: (input, ctx) => readUsage(history, input, ctx.signal),
      onThrow: "Your Vex Inference usage could not be read. Try again in a moment.",
    }),
    mount({
      operation: "deposits",
      channel: CH.vexCloud.deposits,
      inputSchema: vexCloudDepositsInputSchema,
      outputSchema: vexCloudDepositsResultSchema,
      run: (input, ctx) => readDeposits(history, input, ctx.signal),
      onThrow: "Your Vex Inference deposits could not be read. Try again in a moment.",
    }),
  ];
}
