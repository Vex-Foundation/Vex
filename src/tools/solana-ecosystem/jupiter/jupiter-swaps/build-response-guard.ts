/**
 * Hostile-provider validation for a Jupiter `/build` RESPONSE (Codex batch-4
 * closure blocker C2: "we validate request identity but sign whatever
 * Jupiter returned"). `/build` is an untrusted external response — every
 * field it returns is attacker-reachable if the provider is compromised or a
 * network path is tampered with, so nothing here is trusted merely because
 * we made the request. This module runs BEFORE any instruction from a
 * `/build` response is assembled/signed, from inside
 * `fee-swap.ts`'s `prepareFeeBearingJupiterSwap` (both the quote and the
 * execute path funnel through it — a tampered response must never even
 * reach a disclosed quote).
 *
 * Scope (the blocker's checklist, EXTENDED by the Codex batch-4 turn-2
 * closure round, C6, with the two items marked below):
 * 1. the response echoes the EXACT request identity (mints + input amount);
 * 2. the tip transfer instruction's lamports equal the approved tip, never
 *    exceed the owner tip cap, AND (C6) its RECIPIENT is one of Jupiter's
 *    published tip-receiver accounts — a hostile response could otherwise
 *    redirect the tip to an attacker address while keeping the amount
 *    correct;
 * 3. the treasury fee ATA is present (writable, non-signer) in the swap
 *    instruction's accounts;
 * 4. every `computeBudgetInstructions` entry is a REAL ComputeBudget-program
 *    instruction (never something else disguised there), and the decoded
 *    compute-unit-limit × compute-unit-price estimate stays within the owner
 *    exposure cap — (C6) INCLUDING when the response carries a price
 *    instruction but no explicit limit instruction (the documented normal
 *    `/build` shape: "does not include compute unit limit"), where the prior
 *    guard silently computed ZERO exposure. A conservative UPPER BOUND is
 *    now computed against Solana's transaction-wide max CU instead.
 *
 * Out of scope (flagged, not silently assumed safe): the swap instruction's
 * OWN internal fee cut is opaque aggregator-program instruction data — this
 * module cannot decode "how much of the fee ATA's balance will actually
 * change" without a simulation, which this wave does not perform (mirrors
 * `fee-swap.ts`'s existing decision to disclose a priority-fee STRATEGY
 * rather than a simulated total). `setupInstructions`/`otherInstructions`/
 * `cleanupInstruction` are not content-validated — decoding an aggregator's
 * arbitrary route instructions is infeasible without full route-program
 * knowledge and is not part of the blocker's checklist.
 */

import { ComputeBudgetInstruction, ComputeBudgetProgram, SystemInstruction, SystemProgram } from "@solana/web3.js";

import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS,
  JUPITER_SWAP_TIP_MAX_LAMPORTS,
  JUPITER_TIP_RECEIVER_ADDRESSES,
  SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION,
} from "./constants.js";
import { toTransactionInstruction } from "./build-assembly.js";
import { parseAtomicBigint } from "./fee-swap-revalidate.js";
import { JupiterSubmitTipProof } from "./submit-tip-proof.js";
import type { JupiterSwapBuildResponse, JupiterSwapInstruction } from "./types.js";

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();

function fail(message: string): never {
  throw new VexError(ErrorCodes.SOLANA_SWAP_FAILED, message);
}

/** (1) The response must echo the EXACT request identity — mints + input amount, atomic-unit bigint compare (never lexicographic/float). */
export function assertBuildResponseMatchesRequest(
  raw: Pick<JupiterSwapBuildResponse, "inputMint" | "outputMint" | "inAmount">,
  request: { readonly inputMint: string; readonly outputMint: string; readonly amountRaw: string },
): void {
  if (raw.inputMint !== request.inputMint || raw.outputMint !== request.outputMint) {
    fail(
      `/build response mint mismatch: requested ${request.inputMint} -> ${request.outputMint}, ` +
        `got ${raw.inputMint} -> ${raw.outputMint}. Refusing to sign.`,
    );
  }
  if (parseAtomicBigint("response.inAmount", raw.inAmount) !== parseAtomicBigint("request.amountRaw", request.amountRaw)) {
    fail(`/build response inAmount (${raw.inAmount}) diverges from the requested amount (${request.amountRaw}). Refusing to sign.`);
  }
}

/**
 * (2) The tip transfer instruction's lamports must equal the approved tip
 * and never exceed the owner cap — decoded as a REAL System Program
 * transfer, never trusted from position/label alone. (C6) The transfer's
 * RECIPIENT must also be one of Jupiter's published tip-receiver accounts
 * (`JUPITER_TIP_RECEIVER_ADDRESSES`): a correct lamport amount alone does not
 * prove the tip actually reaches Jupiter's landing infrastructure — a hostile
 * response could redirect it to an attacker-controlled address instead.
 */
