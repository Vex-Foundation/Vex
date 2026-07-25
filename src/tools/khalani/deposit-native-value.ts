/**
 * Khalani deposit plan → native-value authorization.
 *
 * The adapter between Khalani's planned legs (`./bridge-executor.ts`) and the
 * venue-neutral classifier
 * (`@tools/evm-chains/native-value-authorization`). It owns exactly two things:
 * building the chain reader the provers need, and telling them what Vex itself
 * derived about this bridge.
 *
 * WHY IT IS SEPARATE FROM THE PLANNER. `planKhalaniDepositLegs` is
 * network-free by contract — that is what lets the handler create every
 * `agent_activity` row before anything is signed. Proving a protocol fee needs
 * a chain read, so it cannot live there. The planner therefore emits
 * provider-supplied values as UNCLASSIFIED, and this module is the only thing
 * that can upgrade them. A plan that skips this step is not "unchecked" — its
 * legs are refused by `signStageEvmLeg`.
 *
 * WHY IT RUNS BEFORE THE INTENT IS RECORDED. The charge this exists to catch
 * reached the signer because the plan was materialized AFTER the approval gate
 * had already run. Classifying at plan time and persisting the per-leg
 * fingerprint with the pre-sign intent is what makes the exposure part of the
 * record the user's approval refers to, instead of a number that appears for
 * the first time inside the signer.
 */

import type { Address, Hex } from "viem";

import { isNativeEvmFeeToken } from "@tools/bridge-fee/index.js";
import {
  DEBRIDGE_FIXED_FEE_ABI,
  DEBRIDGE_DLN_SOURCE_PROXY,
  describeNativeValueAuthorization,
  evaluateNativeValueAuthorization,
  proveEvmNativeValue,
  type DebridgeFixedFeeReader,
  type NativeValueDisclosure,
} from "@tools/evm-chains/native-value-authorization/index.js";

import { createDynamicPublicClient } from "./evm-client.js";
import { khalaniLegNativeValueCall, type KhalaniLegPurpose, type KhalaniStagedLeg } from "./bridge-executor.js";
import type { KhalaniChain } from "./types.js";

/** One leg's native exposure, as persisted with the intent and shown to the agent. */
export interface KhalaniLegNativeValueDisclosure {
  readonly legIndex: number;
  readonly role: string;
  readonly purpose: KhalaniLegPurpose;
  /**
   * Binds this disclosure to the exact call it describes. Persisted pre-sign
   * and re-checked inside the signer, so an exposure that changed between
   * approval and signature refuses instead of being silently accepted.
   */
  readonly fingerprint: Hex;
  readonly nativeValue: NativeValueDisclosure;
}

export interface KhalaniNativeValueRefusal {
  readonly legIndex: number;
  readonly role: string;
  readonly reason: string;
}

export interface KhalaniPlanNativeValue {
  /** The plan's legs, with every provable native charge upgraded. Sign THESE. */
  readonly legs: KhalaniStagedLeg[];
  /** Index-aligned with `legs`. */
  readonly disclosures: readonly KhalaniLegNativeValueDisclosure[];
  /** `null` when every leg is authorized; otherwise the FIRST leg that is not. */
  readonly refusal: KhalaniNativeValueRefusal | null;
  /** Total native currency the whole plan sends, in wei (decimal string). */
  readonly totalNativeOutflowWei: string;
}

/** What Vex itself decided to move, independent of anything the provider said. */
export interface KhalaniNativeValueContext {
  /** The source-chain token being bridged, provider-native spelling. */
  readonly fromToken: string;
  /** The amount actually deposited (post Vex fee split), in smallest units. */
  readonly bridgedAmountRaw: string;
}

function debridgeFixedFeeReader(
  sourceChain: KhalaniChain,
  chains: KhalaniChain[],
): DebridgeFixedFeeReader {
  const client = createDynamicPublicClient(sourceChain, chains);
  return {
    getBlockNumber: () => client.getBlockNumber(),
    readGlobalFixedNativeFee: ({ address, blockNumber }: { address: Address; blockNumber: bigint }) =>
      client.readContract({
        address,
        abi: DEBRIDGE_FIXED_FEE_ABI,
        functionName: "globalFixedNativeFee",
        blockNumber,
      }),
  };
}

