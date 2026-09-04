/**
 * Planning — converting a Khalani `DepositPlan` into the ORDERED list of
 * Vex-signed broadcast legs, WITHOUT signing and WITHOUT any network call.
 *
 * Network-free is a contract, not an accident: the handler must be able to
 * create every planned `agent_activity` row BEFORE anything is signed. It is
 * also why the Solana Vex fee leg leaves here as an unbuilt descriptor
 * (`kind: "solana_fee"`) — building it needs the mint's owner program and the
 * treasury ATA's existence, both network reads, so `./leg-signing.ts`
 * materializes it against the same per-chain RPC it already signs on.
 *
 * APPROVE BINDING (`@tools/evm-chains/erc20-approve-step-guard.ts`): a
 * CONTRACT_CALL plan's approval legs are bound to the deposit call BEFORE the
 * plan is returned, so nothing downstream can sign an approval this plan does
 * not need. Until this landed the spender and the allowance were decoded only
 * to STAMP the deposit leg with evidence (`contractCallApprovedSpenders`
 * below), so `approve(stranger, unlimited)` on the user's origin token planned
 * and signed cleanly, and the standing allowance outlived the bridge.
 *
 * WHAT IS BOUND HERE AND WHAT IS NOT. This planner receives the provider plan,
 * the chain and the Vex fee leg. It can therefore prove every plan-INTERNAL
 * fact (rule 1: canonical `approve`, no native value, spender == this plan's
 * own deposit target, at most one GRANT). It CANNOT yet prove the Vex-DERIVED
 * facts (rule 2: the token is the origin currency and the allowance is exactly
 * the bridged principal) because `ContractCallDepositPlan` carries neither the
 * origin token nor the amount, and the caller passes neither: the handler holds
 * both as `fromToken` and `bridgedAmountRaw` (it already hands them to
 * `authorizeKhalaniPlanNativeValue`). Wiring them into this planner and calling
 * `verifyApproveStepBindsPlanAmount` is the named follow-up; deriving the
 * principal here from `vexFee.feeRaw` was rejected because inverting a floored
 * bps split yields a RANGE, and a money bound must be exact.
 *
 * VEX FEE LEG (`src/tools/bridge-fee`): when a fee is charged, the plan gains
 * ONE extra leg APPENDED AFTER the deposit — Vex's own transfer of 25 bps of
 * the input token to the treasury. It is last on purpose: the deposit is
 * quoted and broadcast for `amount − fee`, so a bridge that never happens
 * never charges a fee.
 */

