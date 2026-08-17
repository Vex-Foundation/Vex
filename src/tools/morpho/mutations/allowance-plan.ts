/**
 * THE SINGLE OWNER OF THE ALLOWANCE FACT for a Morpho vault operation.
 *
 * The owner's ruling of 2026-08-17 (option B) in one sentence: the quote and the
 * execution must read the allowance in ONE place, and the SDK's own requirement
 * list becomes a cross-check that has to agree or the operation refuses. The
 * alternative - the preview asking the SDK what is needed while the executor
 * reads the chain itself - is two independent readers of the same money fact,
 * free to drift between the moment a user is shown a plan and the moment the
 * wallet signs it. Rules/04 forbids exactly that shape.
 *
 * WHAT THE PLAN CONTAINS AND WHY IT IS TRANSACTIONS, NOT ADVICE. Every step here
 * is a ready-to-stage `{to, data}` pair, because Agent Scan's staged-broadcast
 * contract needs one durable `agent_activity` row per BROADCAST, created before
 * anything is signed. A plan that said "an approval is needed" without saying
 * which transaction would carry it would force the executor to re-derive the
 * calldata, which is the second copy this module exists to prevent.
 *
 * THE THREE SHAPES, and the evidence for the third:
 *
 *   none-needed        - the standing allowance already covers this operation.
 *   approve            - one `approve(adapter, exactAmount)`.
 *   reset-then-approve - `approve(adapter, 0)` first, then the exact approval.
 *
 * The reset exists because some tokens (USDT is the canonical one) revert an
 * `approve` that moves a NON-ZERO allowance to another non-zero value. Vex
 * already carries that precedent in `@tools/kyberswap/evm/allowance-plan.ts` and
 * this module mirrors it deliberately rather than inventing a second rule. It is
 * applied by allowance STATE, not by a token allowlist: a hardcoded list of
 * "USDT-style" tokens is a list that is wrong the day a vault admits a token
 * nobody added to it, and a redundant reset costs one cheap transaction while a
 * missing one costs a reverted approval.
 *
 * WHY THE APPROVAL IS EXACT AND TO GENERALADAPTER1 ONLY. That policy, and the
 * reasoning behind it, lives in `./requirements.ts`, which also owns the pinned
 * adapter lookup. Nothing here re-decides it: `requireGeneralAdapter1` is the
 * one door to that address and a chain the registry does not pin is refused by
 * name rather than routed through a guessed deployment.
 *
 * NOTHING HERE SIGNS OR SENDS. The only chain access is one `allowance()` read.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { sanitizeMorphoCause } from "../errors.js";
import { ERC20_ALLOWANCE_ABI } from "../wallet-reads.js";
import { MORPHO_SPENDER_LABELS } from "../constants.js";
import {
  requireGeneralAdapter1,
  type MorphoApprovalRequirement,
  type MorphoRequirement,
} from "./requirements.js";

/** The minimal `approve` fragment. Encoding only; no read uses it. */
const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** What a plan step DOES, in the vocabulary Agent Scan's `event_role` uses. */
export type MorphoAllowanceStepKind = "allowance_reset" | "allowance";

/** One ready-to-stage transaction. The executor signs this verbatim. */
export interface MorphoAllowanceStep {
  readonly kind: MorphoAllowanceStepKind;
  /** The transaction target, which is always the asset's own ERC-20 contract. */
  readonly to: Address;
  readonly data: Hex;
  /** The spender being authorised: the chain's pinned GeneralAdapter1, always. */
  readonly spender: Address;
  /** `0` on a reset, EXACTLY the operation's own amount on an approval. */
  readonly amountRaw: bigint;
  readonly explanation: string;
}

export type MorphoAllowancePlanShape = "none-needed" | "approve" | "reset-then-approve";

export interface MorphoAllowancePlan {
  readonly shape: MorphoAllowancePlanShape;
  /** The vault's own asset, read from the vault and never from a caller. */
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly spenderRole: string;
  /** What the operation needs the adapter to be able to pull. */
  readonly requiredAmountRaw: bigint;
  /** What the chain says the adapter may pull right now. Never a guess. */
  readonly currentAllowanceRaw: bigint;
  /** In send order. Empty when the standing allowance already suffices. */
  readonly steps: readonly MorphoAllowanceStep[];
}

/** The one read this module performs. Narrow on purpose: one owner, one spender, one token. */
interface AllowanceReader {
  readContract: (args: {
    address: Address;
    abi: typeof ERC20_ALLOWANCE_ABI;
    functionName: "allowance";
    args: readonly [Address, Address];
  }) => Promise<unknown>;
}

/** Encode `approve(spender, amount)` for the staged-broadcast primitive. */
export function buildMorphoApproveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [spender, amount] });
}

