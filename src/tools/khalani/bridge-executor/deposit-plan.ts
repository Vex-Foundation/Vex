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
  return attachContractCallDepositEvidence(legs);
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