/**
 * Prove what every EVM leg's `tx.value` is, and report the first leg that
 * cannot be fully attributed.
 *
 * Solana legs are skipped: they carry no `tx.value`, and Solana's own native
 * economics (rent, priority fee) are a different mechanism with a different
 * owner. Legs the planner already proved in full — Vex's own native fee
 * transfer, a native TRANSFER deposit — are passed through untouched, so no RPC
 * is spent on a charge that is already accounted for.
 */
export async function authorizeKhalaniPlanNativeValue(
  planned: readonly KhalaniStagedLeg[],
  sourceChain: KhalaniChain,
  chains: KhalaniChain[],
  context: KhalaniNativeValueContext,
): Promise<KhalaniPlanNativeValue> {
  const sourceIsNative = isNativeEvmFeeToken(context.fromToken);
  let reader: DebridgeFixedFeeReader | null = null;

  const legs: KhalaniStagedLeg[] = [];
  const disclosures: KhalaniLegNativeValueDisclosure[] = [];
  let refusal: KhalaniNativeValueRefusal | null = null;
  let totalNativeOutflowWei = 0n;

  for (const [legIndex, leg] of planned.entries()) {
    if (leg.kind !== "evm") {
      legs.push(leg);
      continue;
    }

    let authorization = leg.nativeValue;
    const alreadyAuthorized = evaluateNativeValueAuthorization(authorization).ok;
    if (!alreadyAuthorized) {
      reader ??= debridgeFixedFeeReader(sourceChain, chains);
      authorization = await proveEvmNativeValue(
        {
          call: khalaniLegNativeValueCall(sourceChain.id, leg.tx),
          // Only the DEPOSIT can legitimately carry the user's principal in
          // `tx.value`, and only when the bridged asset is the native currency.
          // An allowance leg that sends native value has no principal to claim
          // and must be proven some other way or refused.
          vexDerived:
            sourceIsNative && leg.isDeposit
              ? {
                  nativePrincipal: {
                    amountWei: BigInt(context.bridgedAmountRaw),
                    recipient: null,
                    refund: "refunded_to_source_on_failure",
                    evidence: {
                      source: "vex_constructed",
                      detail: "the post-fee amount Vex asked the venue to bridge",
                    },
                  },
                }
              : undefined,
        },
        reader,
      );
    }

    const upgraded: KhalaniStagedLeg = { ...leg, nativeValue: authorization };
    legs.push(upgraded);
    totalNativeOutflowWei += authorization.totalValueWei;

    const disclosure = describeNativeValueAuthorization(authorization);
    disclosures.push({
      legIndex,
      role: leg.role,
      purpose: leg.purpose,
      fingerprint: authorization.fingerprint,
      nativeValue: disclosure,
    });

    if (refusal === null && !disclosure.authorized) {
      refusal = {
        legIndex,
        role: leg.role,
        reason: disclosure.refusalReason ?? "native value could not be authorized",
      };
    }
  }

  return {
    legs,
    disclosures,
    refusal,
    totalNativeOutflowWei: totalNativeOutflowWei.toString(),
  };
}

/**
 * The refusal message the handler surfaces and persists. Names the leg, the
 * amount, and the fact that nothing was signed — an autonomous agent acting on
 * this needs to know it may re-quote, not that funds are in flight.
 *
 * Deliberately mentions the deBridge target: when a route settles through DLN
 * and the fee read did not line up, that is the single most useful thing a
 * human debugging the refusal can be told.
 */
export function khalaniNativeValueRefusalReason(refusal: KhalaniNativeValueRefusal): string {
  return (
    `the ${refusal.role} leg sends native currency Vex could not fully account for — ${refusal.reason}. `
    + "Nothing was signed and no bridge was initiated. Vex refuses to sign a native charge it cannot "
    + `attribute to a proven cost (verified protocol fees are read on-chain, e.g. deBridge's own `
    + `globalFixedNativeFee() at ${DEBRIDGE_DLN_SOURCE_PROXY})`
  );
}
