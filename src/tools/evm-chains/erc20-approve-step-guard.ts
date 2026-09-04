/**
 * Binding a PROVIDER-SUPPLIED ERC-20 `approve` step to the plan it claims to
 * serve, BEFORE anything is signed.
 *
 * WHY IT EXISTS. Both bridge venues used to sign a provider's approve step
 * after checking only the chain id, the sender, that `to` parsed as an address
 * and that the native value was attributable. The spender, the token contract
 * and the allowance were decoded ONLY afterwards, to record evidence
 * (`erc20-approval.ts` on the Relay broadcast path, and the Khalani planner's
 * `contractCallApprovedSpenders`). A provider returning
 * `approve(attackerSpender, 2^256-1)` on the origin token therefore signed
 * cleanly, and the user's ENTIRE balance of that token was drainable later with
 * no further Vex signature. This module is the same class of gate
 * `kyberswap/evm/swap-calldata-guard.ts` is for a swap blob, applied to the one
 * calldata shape a bridge asks Vex to sign on the user's own token.
 *
 * TWO RULES, TWO SEAMS. An approve step is safe only if BOTH hold, and the two
 * are checked where the facts actually live:
 *
 *  1. {@link verifyApproveStepAuthorizesDeposit} - plan-internal. The blob is a
 *     canonical `approve`, it carries no native value, and the spender is the
 *     plan's OWN deposit target. Needs nothing but the plan, so a venue whose
 *     planner sees the whole step list can run it there.
 *  2. {@link verifyApproveStepBindsPlanAmount} - Vex-derived. The token is the
 *     origin currency the user approved, the sender is the selected wallet, and
 *     the allowance is EXACTLY the principal Vex itself decided to bridge.
 *     Needs numbers no provider supplied, so it runs where those numbers reach
 *     the signer.
 *
 * Neither subsumes the other: rule 1 alone would allow an unlimited allowance
 * to an honest deposit contract, and rule 2 alone would allow the exact
 * principal to be handed to a stranger.
 *
 * Verdicts are returned, never thrown: each venue owns how a refusal is
 * recorded and worded (`swap-calldata-guard.ts` makes the same choice).
 *
 * PIN-NOTE: viem 2.54.3 (`node_modules/viem/package.json`), probed 2026-09-04
 * against `decodeFunctionData` with the `approve(address,uint256)` ABI below:
 *  - canonical 68-byte blob: decodes, args `[checksummed spender, bigint]`;
 *  - canonical blob PLUS trailing bytes ("deadbeef", and a full zero word):
 *    DECODES SILENTLY and returns the same args, the extra bytes discarded;
 *  - wrong selector (`0xa9059cbb`) and `0x`: throw
 *    `AbiFunctionSignatureNotFoundError`;
 *  - selector only: throws `SliceOffsetOutOfBoundsError`;
 *  - truncated argument body: throws `PositionOutOfBoundsError`.
 * The trailing-byte result is why this module measures the length itself:
 * `decodeFunctionData` is NOT a canonicality check, and a token proxy that
 * dispatches on extra calldata would do something the decode never showed. The
 * error classes differ per malformation, so nothing here may match on one:
 * every throw is one refusal.
 *
 * LIVE PROVENANCE (rule 10), captured 2026-09-04, read-only quotes archived
 * under `session7/live/bridge-calldata/`: five Relay `/quote/v2` ERC-20 routes
 * (base/arbitrum/ethereum/optimism USDC, three amounts), one native-origin
 * Relay route, and one Khalani `/v1/deposit/build` CONTRACT_CALL plan with its
 * TRANSFER sibling. EVERY approve step measured was
 * exactly 68 bytes with no trailing data, carried `value` zero, targeted the
 * origin token, named the deposit step's own target as spender, and set the
 * allowance to EXACTLY the quoted input amount. A native-origin Relay quote
 * carried NO approve step, and a Khalani TRANSFER plan carried no approvals at
 * all. The rules below refuse nothing that honest traffic does.
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";

/** `approve(address,uint256)`. The only selector a bridge approve step may carry. */
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/**
 * Canonical `approve` calldata length in hex characters: "0x" + 4 selector
 * bytes + two 32-byte words. Anything longer carries trailing bytes viem would
 * silently discard (see the pin-note); anything shorter cannot decode.
 */