import { encodeFunctionData, getAddress, type Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { ERC20_ABI } from "../../../constants/chain.js";
import {
  BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
  buildEvmBridgeFeeTransfer,
} from "@tools/bridge-fee/index.js";
import {
  classifyNativeValue,
  type NativeValueAuthorization,
  type ProvenComponent,
} from "@tools/evm-chains/native-value-authorization/index.js";
import type {
  ChainFamily,
  ContractCallDepositPlan,
  DepositPlan,
  KhalaniChain,
  SolanaApproval,
  TransferDepositPlan,
} from "../types.js";
import { decodeErc20Approve, type ApprovedSpender } from "@tools/evm-chains/erc20-approval.js";
import {
  refuseApproveStep,
  verifyApproveStepAuthorizesDeposit,
  type Erc20ApproveStepVerdict,
} from "@tools/evm-chains/erc20-approve-step-guard.js";
import {
  assertEvmApproval,
  classifyEvmApprovalRole,
  isNativeTransferToken,
  normalizeEvmApproval,
} from "./approval-normalization.js";
import {
  khalaniLegNativeValueCall,
  type KhalaniStagedLeg,
  type KhalaniVexFeeLeg,
  type NormalizedEvmTx,
} from "./staged-leg.js";

/**
 * Classify an EVM leg's `tx.value` with only what the planner can prove
 * offline. A provider-supplied value gets no Vex-derived component, so it lands
 * in the unclassified remainder and stays refused until a prover upgrades it.
 */
function planLegNativeValue(
  chainId: number,
  tx: NormalizedEvmTx,
  vexDerived?: { readonly nativePrincipal?: ProvenComponent; readonly platformFee?: ProvenComponent },
): NativeValueAuthorization {
  return classifyNativeValue({
    call: khalaniLegNativeValueCall(chainId, tx),
    nativePrincipal: vexDerived?.nativePrincipal,
    vexPlatformFee: vexDerived?.platformFee,
    provenProtocolFee: null,
  });
}

/**
 * Every spender this plan's approvals grant, each bound to the token contract
 * that granted it - the approval transaction's own target. The binding is the
 * point: a spender approved for token B is not an authorized destination for a
 * transfer of token A, so the confirm site can only admit the pairs whose token
 * IS the deposit's input.
 */
function contractCallApprovedSpenders(
  legs: readonly KhalaniStagedLeg[],
  depositIndex: number,
): ApprovedSpender[] {
  const approved: ApprovedSpender[] = [];
  // Only approvals this plan signs BEFORE the deposit can authorize it, and they
  // are kept in plan order: the confirm site replays them, so an `approve(x, 0)`
  // after a grant must be able to revoke it.
  for (const [index, leg] of legs.entries()) {
    if (index >= depositIndex) break;
    if (leg.kind !== "evm" || leg.isDeposit) continue;
    const approval = decodeErc20Approve(leg.tx.data);
    if (approval === null) continue;
    approved.push({ token: leg.tx.to, spender: approval.spender, amountRaw: approval.amount });
  }
  return approved;
}

function planContractCallLegs(plan: ContractCallDepositPlan, chain: KhalaniChain): KhalaniStagedLeg[] {
  const family: ChainFamily = chain.type;
  const legs: KhalaniStagedLeg[] = [];
  for (const approval of plan.approvals) {
    if (family === "solana") {
      const solanaApproval = approval as SolanaApproval;
      if (solanaApproval.type !== "solana_sendTransaction") {
        throw new VexError(
          ErrorCodes.KHALANI_DEPOSIT_FAILED,
          `Unexpected approval type ${approval.type}; expected solana_sendTransaction.`,
        );
      }
      legs.push({
        role: solanaApproval.deposit ? "bridge_deposit" : "allowance",
        purpose: "bridge",
        family: "solana",
        isDeposit: solanaApproval.deposit === true,
        kind: "solana",
        base64Tx: solanaApproval.transaction,
      });
      continue;
    }
    assertEvmApproval(approval);
    const tx = normalizeEvmApproval(approval, chain);
    if (tx === null) continue; // chain-switch — not a broadcast
    legs.push({
      role: approval.deposit ? "bridge_deposit" : classifyEvmApprovalRole(tx.data),
      purpose: "bridge",
      family: "eip155",
      isDeposit: approval.deposit === true,
      kind: "evm",
      tx,
      // Provider-supplied value — nothing is proven offline. A non-zero value
      // is unclassified here BY DESIGN and must be upgraded by a prover before
      // it can be signed.
      nativeValue: planLegNativeValue(chain.id, tx),
    });
  }
  assertApprovalsAuthorizeDeposit(legs);
  return attachContractCallDepositEvidence(legs);
}

/**
 * Rule 1 of the approve binding, across the whole CONTRACT_CALL plan: every
 * approval leg is a canonical, value-free `approve` naming this plan's OWN
 * deposit target, and at most one of them GRANTS an allowance.
 *
 * Grants are counted rather than approval legs, because a plan may legitimately
 * carry an `approve(spender, 0)` reset alongside its grant: non-standard tokens
 * require the reset, the leg role vocabulary already names it
 * (`allowance_reset`), and the confirm site replays resets on purpose. A reset
 * is bound to the deposit target exactly like a grant, so allowing it grants no
 * authority to anyone new.
 *
 * Throws: this runs inside the planner, whose whole contract is to throw a
 * typed `VexError` before any leg reaches a signer, a nonce or a durable row.
 */
function assertApprovalsAuthorizeDeposit(legs: readonly KhalaniStagedLeg[]): void {
  const deposit = legs.find((leg) => leg.kind === "evm" && leg.isDeposit);
  const depositTarget = deposit !== undefined && deposit.kind === "evm" ? deposit.tx.to : null;
  let grants = 0;
  for (const leg of legs) {
    if (leg.kind !== "evm" || leg.isDeposit || leg.purpose !== "bridge") continue;
    let verdict: Erc20ApproveStepVerdict = verifyApproveStepAuthorizesDeposit(
      { to: leg.tx.to, data: leg.tx.data, value: leg.tx.value ?? 0n, from: leg.tx.expectedFrom },
      { depositTarget },
    );
    if (verdict.ok && verdict.allowance !== 0n && ++grants > 1) {
      verdict = refuseApproveStep(
        "extra_approve_step",
        "the plan grants a token allowance more than once, and one deposit needs at most one grant",
      );
    }
    if (!verdict.ok) {
      throw new VexError(
        ErrorCodes.KHALANI_DEPOSIT_FAILED,
        `Refused before signing the Khalani token approval: ${verdict.detail}. Nothing was signed or broadcast.`,
        "The provider's approval did not match the deposit plan. Take a fresh khalani__bridge_quote for this route and retry.",
      );
    }
  }
}

/**
 * Stamp the deposit leg with the recipients its plan authorizes, so the confirm
 * site can look for the input transfer in the receipt. The stamp says only
 * WHERE the input may go; the amount stays a receipt question.
 */
function attachContractCallDepositEvidence(legs: KhalaniStagedLeg[]): KhalaniStagedLeg[] {
  return legs.map((leg, index) => {
    if (leg.kind !== "evm" || !leg.isDeposit) return leg;
    return {
      ...leg,
      depositEvidence: {
        kind: "provider_contract_call",
        callTarget: leg.tx.to,
        approvedSpenders: contractCallApprovedSpenders(legs, index),
      },
    };
  });
}

function planTransferLeg(plan: TransferDepositPlan, chain: KhalaniChain): KhalaniStagedLeg[] {
  if (chain.type !== "eip155") {
    throw new VexError(
      ErrorCodes.KHALANI_DEPOSIT_FAILED,
      "Solana TRANSFER deposits are not implemented.",
      "Retry with depositMethod set to CONTRACT_CALL.",
    );
  }
  const isNative = isNativeTransferToken(plan.token);
  const tx: NormalizedEvmTx = isNative
    ? { to: getAddress(plan.depositAddress), value: BigInt(plan.amount) }
    : {
        to: getAddress(plan.token),
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [getAddress(plan.depositAddress), BigInt(plan.amount)],
        }),
      };
  // A native TRANSFER deposit is fully proven right here: Vex builds the whole
  // transaction, and its entire value IS the principal being bridged. This is
  // also why the fixed-fee rule must be `value − principal == fee` — a
  // `value == fee` rule would refuse this legitimate leg outright.
  const nativeValue = planLegNativeValue(
    chain.id,
    tx,
    isNative
      ? {
          nativePrincipal: {
            amountWei: BigInt(plan.amount),
            recipient: getAddress(plan.depositAddress),
            refund: "refunded_to_source_on_failure",
            evidence: {
              source: "vex_constructed",
              detail: "the whole value is the deposit amount of a Vex-built native TRANSFER leg",
            },
          },
        }
      : undefined,
  );
  return [{
    role: "bridge_deposit", purpose: "bridge", family: "eip155",
    isDeposit: true, kind: "evm", tx, nativeValue,
    // Vex composed this transfer, so the exact token, recipient and amount are
    // known before signing. They NARROW which receipt log is ours; they do not
    // replace it, because a fee-on-transfer or otherwise non-standard token can
    // log an amount that differs from the one our calldata encoded.
    depositEvidence: isNative
      ? { kind: "vex_built_native_transfer", valueWei: BigInt(plan.amount) }
      : {
          kind: "vex_built_erc20_transfer",
          token: getAddress(plan.token),
          recipient: getAddress(plan.depositAddress),
          amountRaw: BigInt(plan.amount),
        },
  }];
}

