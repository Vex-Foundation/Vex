/**
 * The EXECUTION SPINE: plan, record, then send the legs in order.
 *
 * It is a short function on purpose. Everything it decides is SEQUENCING - which
 * phase runs when, and what state travels between the legs - while the two
 * things that can go wrong per leg live in `./allowance-legs.ts` and
 * `./operation-leg.ts`, one file per responsibility.
 *
 * The context below is the only shared mutable state and it carries exactly two
 * facts a later leg needs from an earlier one: whether an approval has landed
 * (so a failure can name the residual it left) and the block anchor of the last
 * confirmed leg (so the next pre-sign estimate is not answered by a node that
 * has not applied it yet). Nothing else is threaded, deliberately - a wider
 * shared bag is how ordering assumptions become invisible.
 */

import { getAddress } from "viem";
import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";

import {
  prepareMorphoVaultExecution,
  type MorphoActionClient,
  type MorphoAllowancePlan,
  type MorphoVaultState,
} from "@tools/morpho/mutations.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

import { createMorphoIntent, planMorphoLegs, type MorphoLegPlan } from "./intent.js";
import { runAllowanceLegs } from "./allowance-legs.js";
import { runOperationLeg } from "./operation-leg.js";
import type { MorphoExecutionOutcome } from "./outcome.js";

/** The client pair one execution runs against. Both must be the SAME chain. */
export interface MorphoExecutionClients {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  /**
   * The Morpho-extended client the build and the reads go through. Extend the
   * SAME public client above with `morphoActionsExtension()`, so the vault is
   * read from the chain the transaction is sent to.
   */
  readonly actionClient: MorphoActionClient;
}

export interface MorphoVaultExecutionRequest {
  readonly toolId: string;
  readonly sessionId: string;
  /** Raw handler params - sanitized inside `createExecutionIntent`, not here. */
  readonly intentParams: Record<string, unknown>;
  /** Resolved from Vex's own chain registry. NEVER from model input. */
  readonly chainId: number;
  readonly vaultAddress: Address;
  /** The wallet that signs. Must be the wallet client's own account. */
  readonly walletAddress: Address;
  /** The ASSET amount, in raw base units. Never a share count. */
  readonly amountRaw: bigint;
  /** Price protection, resolved by the handler from the slippage policy. */
  readonly slippageBps: number;
}

/** Everything the legs share. See the header for why it is exactly this much. */
export interface MorphoExecutionContext {
  readonly clients: MorphoExecutionClients;
  readonly request: MorphoVaultExecutionRequest;
  readonly direction: "deposit" | "withdraw";
  readonly executionId: number;
  readonly events: readonly AgentActivityEvent[];
  readonly legs: readonly MorphoLegPlan[];
  readonly state: MorphoVaultState;
  readonly allowancePlan: MorphoAllowancePlan | null;
  readonly expectedSharesRaw: bigint;
  readonly verifiedTarget: Address;
  /** The residual-allowance sentence, once an approval has definitively landed. */
  residual: string | null;
  /** The read-after-write anchor for the NEXT leg's pre-sign estimate. */
  priorLeg: ConfirmedPriorLeg | undefined;
}

/**
 * Run one Morpho vault execution end to end.
 *
 * @throws for a PLAN-time refusal only, before any durable row exists and before
 * anything is signed. Every later failure is a RETURNED outcome carrying the
 * execution id, because by then a record of it exists and must be reported
 * rather than thrown away.
 */
export async function runMorphoExecution(
  clients: MorphoExecutionClients,
  request: MorphoVaultExecutionRequest,
  direction: "deposit" | "withdraw",
): Promise<MorphoExecutionOutcome> {
  // PHASE 1. Fresh accrued read, build, leg-by-leg decode, allowance plan and
  // its cross-check against the SDK. A throw here is pre-intent and
  // pre-signature: it propagates so the caller records a clean refusal with
  // nothing to stage and nothing to sweep.
  const prepared = await prepareMorphoVaultExecution(
    {
      chainId: request.chainId,
      vaultAddress: request.vaultAddress,
      direction,
      amountRaw: request.amountRaw,
      slippageBps: request.slippageBps,
      walletAddress: request.walletAddress,
    },
    { client: clients.actionClient },
  );

  // The target this execution is PLANNED and RECORDED against: the pinned
  // Bundler3 on a deposit, the vault itself on a withdrawal, as accepted by the
  // handler's own bundle decoder. Phase 2's rebuild is held to it.
  const verifiedTarget = getAddress(prepared.bundle.to);

  const legs = planMorphoLegs({
    toolId: request.toolId,
    sessionId: request.sessionId,
    intentParams: request.intentParams,
    chainId: request.chainId,
    walletAddress: request.walletAddress,
    direction,
    state: prepared.state,
    amountRaw: request.amountRaw,
    expectedSharesRaw: prepared.expectedSharesRaw,
    allowancePlan: prepared.allowancePlan,
    verifiedTarget,
  });

  // The durable rows exist BEFORE a signature does. A throw here is still
  // pre-signature: refusing to transact beats transacting untracked.
  const { executionId, events } = await createMorphoIntent(request.toolId, request.intentParams, legs);

  const context: MorphoExecutionContext = {
    clients,
    request,
    direction,
    executionId,
    events,
    legs,
    state: prepared.state,
    allowancePlan: prepared.allowancePlan,
    expectedSharesRaw: prepared.expectedSharesRaw,
    verifiedTarget,
    residual: null,
    priorLeg: undefined,
  };

  const allowanceOutcome = await runAllowanceLegs(context);
  if (allowanceOutcome !== null) return allowanceOutcome;
  return runOperationLeg(context);
}
