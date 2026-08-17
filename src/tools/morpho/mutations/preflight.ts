/**
 * The two chain-state checks Vex runs on a built Morpho transaction: our OWN gas
 * bound, and an `eth_call` simulation.
 *
 * GAS. The bound is `../../evm-chains/gas-limit-headroom.ts`, unchanged and
 * uncopied - the module comment there records the forensic evidence for the
 * multiplier and the exact reason a per-venue copy of the number is how venues
 * drift apart. Morpho contributes nothing new to that policy, so it contributes
 * no new number. What Morpho DOES contribute is a second reading: the SDK
 * publishes no gas figure of its own for a bundle, so unlike KyberSwap there is
 * no provider hint to hold to a ceiling here, and `gasLimitWithHeadroom` on a
 * fresh per-transaction estimate is the whole bound. Both numbers are reported
 * side by side and labelled, because a headroomed limit reported as if it were
 * the estimate is a number a reader cannot act on.
 *
 * SIMULATION. `eth_call` against LATEST state, from the user's address, is the
 * cheapest honest answer to "would this revert right now". It spends nothing.
 * The verdict is a NAMED THREE-WAY, never a boolean:
 *
 *   ok                  - the call returned.
 *   reverted            - the node proved a revert, and the reason is carried.
 *   transport-ambiguous - the node did not answer, so Vex does not know.
 *
 * The third case is the one that matters. Collapsing "the node timed out" into
 * "the transaction would fail" invents a provider refusal that never happened,
 * and collapsing it into "ok" is worse. Rules/90: a decoder that cannot prove
 * what happened must decline rather than claim.
 *
 * A DEPOSIT SIMULATION USUALLY REVERTS, AND THAT IS NOT A BUG. The bundle pulls
 * the asset through Permit2, so before the approval and the per-operation
 * signature exist there is nothing for it to pull. The verdict is reported as
 * what it is, with that reading attached, rather than presented as a fault in
 * the vault.
 */

import type { Address } from "viem";

import { gasLimitWithHeadroom } from "../../evm-chains/gas-limit-headroom.js";
import type { MorphoActionClient } from "./client.js";
import type { MorphoBuiltTransaction } from "./bundle-decoder.js";

/** Our gas figure beside the node's, each labelled for what it is. */
export interface MorphoGasBound {
  /** A FRESH per-transaction `eth_estimateGas`, or null when the node refused. */
  readonly nodeEstimate: string | null;
  /** `nodeEstimate` plus Vex's headroom: the limit Vex would actually sign. */
  readonly vexGasLimit: string | null;
  /** Why there is no estimate, when there is none. Never rendered as a number. */
  readonly unavailableReason: string | null;
  readonly note: string;
}

export type MorphoPreflightVerdict = "ok" | "reverted" | "transport-ambiguous";

export interface MorphoPreflight {
  readonly verdict: MorphoPreflightVerdict;
  /** The revert reason when the node proved one; null otherwise. Sanitised. */
  readonly revertReason: string | null;
  readonly explanation: string;
}

/** A bounded, secret-free reading of an RPC throw. Same shape as `../wallet-reads.ts`. */
function sanitize(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/0x[0-9a-fA-F]{16,}/g, "[hex]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * A node throw is a REVERT only when it says so. viem raises the same class of
 * error for a proven execution revert and for a transport that never answered,
 * and the difference is the whole point of the three-way verdict.
 */
function looksLikeRevert(message: string): boolean {
  return /revert|execution reverted|ContractFunctionRevertedError|CallExecutionError|insufficient (funds|allowance|balance)/i
    .test(message);
}

/**
 * Estimate gas for a built transaction and apply Vex's headroom.
 *
 * A failed estimate is NOT an error here: a deposit that cannot yet be pulled
 * has no estimate, and refusing to produce a preview because a preview of an
 * unapproved deposit cannot be priced would withhold the very information that
 * explains why. The gap is named instead.
 */
export async function boundMorphoGas(
  client: MorphoActionClient,
  tx: MorphoBuiltTransaction,
  from: Address,
): Promise<MorphoGasBound> {
  const note =
    "The Morpho SDK publishes no gas figure for a bundle, so there is no provider hint to hold to a ceiling: "
    + "`vexGasLimit` is a fresh per-transaction estimate with Vex's own headroom applied, and it is the number "
    + "Vex would sign. A gas limit is not a cost - the sender pays for gas USED.";
  try {
    const estimate = await client.estimateGas({ account: from, to: tx.to as Address, data: tx.data as `0x${string}`, value: tx.value ?? 0n });
    return {
      nodeEstimate: estimate.toString(),
      vexGasLimit: gasLimitWithHeadroom(estimate).toString(),
      unavailableReason: null,
      note,
    };
  } catch (err) {
    return {
      nodeEstimate: null,
      vexGasLimit: null,
      unavailableReason:
        `The node could not estimate gas for this transaction as it stands: ${sanitize(err)}. For a deposit this is `
        + "usually the missing approval or per-operation signature rather than a problem with the vault. The gas "
        + "figure is UNKNOWN, not zero.",
      note,
    };
  }
}

/** Simulate a built transaction against latest state. Spends nothing. */
export async function preflightMorphoTransaction(
  client: MorphoActionClient,
  tx: MorphoBuiltTransaction,
  from: Address,
): Promise<MorphoPreflight> {
  try {
    await client.call({ account: from, to: tx.to as Address, data: tx.data as `0x${string}`, value: tx.value ?? 0n });
    return {
      verdict: "ok",
      revertReason: null,
      explanation:
        "Simulated against the chain's latest state from the wallet's own address and it did not revert. This is a "
        + "simulation only: nothing was signed, nothing was sent, and state can change before any real send.",
    };
  } catch (err) {
    const message = sanitize(err);
    if (looksLikeRevert(message)) {
      return {
        verdict: "reverted",
        revertReason: message,
        explanation:
          "The node proved this call reverts against latest state. For a deposit the ordinary cause is that the "
          + "approval to Permit2 or the per-operation signature does not exist yet, so there is nothing for the "
          + "bundle to pull. Nothing was signed or sent.",
      };
    }
    return {
      verdict: "transport-ambiguous",
      revertReason: null,
      explanation:
        `The node did not answer the simulation (${message}), so Vex does NOT know whether this transaction would `
        + "succeed. This is a gap in the check, not a verdict on the transaction, and it must not be read as either "
        + "a pass or a failure.",
    };
  }
}