/**
 * Plan the Vex fee leg for `sourceChain`'s family. EVM is fully built here
 * (pure); Solana is a descriptor materialized at sign time (module doc).
 */
function planVexFeeLeg(fee: KhalaniVexFeeLeg, sourceChain: KhalaniChain): KhalaniStagedLeg {
  if (sourceChain.type === "solana") {
    return {
      role: BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
      purpose: "vex_fee",
      family: "solana",
      isDeposit: false,
      kind: "solana_fee",
      mint: fee.tokenAddress,
      feeRaw: fee.feeRaw,
    };
  }
  const transfer = buildEvmBridgeFeeTransfer(fee.tokenAddress, fee.feeRaw);
  const tx: NormalizedEvmTx = transfer.kind === "native"
    ? { to: transfer.to, value: transfer.value }
    : { to: transfer.to, data: transfer.data };
  // Vex's own transfer: on the native branch the entire value is the Vex
  // platform fee, computed by `splitBridgeAmountForFee` from the user's own
  // amount. The ERC-20 branch sends no value at all.
  const nativeValue = planLegNativeValue(
    sourceChain.id,
    tx,
    transfer.kind === "native"
      ? {
          platformFee: {
            amountWei: transfer.value,
            recipient: transfer.to,
            refund: "spent_not_recoverable",
            evidence: {
              source: "vex_constructed",
              detail: "the whole value is the Vex integrator fee of a Vex-built native transfer leg",
            },
          },
        }
      : undefined,
  );
  return {
    role: BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
    purpose: "vex_fee",
    family: "eip155",
    isDeposit: false,
    kind: "evm",
    tx,
    nativeValue,
  };
}