const CANONICAL_APPROVE_HEX_LENGTH = 2 + 8 + 128;

const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Closed refusal vocabulary. Each member is one distinct thing a provider did,
 * so a venue can word its own remediation without re-deriving the cause.
 */
export type Erc20ApproveStepRefusalReason =
  /** Not a canonical `approve`: unknown selector, undecodable body, or trailing bytes. */
  | "not_canonical_approve"
  /** An approve never sends native currency. */
  | "approve_carries_native_value"
  /** The spender is not the deposit this plan is about to make. */
  | "spender_not_deposit_target"
  /** The plan has no deposit call at all, so no approve step in it is legitimate. */
  | "plan_has_no_deposit_call"
  /** The origin asset is the chain's native currency, which is never approved. */
  | "approve_on_native_origin"
  /** The approval targets a token contract that is not the origin currency. */
  | "token_not_origin_currency"
  /** The approval would be sent from an address that is not the selected wallet. */
  | "sender_not_selected_wallet"
  /** The allowance is not exactly the principal Vex derived. */
  | "allowance_not_principal"
  /** Vex derived no principal for this plan, so no allowance can be bound. */
  | "principal_not_derivable"
  /** More than one approve step in one plan. */
  | "extra_approve_step";

export type Erc20ApproveStepVerdict =
  | { readonly ok: true; readonly spender: Address; readonly allowance: bigint }
  | {
      readonly ok: false;
      readonly reason: Erc20ApproveStepRefusalReason;
      readonly detail: string;
    };

/** One transaction a provider asked Vex to sign, as the plan carries it. */
export interface ApproveStepCall {
  /** The transaction target. For an approve this is the token contract itself. */
  readonly to: string;
  readonly data: string | undefined;
  /** Native value in wei. A missing value is zero at the venue boundary, never here. */
  readonly value: bigint;
  /** The sender the provider named, when it named one. */
  readonly from?: string | undefined;
}

/** The plan-internal facts rule 1 binds against. */
export interface ApproveDepositBinding {
  /**
   * The target of the deposit call this plan will make: the ONLY address an
   * approve step in this plan may authorize. `null` when the plan makes no
   * deposit CALL at all (a plain transfer to a deposit address), which makes
   * every approve step in it illegitimate.
   */
  readonly depositTarget: string | null;
}

/** The Vex-derived facts rule 2 binds against. */
export interface ApproveAmountBinding {
  /**
   * The origin token contract the user approved, or `null` when the origin
   * asset is the chain's native currency. Each venue maps its own native
   * sentinel before calling.
   */
  readonly originToken: string | null;
  /** The selected wallet. */
  readonly wallet: string;
  /**
   * The exact allowance this plan needs: the deposit principal VEX derived
   * (the post-fee amount it asked the venue to bridge), never a provider echo.
   * `null` when Vex derived no input amount for this plan, which fails closed.
   */
  readonly principalRaw: bigint | null;
}

/**
 * Build a refusal in this module's vocabulary. Exported so a planner's own
 * structural rules (there is at most one approve step in a plan) speak the same
 * closed language as the calldata rules.
 */
export function refuseApproveStep(
  reason: Erc20ApproveStepRefusalReason,
  detail: string,
): Erc20ApproveStepVerdict {
  return { ok: false, reason, detail };
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Decode calldata that is a CANONICAL `approve(spender, amount)` and nothing
 * else, or return `null`.
 *
 * Stricter than `decodeErc20Approve` in `./erc20-approval.ts` on purpose. That
 * one reads an approval back out of calldata for EVIDENCE, where a tolerant
 * read is right; this one decides whether Vex signs, where the pin-note's
 * trailing-byte behaviour makes tolerance a hole.
 */
function decodeCanonicalApprove(
  data: string | undefined,
): { readonly spender: Address; readonly allowance: bigint } | null {
  if (typeof data !== "string") return null;
  if (data.length !== CANONICAL_APPROVE_HEX_LENGTH) return null;
  if (!data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) return null;
  try {
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: data as Hex });
    if (decoded.functionName !== "approve") return null;
    return { spender: getAddress(decoded.args[0]), allowance: decoded.args[1] };
  } catch {
    return null;
  }
}