export function assertTipInstructionWithinPolicy(
  tipInstruction: JupiterSwapInstruction | null | undefined,
  approvedTipLamports: number,
): JupiterSubmitTipProof | null {
  if (!tipInstruction) {
    if (approvedTipLamports > 0) {
      fail(`/build response is missing the requested tip instruction (${approvedTipLamports} lamports approved). Refusing to sign.`);
    }
    // Legal (an agent may approve a zero tip), but there is nothing to certify
    // — the caller must land this transaction over RPC, never `/submit`.
    return null;
  }
  if (tipInstruction.programId !== SYSTEM_PROGRAM_ID) {
    fail(`/build response's tip instruction targets an unexpected program (${tipInstruction.programId}), not the System Program. Refusing to sign.`);
  }
  let decodedTransfer: ReturnType<typeof SystemInstruction.decodeTransfer>;
  try {
    decodedTransfer = SystemInstruction.decodeTransfer(toTransactionInstruction(tipInstruction));
  } catch (err) {
    fail(`/build response's tip instruction is not a valid System Program transfer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { toPubkey, lamports } = decodedTransfer;
  const recipient = toPubkey.toBase58();
  if (!JUPITER_TIP_RECEIVER_ADDRESSES.includes(recipient)) {
    fail(`/build response's tip instruction pays a recipient (${recipient}) that is not one of Jupiter's published tip-receiver accounts. Refusing to sign — a hostile response could otherwise redirect the tip while keeping the amount correct.`);
  }
  if (lamports !== BigInt(approvedTipLamports)) {
    fail(`/build response tip instruction transfers ${lamports} lamports, expected exactly the approved ${approvedTipLamports}. Refusing to sign.`);
  }
  if (lamports > BigInt(JUPITER_SWAP_TIP_MAX_LAMPORTS)) {
    fail(`/build response tip instruction (${lamports} lamports) exceeds the hard cap of ${JUPITER_SWAP_TIP_MAX_LAMPORTS} lamports (0.01 SOL). Refusing to sign.`);
  }

  // Everything `/tx/v1/submit` requires has now been PROVEN about these exact
  // bytes — an allowlisted receiver and an exact, capped lamport amount — so
  // this is the one honest place to mint the lane evidence (design D1).
  // `certify` still re-checks the receiver and applies the provider's own
  // minimum, so an approved-but-too-small tip yields `null` and the caller
  // falls back to the RPC lane rather than a silent drop.
  return JupiterSubmitTipProof.certify({ recipient, lamports });
}

/** (3) The treasury fee ATA must be present, writable, and not a signer in the swap instruction's own accounts — otherwise the disclosed fee may never actually be charged. */
export function assertFeeAccountPresentInSwapInstruction(
  swapInstruction: Pick<JupiterSwapInstruction, "accounts">,
  feeAccount: string,
): void {
  const match = swapInstruction.accounts.find((a) => a.pubkey === feeAccount);
  if (!match) {
    fail(`/build response's swap instruction does not include the treasury fee account (${feeAccount}). Refusing to sign an instruction set that may not charge the disclosed fee.`);
  }
  if (!match.isWritable || match.isSigner) {
    fail(`/build response's fee account (${feeAccount}) is present but not writable/non-signer as policy requires. Refusing to sign.`);
  }
}

export interface DecodedPriorityFeeEstimate {
  readonly computeUnitLimit: number | null;
  readonly computeUnitPriceMicroLamports: bigint | null;
  /**
   * Ceiling-rounded `computeUnitLimit × computeUnitPriceMicroLamports / 1e6`.
   * 0 when the response carries no compute-unit-PRICE instruction (no
   * priority fee is paid regardless of any limit). When a price instruction
   * is present but no compute-unit-LIMIT instruction is — the documented
   * NORMAL `/build` response shape — `computeUnitLimit` is substituted with
   * `SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION` (1,400,000) as a conservative
   * worst case, since the signed transaction still runs under Solana's
   * default per-instruction CU allocation with no cap tighter than that
   * maximum. See `priorityFeeIsUpperBound`.
   */
  readonly priorityFeeLamports: bigint;
  /**
   * True when `priorityFeeLamports` is the conservative worst-case bound
   * described above (price instruction present, limit instruction absent)
   * rather than an honest `limit × price` computation. Callers disclosing
   * `priorityFeeLamports` to the user/approval layer should label it as an
   * upper bound when this is true.
   */
  readonly priorityFeeIsUpperBound: boolean;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * (4) Every `computeBudgetInstructions` entry must be a REAL ComputeBudget-program instruction (never something else disguised there); the decoded priority-fee estimate must stay within the owner exposure cap. Returns the decoded estimate for reuse in the disclosure.
 *
 * PULLS THE OPPOSITE WAY FROM THE PRE-SIGN SUFFICIENCY GATE, ON PURPOSE. This
 * bounds the fee CEILING (`limit × price ≤ exposure cap`) and therefore rewards
 * a LOW compute-unit limit — which is precisely what makes compute starvation
 * more likely, the failure that
 * `shared/solana-transaction/compute-budget-sufficiency.ts` refuses to sign.
 * One caps what a transaction may COST; the other refuses a transaction that
 * cannot AFFORD to finish. Do not "optimize" either one against the other.
 */
export function assertComputeBudgetWithinPolicy(
  computeBudgetInstructions: readonly JupiterSwapInstruction[],
): DecodedPriorityFeeEstimate {
  let computeUnitLimit: number | null = null;
  let computeUnitPriceMicroLamports: bigint | null = null;

  for (const wire of computeBudgetInstructions) {
    if (wire.programId !== COMPUTE_BUDGET_PROGRAM_ID) {
      fail(`/build response's computeBudgetInstructions contains a non-ComputeBudget-program instruction (${wire.programId}). Refusing to sign an unrecognized instruction disguised as a compute-budget directive.`);
    }
    const ix = toTransactionInstruction(wire);
    let kind: ReturnType<typeof ComputeBudgetInstruction.decodeInstructionType>;
    try {
      kind = ComputeBudgetInstruction.decodeInstructionType(ix);
    } catch (err) {
      fail(`/build response's computeBudgetInstructions contains an undecodable instruction: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (kind === "SetComputeUnitLimit") {
      computeUnitLimit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
    } else if (kind === "SetComputeUnitPrice") {
      computeUnitPriceMicroLamports = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
    }
    // RequestUnits/RequestHeapFrame: no lamport exposure, pass through unchecked.
  }

  // (C6) A price instruction with NO limit instruction is the documented
  // normal `/build` shape ("does not include compute unit limit") — the
  // prior guard treated this as computeUnitLimit===null and silently
  // computed ZERO exposure. Substitute Solana's transaction-wide max CU as a
  // conservative upper bound instead of trusting an absent limit as "no
  // exposure".
  const priorityFeeIsUpperBound = computeUnitPriceMicroLamports !== null && computeUnitLimit === null;
  const effectiveComputeUnitLimit = computeUnitLimit ?? SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION;
  const priorityFeeLamports =
    computeUnitPriceMicroLamports !== null
      ? ceilDiv(BigInt(effectiveComputeUnitLimit) * computeUnitPriceMicroLamports, 1_000_000n)
      : 0n;
  if (priorityFeeLamports > BigInt(JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS)) {
    fail(
      `/build response's estimated priority fee (${priorityFeeLamports} lamports` +
        `${priorityFeeIsUpperBound ? ", upper bound — no explicit compute-unit limit in the response" : ""}) ` +
        `exceeds the approved exposure cap of ${JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS} lamports. Refusing to sign.`,
    );
  }
  return { computeUnitLimit, computeUnitPriceMicroLamports, priorityFeeLamports, priorityFeeIsUpperBound };
}

/** What the guard PROVED about a `/build` response — the decoded priority-fee estimate plus the landing-lane evidence (design D1). */
export interface BuildResponseSafetyVerdict extends DecodedPriorityFeeEstimate {
  /**
   * Non-null ONLY when the response's tip instruction satisfies Jupiter's
   * `/tx/v1/submit` contract. `null` means the transaction must land over RPC
   * — see `submit-tip-proof.ts`.
   */
  readonly submitTipProof: JupiterSubmitTipProof | null;
}

/**
 * Orchestrates all four checks in one call — the ONE entry point
 * `prepareFeeBearingJupiterSwap` calls, right after receiving `raw` and
 * BEFORE assembling any signable transaction bytes. Any violation throws
 * (pre-broadcast failure, never a signature). Returns the decoded priority-
 * fee estimate so the caller can fold an HONEST (response-decoded, not
 * guessed) number into the persisted fee preview, plus the landing-lane
 * evidence minted by the tip check.
 */
export function assertBuildResponseSafeToSign(params: {
  readonly raw: JupiterSwapBuildResponse;
  readonly request: { readonly inputMint: string; readonly outputMint: string; readonly amountRaw: string };
  readonly feeAccount: string;
  readonly approvedTipLamports: number;
}): BuildResponseSafetyVerdict {
  assertBuildResponseMatchesRequest(params.raw, params.request);
  assertFeeAccountPresentInSwapInstruction(params.raw.swapInstruction, params.feeAccount);
  const submitTipProof = assertTipInstructionWithinPolicy(params.raw.tipInstruction, params.approvedTipLamports);
  const priorityFee = assertComputeBudgetWithinPolicy(params.raw.computeBudgetInstructions);
  return { ...priorityFee, submitTipProof };
}