export interface MorphoAllowancePlanRequest {
  readonly chainId: number;
  /** The vault's underlying ERC-20. */
  readonly assetAddress: Address;
  /** The wallet whose funds the adapter would pull. */
  readonly walletAddress: Address;
  /** The operation's own amount, in the asset's raw base units. */
  readonly requiredAmountRaw: bigint;
}

/**
 * Read the standing allowance to the chain's pinned GeneralAdapter1 and decide
 * which approval transactions this operation needs.
 *
 * A FAILED READ IS NOT A ZERO, and here it is not even a "needs an approval": an
 * allowance this module could not read is an allowance it cannot plan around, so
 * the whole operation is refused. Treating an unanswered read as zero would
 * schedule an approval that may be redundant, and treating it as sufficient
 * would schedule a deposit that reverts after the gas is spent. Both invent a
 * fact the chain did not supply.
 *
 * @throws {VexError} `MORPHO_APPROVAL_POLICY_VIOLATION` when the chain has no
 * pinned GeneralAdapter1, `MORPHO_RPC_ERROR` when the allowance did not read.
 */
export async function planMorphoAllowance(
  client: AllowanceReader,
  request: MorphoAllowancePlanRequest,
): Promise<MorphoAllowancePlan> {
  if (request.requiredAmountRaw <= 0n) {
    throw new VexError(
      ErrorCodes.MORPHO_INVALID_RESPONSE,
      `A Morpho allowance plan needs a positive operation amount; ${request.requiredAmountRaw} raw units is not one.`,
      "Nothing was read or approved. Send the amount in the asset's RAW base units as a whole-number string.",
    );
  }

  const spender = requireGeneralAdapter1(request.chainId) as Address;
  const token = request.assetAddress;
  const owner = request.walletAddress;

  let currentAllowanceRaw: bigint;
  try {
    const read = await client.readContract({
      address: token,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (typeof read !== "bigint") {
      throw new Error(`allowance() answered ${typeof read} rather than a number`);
    }
    currentAllowanceRaw = read;
  } catch (err) {
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `Vex could not read how much of ${token.toLowerCase()} the wallet has already authorised GeneralAdapter1 to `
      + `move: ${sanitize(err)}. The allowance is UNKNOWN, not zero and not sufficient, so the operation is refused `
      + "rather than planned around a number nobody supplied.",
      "Nothing was approved and nothing was sent. Retry once the node answers; this is the node, not the vault and "
      + "not the wallet.",
    );
  }

  const spenderRole = MORPHO_SPENDER_LABELS.generalAdapter1;
  const base = {
    token, owner, spender, spenderRole,
    requiredAmountRaw: request.requiredAmountRaw,
    currentAllowanceRaw,
  } as const;

  if (currentAllowanceRaw >= request.requiredAmountRaw) {
    return { ...base, shape: "none-needed", steps: [] };
  }

  const approveStep: MorphoAllowanceStep = {
    kind: "allowance",
    to: token,
    data: buildMorphoApproveCalldata(spender, request.requiredAmountRaw),
    spender,
    amountRaw: request.requiredAmountRaw,
    explanation:
      `An ERC-20 approval of EXACTLY ${request.requiredAmountRaw.toString()} raw units to GeneralAdapter1, the `
      + "contract that moves the tokens in a bundled Morpho action. It is sent as its own transaction immediately "
      + "before the operation and it is sized to that operation, so nothing is left standing once the operation "
      + "consumes it. If the operation that follows fails, this approval remains until it is used or reset.",
  };

  if (currentAllowanceRaw === 0n) {
    return { ...base, shape: "approve", steps: [approveStep] };
  }

  return {
    ...base,
    shape: "reset-then-approve",
    steps: [
      {
        kind: "allowance_reset",
        to: token,
        data: buildMorphoApproveCalldata(spender, 0n),
        spender,
        amountRaw: 0n,
        explanation:
          `The wallet already allows GeneralAdapter1 ${currentAllowanceRaw.toString()} raw units, which is short of `
          + `the ${request.requiredAmountRaw.toString()} this operation needs. Some tokens refuse an approval that `
          + "moves a non-zero allowance straight to another non-zero value, so it is set to zero first. This step "
          + "REDUCES what the adapter may take; it never grants anything.",
      },
      approveStep,
    ],
  };
}

/**
 * Project the plan into the requirement vocabulary the agent-facing quote
 * publishes. One shape, one owner: the quote's `requirements` are the plan's own
 * steps rather than a second rendering of the SDK's list.
 */
export function describeMorphoAllowancePlan(plan: MorphoAllowancePlan): readonly MorphoRequirement[] {
  return plan.steps.map((step) =>
    step.kind === "allowance"
      ? {
          kind: "approval",
          token: plan.token.toLowerCase(),
          spender: plan.spender.toLowerCase(),
          spenderRole: plan.spenderRole,
          amountRaw: step.amountRaw.toString(),
          explanation: step.explanation,
        }
      : {
          kind: "approval_reset",
          token: plan.token.toLowerCase(),
          spender: plan.spender.toLowerCase(),
          spenderRole: plan.spenderRole,
          amountRaw: "0",
          explanation: step.explanation,
        },
  );
}

/**
 * Hold the SDK's own requirement list against the plan, and refuse the operation
 * when they disagree.
 *
 * WHAT IS COMPARED, AND WHAT DELIBERATELY IS NOT. The comparison is over the
 * APPROVAL: does an exact-amount approval to the pinned adapter have to happen
 * at all, and for which token and how much. The RESET is not compared, because
 * the SDK never models one - it is a property of the token's `approve`
 * implementation, not of the Morpho operation, and demanding the SDK agree about
 * a step it has no opinion on would refuse every USDT-shaped operation.
 *
 * `classifyMorphoRequirements` has already refused anything that is not an
 * exact-amount approval to the pinned GeneralAdapter1, including every signature
 * requirement, so what arrives here is a list of zero or one already-policed
 * approvals. This function decides whether that list means the same thing the
 * chain read did.
 *
 * @throws {VexError} `MORPHO_APPROVAL_POLICY_VIOLATION` on any disagreement.
 */
export function crossCheckMorphoAllowancePlan(
  plan: MorphoAllowancePlan,
  sdkRequirements: readonly MorphoApprovalRequirement[],
): void {
  const planWantsApproval = plan.shape !== "none-needed";

  if (sdkRequirements.length > 1) {
    refuse(
      `Refusing a Morpho operation: the SDK asked for ${sdkRequirements.length} approvals where Vex's own allowance `
      + "read accounts for at most one. Vex approves exactly one spender for exactly one amount, so a longer list "
      + "describes an operation this lane was not built for.",
    );
  }

  const sdkApproval = sdkRequirements[0];

  if (planWantsApproval && sdkApproval === undefined) {
    refuse(
      `Refusing a Morpho operation: Vex read the wallet's allowance to GeneralAdapter1 as `
      + `${plan.currentAllowanceRaw.toString()} raw units, short of the ${plan.requiredAmountRaw.toString()} this `
      + "operation needs, while the Morpho SDK reports that no approval is required. The two disagree about whether "
      + "the adapter can already move these funds, and that is not a difference Vex resolves by picking one.",
    );
  }

  if (!planWantsApproval && sdkApproval !== undefined) {
    refuse(
      `Refusing a Morpho operation: Vex read the wallet's allowance to GeneralAdapter1 as `
      + `${plan.currentAllowanceRaw.toString()} raw units, which already covers the `
      + `${plan.requiredAmountRaw.toString()} this operation needs, while the Morpho SDK still asks for an approval `
      + "of " + `${sdkApproval.amountRaw} raw units. The two disagree about the standing allowance, and an approval `
      + "sent on a disputed reading would authorise a spend nobody could account for.",
    );
  }

  if (sdkApproval === undefined) return;

  if (sdkApproval.token !== plan.token.toLowerCase()) {
    refuse(
      `Refusing a Morpho operation: the SDK's approval names the token ${sdkApproval.token} while Vex planned an `
      + `approval on the vault's own asset ${plan.token.toLowerCase()}.`,
    );
  }
  if (sdkApproval.spender !== plan.spender.toLowerCase()) {
    refuse(
      `Refusing a Morpho operation: the SDK's approval names the spender ${sdkApproval.spender} while Vex planned an `
      + `approval to the chain's pinned GeneralAdapter1 ${plan.spender.toLowerCase()}.`,
    );
  }
  if (sdkApproval.amountRaw !== plan.requiredAmountRaw.toString()) {
    refuse(
      `Refusing a Morpho operation: the SDK's approval is for ${sdkApproval.amountRaw} raw units while Vex planned `
      + `exactly the operation's own ${plan.requiredAmountRaw.toString()}.`,
    );
  }
}

function refuse(message: string): never {
  throw new VexError(
    ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION,
    message,
    "Nothing was approved and nothing was sent. Re-read the vault and re-quote; if the disagreement persists it is a "
    + "Morpho SDK behaviour change rather than a transient one, and it should be reported instead of retried.",
  );
}

/**
 * A bounded, secret-free reading of an RPC throw.
 *
 * ONE OWNER (rules/04): the scrubbing itself is `sanitizeMorphoCause` in
 * `../errors.ts`. This wrapper only turns a throw into the string it takes. A
 * local copy of the patterns is how the viem-version leak (defect D8, live test
 * 2026-08-17) survived in two places after being fixed in one.
 */
function sanitize(err: unknown): string {
  return sanitizeMorphoCause(err instanceof Error ? err.message : String(err));
}