/**
 * Convert a `DepositPlan` into the ordered Vex-signed broadcast legs, WITHOUT
 * signing. PERMIT2 is intentionally blocked; the plan MUST contain exactly one
 * `deposit` leg (the hash the caller later submits to Khalani).
 *
 * `vexFee`, when present, is APPENDED as the final leg — see the module doc for
 * why it must run after the deposit and never before it. Pass `null` (or omit)
 * when the fee floors to zero: a zero-value transfer would burn gas and move
 * nothing.
 */
export function planKhalaniDepositLegs(
  plan: DepositPlan,
  sourceChain: KhalaniChain,
  vexFee: KhalaniVexFeeLeg | null = null,
): KhalaniStagedLeg[] {
  if (plan.kind === "PERMIT2") {
    throw new VexError(
      ErrorCodes.KHALANI_PERMIT2_BLOCKED,
      "PERMIT2 live execution is intentionally blocked.",
      "Use dryRun to inspect the permit payload, or retry with depositMethod set to CONTRACT_CALL.",
    );
  }
  const legs = plan.kind === "TRANSFER"
    ? planTransferLeg(plan, sourceChain)
    : planContractCallLegs(plan, sourceChain);

  const depositCount = legs.filter((leg) => leg.isDeposit).length;
  if (depositCount === 0) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Khalani did not mark any action with deposit=true.");
  }
  if (depositCount > 1) {
    throw new VexError(ErrorCodes.KHALANI_DEPOSIT_FAILED, "Khalani marked more than one action with deposit=true.");
  }
  if (vexFee && vexFee.feeRaw > 0n) {
    legs.push(planVexFeeLeg(vexFee, sourceChain));
  }
  return legs;
}