/**
 * RULE 1 (plan-internal): the step is a canonical, value-free `approve` whose
 * spender is the deposit this same plan is about to make.
 *
 * This is the rule that closes the drain: an allowance granted to an address
 * the plan never calls is authority the user's own bridge does not need, and it
 * outlives the bridge.
 */
export function verifyApproveStepAuthorizesDeposit(
  call: ApproveStepCall,
  plan: ApproveDepositBinding,
): Erc20ApproveStepVerdict {
  const approve = decodeCanonicalApprove(call.data);
  if (approve === null) {
    return refuseApproveStep(
      "not_canonical_approve",
      "the approval step's calldata is not a canonical approve(address,uint256) call",
    );
  }
  if (call.value !== 0n) {
    return refuseApproveStep(
      "approve_carries_native_value",
      `the approval step attaches ${call.value} native wei, and an approval never sends value`,
    );
  }
  if (plan.depositTarget === null) {
    return refuseApproveStep(
      "plan_has_no_deposit_call",
      "the plan makes no deposit call, so no token approval in it is legitimate",
    );
  }
  if (!sameAddress(approve.spender, plan.depositTarget)) {
    return refuseApproveStep(
      "spender_not_deposit_target",
      "the approval names a spender that is not the deposit this plan makes",
    );
  }
  return { ok: true, spender: approve.spender, allowance: approve.allowance };
}

/**
 * RULE 2 (Vex-derived): the approval is on the origin token, from the selected
 * wallet, for EXACTLY the principal Vex decided to bridge.
 *
 * Exact equality, both directions. A larger allowance (unlimited most of all)
 * leaves standing authority behind after the bridge; a smaller one cannot fund
 * the deposit the user approved, so signing it spends gas on a transaction that
 * is known in advance to be insufficient. Every live capture is exact, so this
 * refuses no honest route. If a venue is ever MEASURED to need more than the
 * principal, the bound moves to that measured figure derived from the quote,
 * never to unlimited.
 */
export function verifyApproveStepBindsPlanAmount(
  call: ApproveStepCall,
  plan: ApproveAmountBinding,
): Erc20ApproveStepVerdict {
  const approve = decodeCanonicalApprove(call.data);
  if (approve === null) {
    return refuseApproveStep(
      "not_canonical_approve",
      "the approval step's calldata is not a canonical approve(address,uint256) call",
    );
  }
  if (call.value !== 0n) {
    return refuseApproveStep(
      "approve_carries_native_value",
      `the approval step attaches ${call.value} native wei, and an approval never sends value`,
    );
  }
  if (plan.originToken === null) {
    return refuseApproveStep(
      "approve_on_native_origin",
      "the origin asset is the chain's native currency, which has no token approval",
    );
  }
  if (!sameAddress(call.to, plan.originToken)) {
    return refuseApproveStep(
      "token_not_origin_currency",
      "the approval targets a token contract that is not the origin currency of this bridge",
    );
  }
  if (call.from !== undefined && call.from !== null && !sameAddress(call.from, plan.wallet)) {
    return refuseApproveStep(
      "sender_not_selected_wallet",
      "the approval would be sent from an address that is not the selected wallet",
    );
  }
  if (plan.principalRaw === null) {
    return refuseApproveStep(
      "principal_not_derivable",
      "Vex derived no input amount for this bridge, so the allowance cannot be bound",
    );
  }
  if (approve.allowance !== plan.principalRaw) {
    return refuseApproveStep(
      "allowance_not_principal",
      `the approval grants ${approve.allowance} where the deposit needs exactly ${plan.principalRaw}`,
    );
  }
  return { ok: true, spender: approve.spender, allowance: approve.allowance };
}
