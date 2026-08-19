/**
 * The NARROW slice of an execution that the approval legs actually need.
 *
 * Both lanes run the same approval legs: a vault deposit and a market operation
 * differ entirely in what they do afterwards, and not at all in "approve an exact
 * amount to a spender, then prove it landed". So the approval loop is written
 * against this interface rather than against either lane's full context, and
 * both contexts satisfy it structurally.
 *
 * WHY IT IS AN INTERFACE AND NOT A SHARED BAG. Two assumptions used to be
 * implicit in the approval loop and both were only true by accident of the vault
 * lane's shape:
 *
 *   1. "the last leg is the operation leg", which the loop encoded as
 *      `legs.length - 1`. A lane that ever plans a trailing leg would have had
 *      its operation silently treated as an approval. It is now
 *      `operationLegIndex`, stated by the planner that knows.
 *   2. "the thing after the approvals is a vault operation", which the loop said
 *      out loud in two user-facing sentences. A collateral supply is not a vault
 *      operation, and telling a borrower otherwise is a lie about what did not
 *      happen. It is now `operationLabel`.
 *
 * The residual-allowance fields are here for the same reason: the sentence is
 * about the APPROVED AMOUNT and its token, which on a shares repayment is the
 * over-pull rather than the debt, and only the planning lane knows which.
 */

import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";

import type { MorphoActionClient, MorphoAllowancePlan } from "@tools/morpho/mutations.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

import type { MorphoLegPlan } from "./intent.js";

/** The client pair one execution runs against. Both must be the SAME chain. */
export interface MorphoExecutionClients {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  /**
   * The Morpho-extended client the build and the reads go through. Extend the
   * SAME public client above with `morphoActionsExtension()`, so the market or
   * vault is read from the chain the transaction is sent to.
   */
  readonly actionClient: MorphoActionClient;
}

export interface MorphoAllowanceContext {
  readonly clients: MorphoExecutionClients;
  readonly request: { readonly toolId: string };
  readonly executionId: number;
  readonly events: readonly AgentActivityEvent[];
  readonly legs: readonly MorphoLegPlan[];
  /**
   * Index of the operation leg. Every leg BEFORE it is an approval leg, and the
   * approval loop stops there. Stated rather than inferred from the leg count.
   */
  readonly operationLegIndex: number;
  /** How to name the operation in a sentence: "vault deposit", "collateral supply". */
  readonly operationLabel: string;
  /** The amount the approval GRANTS, in raw units of the approved token. */
  readonly approvalAmountRaw: bigint;
  readonly approvalDecimals: number;
  readonly approvalSymbol: string | null;
  readonly allowancePlan: MorphoAllowancePlan | null;
  /** The residual-allowance sentence, once an approval has definitively landed. */
  residual: string | null;
  /** The read-after-write anchor for the NEXT leg's pre-sign estimate. */
  priorLeg: ConfirmedPriorLeg | undefined;
}
