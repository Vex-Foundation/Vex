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
 * A PULLING OPERATION'S SIMULATION USUALLY REVERTS BEFORE THE APPROVAL LANDS,
 * AND THAT IS NOT A BUG. A deposit, a collateral supply and a repayment all pull
 * a token through GeneralAdapter1, so until the wallet's exact-amount approval to
 * that adapter exists there is nothing for it to pull. The verdict is reported as
 * what it is, with that reading attached, rather than presented as a fault in the
 * vault or the market.
 *
 * WHICH IS WHY THE OPERATION IS A PARAMETER AND NOT AN ASSUMPTION. Half of the
 * operations in this lane pull nothing: a withdrawal, a borrow and a collateral
 * withdrawal move tokens OUT, and no approval is involved in any of them. Telling
 * the reader of a reverted withdrawal to go and check an approval sends them
 * looking for a cause that cannot exist, so each operation is asked whether it
 * pulls and the explanation follows the answer.
 *
 * ── AND A THIRD CHECK, ON THE NODE ITSELF ───────────────────────────────────
 *
 * `probeMorphoReceiptCapability` asks a question about the RPC rather than about
 * a transaction: will it answer `eth_getTransactionReceipt` at all. The funded
 * live probe of 2026-08-17 found the pinned Base endpoint refusing that ONE
 * method with -32602 "Archive requests require a personal token" while serving
 * every other call, including `eth_getTransactionByHash` for the very same hash.
 * The consequence is specific and expensive: a leg can be signed, broadcast and
 * MINED, and the engine still cannot prove it, so a real approval that landed in
 * the head block ended `unproven` and the deposit behind it was abandoned. The
 * gas was spent for nothing that could be confirmed.
 *
 * A node that cannot confirm is therefore a reason to spend NOTHING, and the
 * cheapest moment to find that out is before the first signature. The probe uses
 * a REAL transaction from the chain's own latest block, because the refusal is
 * method-level and a made-up hash would come back as an ordinary not-found from
 * a healthy node and as a refusal from a broken one, which is the one thing this
 * check must not blur.
 */

import type { Address, Hex } from "viem";

import { gasLimitWithHeadroom } from "../../evm-chains/gas-limit-headroom.js";
import { sanitizeMorphoCause } from "../errors.js";
import type { MorphoActionClient } from "./client.js";
import type { MorphoBuiltTransaction } from "./bundle-decoder.js";

/**
 * The operation a preflight is running for. Every Morpho operation Vex builds,
 * across both the vault lane and the market lane.
 */
export type MorphoPreflightOperation =
  | "deposit"
  | "withdraw"
  | "supply_collateral"
  | "withdraw_collateral"
  | "borrow"
  | "repay";

interface OperationReading {
  readonly label: string;
  /**
   * Whether this operation pulls a token from the wallet, which is the ONLY
   * thing that makes a missing approval a candidate explanation for a revert.
   */
  readonly pullsFromWallet: boolean;
}

const OPERATION_READINGS: Readonly<Record<MorphoPreflightOperation, OperationReading>> = {
  deposit: { label: "deposit", pullsFromWallet: true },
  withdraw: { label: "withdrawal", pullsFromWallet: false },
  supply_collateral: { label: "collateral supply", pullsFromWallet: true },
  withdraw_collateral: { label: "collateral withdrawal", pullsFromWallet: false },
  borrow: { label: "borrow", pullsFromWallet: false },
  repay: { label: "repayment", pullsFromWallet: true },
};

/** The reading attached to a failed estimate or a proven revert, per operation. */
function explainFailureFor(operation: MorphoPreflightOperation): string {
  const { label, pullsFromWallet } = OPERATION_READINGS[operation];
  return pullsFromWallet
    ? `For a ${label} this is usually the missing approval to GeneralAdapter1, which the exact-amount allowance `
      + "step has not landed yet, rather than a problem with the vault or the market."
    : `A ${label} pulls no token from the wallet, so a missing approval is NOT the explanation here. The cause is `
      + "in the position or in the market state rather than in an allowance.";
}

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
 * The refusals that mean "this node will not serve receipts", as opposed to "it
 * did not answer this time".
 *
 * A JSON-RPC error CODE is the honest discriminator: -32601 is method not found
 * and -32602 is invalid params, and since the probe sends one well-formed hash,
 * both are the node declining the method rather than judging the request. The
 * word patterns are the observed texts (allnodes/publicnode's archive-token
 * message) plus the ordinary method-gating phrasings other providers use.
 */
const RECEIPT_REFUSAL_PATTERN =
  /-3260[12]|archive request|personal token|method not (found|supported|allowed|available)|unsupported method|invalid param/i;

export type MorphoReceiptCapabilityVerdict = "serves" | "refuses" | "unproven";

export interface MorphoReceiptCapability {
  readonly verdict: MorphoReceiptCapabilityVerdict;
  /** The transaction the probe asked about, when it found one. Sanitised out of nothing. */
  readonly probedTxHash: Hex | null;
  /** The sanitised refusal text on `refuses`, or why the probe was inconclusive. */
  readonly detail: string | null;
}

/**
 * Ask the node whether it will serve `eth_getTransactionReceipt`, using a real
 * transaction taken from its own latest block. Reads only; spends nothing.
 *
 * THREE-WAY, like every other verdict in this file, and for the same reason.
 * `unproven` is NOT a failure: an empty latest block or a transport that did not
 * answer proves nothing about the method, and converting either into a refusal
 * would block healthy executions on a chain with idle blocks. Only a refusal the
 * node actually stated is reported as one.
 */
export async function probeMorphoReceiptCapability(
  client: MorphoActionClient,
): Promise<MorphoReceiptCapability> {
  let probedTxHash: Hex;
  try {
    const block = await client.getBlock({ blockTag: "latest", includeTransactions: false });
    const hash = block.transactions[0];
    if (hash === undefined) {
      return { verdict: "unproven", probedTxHash: null, detail: "the chain's latest block contained no transaction to probe with" };
    }
    probedTxHash = hash;
  } catch (err) {
    return { verdict: "unproven", probedTxHash: null, detail: `the latest block could not be read (${sanitize(err)})` };
  }

  try {
    await client.getTransactionReceipt({ hash: probedTxHash });
    return { verdict: "serves", probedTxHash, detail: null };
  } catch (err) {
    const message = sanitize(err);
    if (RECEIPT_REFUSAL_PATTERN.test(message)) {
      return { verdict: "refuses", probedTxHash, detail: message };
    }
    return { verdict: "unproven", probedTxHash, detail: message };
  }
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
  operation: MorphoPreflightOperation,
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
        `The node could not estimate gas for this transaction as it stands: ${sanitize(err)}. `
        + `${explainFailureFor(operation)} The gas figure is UNKNOWN, not zero.`,
      note,
    };
  }
}

/** Simulate a built transaction against latest state. Spends nothing. */
export async function preflightMorphoTransaction(
  client: MorphoActionClient,
  tx: MorphoBuiltTransaction,
  from: Address,
  operation: MorphoPreflightOperation,
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
          `The node proved this call reverts against latest state. ${explainFailureFor(operation)} `
          + "Nothing was signed or sent.",
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
