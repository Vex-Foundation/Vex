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
 *    guard silently computed ZERO exposure. The compute-unit limit is then
 *    the budget SIMD-0170 grants the assembled transaction, not a guess.
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
import { formatUnits } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { inferDefaultComputeUnitBudget } from "../../shared/solana-transaction/default-compute-unit-budget.js";
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
  /** The limit the response DECLARED, or `null` when it declared none (the documented normal `/build` shape). Never the inferred default — see `priorityFeeIsUpperBound`. */
  readonly computeUnitLimit: number | null;
  readonly computeUnitPriceMicroLamports: bigint | null;
  /**
   * Ceiling-rounded `effectiveComputeUnitLimit × computeUnitPriceMicroLamports
   * / 1e6` — the same arithmetic Jupiter bills by (its own
   * `prioritizationFeeLamports` matched this formula to within one lamport on
   * all twelve rows of `shared/solana-transaction/priority-fee-exposure-
   * measurement.md`; ours rounds up).
   *
   * 0 when the response carries no compute-unit-PRICE instruction (no priority
   * fee is paid regardless of any limit). When a price instruction is present
   * but no compute-unit-LIMIT instruction is, the effective limit is the budget
   * SIMD-0170 grants the assembled transaction
   * (`inferDefaultComputeUnitBudget`), because Solana charges the priority fee
   * on the REQUESTED/granted units, not the consumed ones.
   */
  readonly priorityFeeLamports: bigint;
  /**
   * True when the response declared NO compute-unit limit, so the denominator
   * above was INFERRED from SIMD-0170 rather than read out of an instruction.
   *
   * The field name is now narrower than the truth and is kept anyway: it is
   * persisted inside `prequote.safetyDetail` through `jupiterFeePreviewSchema`,
   * so renaming it would break stored rows for no behavioural gain. What it
   * means today is "inferred, not declared" — and an inferred number is exact
   * rather than an upper bound, since the fee is charged on the granted budget.
   * Callers disclosing `priorityFeeLamports` must therefore not label it a
   * worst case; say the response set no compute-unit limit instead.
   */
  readonly priorityFeeIsUpperBound: boolean;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Every instruction that ends up in the SIGNED transaction, as program ids —
 * the input the SIMD-0170 default-budget rule needs.
 *
 * MUST STAY IN STEP with `assembleFeeBearingSwapTransaction`, which is the one
 * place that decides what is signed. `signedTransactionProgramIds` enumerates
 * the same set (order is irrelevant to a sum), and a test asserts the two agree
 * instruction-for-instruction — a comment alone would not survive someone
 * adding a lane to the assembly.
 *
 * `splicedInstructionProgramIds` are the caller's OWN pre-swap instructions
 * (today: the idempotent treasury fee-ATA create). They are not in the `/build`
 * response but they are in the signed transaction, and each one the chain
 * grants 200,000 CU is ~2M lamports of unaccounted exposure at the priority
 * prices seen on 2026-07-25.
 */
export function signedTransactionProgramIds(
  raw: Pick<
    JupiterSwapBuildResponse,
    "computeBudgetInstructions" | "setupInstructions" | "swapInstruction" | "otherInstructions" | "tipInstruction" | "cleanupInstruction"
  >,
  splicedInstructionProgramIds: readonly string[],
): string[] {
  const programIds = [
    ...raw.computeBudgetInstructions.map((ix) => ix.programId),
    ...raw.setupInstructions.map((ix) => ix.programId),
    ...splicedInstructionProgramIds,
    raw.swapInstruction.programId,
    ...raw.otherInstructions.map((ix) => ix.programId),
  ];
  if (raw.tipInstruction) programIds.push(raw.tipInstruction.programId);
  if (raw.cleanupInstruction) programIds.push(raw.cleanupInstruction.programId);
  return programIds;
}

/**
 * (4) Every `computeBudgetInstructions` entry must be a REAL ComputeBudget-program instruction (never something else disguised there); the decoded priority-fee estimate must stay within the owner exposure cap. Returns the decoded estimate for reuse in the disclosure.
 *
 * WHAT THIS BOUNDS, PRECISELY: the fee CEILING (`limit × price ≤ exposure
 * cap`) — SOL that leaves the wallet. It says nothing about whether the
 * compute-unit limit is large enough for the route to finish; a transaction
 * that runs out of compute reverts atomically and costs only the network fee.
 */
export function assertComputeBudgetWithinPolicy(
  computeBudgetInstructions: readonly JupiterSwapInstruction[],
  signedInstructionProgramIds: readonly string[],
): DecodedPriorityFeeEstimate {
  let computeUnitLimit: number | null = null;
  let computeUnitPriceMicroLamports: bigint | null = null;
  // The deprecated `RequestUnits` variant ALSO carries a compute-unit limit.
  // If one is present we cannot tell what the runtime grants, so the default
  // rule does not apply and we fall back to the conservative maximum.
  let sawDeprecatedRequestUnits = false;

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
    } else if (kind === "RequestUnits") {
      sawDeprecatedRequestUnits = true;
    }
    // RequestHeapFrame: no lamport exposure, pass through unchecked.
  }

  // A price instruction with NO limit instruction is the documented normal
  // `/build` shape ("does not include compute unit limit") — re-confirmed live
  // 2026-07-25 on all four probed pairs. C6 substituted Solana's 1,400,000-CU
  // transaction MAXIMUM here. The chain grants no such thing: it grants the
  // SIMD-0170 default, `builtin x 3,000 + other x 200,000` capped at
  // 1,400,000, which for a real 4-instruction Jupiter build is 406,000 CU. The
  // substitution therefore overstated exposure ~3.4x and refused a legitimate
  // JupUSD->USDC swap on 2026-07-25 at 13,766,234 lamports, where the granted
  // budget puts the same transaction at 3,992,208 — inside the cap.
  //
  // The bound is unchanged and the denominator is now the one the chain bills
  // by, so this is strictly TIGHTER than the substitution it replaces
  // (`inferDefaultComputeUnitBudget` can never exceed 1,400,000): nothing the
  // shipped guard admitted starts being refused.
  const priorityFeeIsUpperBound = computeUnitPriceMicroLamports !== null && computeUnitLimit === null;
  const effectiveComputeUnitLimit = resolveEffectiveComputeUnitLimit(
    computeUnitLimit,
    sawDeprecatedRequestUnits,
    signedInstructionProgramIds,
  );
  const priorityFeeLamports =
    computeUnitPriceMicroLamports !== null
      ? ceilDiv(BigInt(effectiveComputeUnitLimit.units) * computeUnitPriceMicroLamports, 1_000_000n)
      : 0n;
  if (priorityFeeLamports > BigInt(JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS)) {
    // BUDGETED FOR 200 CHARACTERS, like `evm-chains/gas-limit-headroom.ts`.
    // `summarizeProtocolError` joins message and hint and truncates the pair at
    // 200, so the order here IS the priority order. What must survive: the fee,
    // the cap, that nothing was spent, the agent-settable lever
    // (`computeUnitPricePercentile`), and that a re-quote can genuinely work
    // because the price is congestion-driven — the same pair was measured at
    // 13,766,234 -> 465,330 -> 14,601 lamports within minutes on 2026-07-25.
    // The `Basis:` tail is diagnostics and is deliberately last, so truncation
    // eats it first.
    // The ONE lamport figure the agent acts on gets its SOL twin (rule 90):
    // a bare 8-digit lamport number reads as SOL to anyone who skips the
    // suffix. Only this one, because the message is budgeted for 200 characters
    // and the remedy after it must survive truncation. `formatUnits` is used
    // directly rather than `protocols/amount-display.ts` because that owner
    // lives under `src/vex-agent`, which `src/tools` must never import.
    fail(
      `Refusing to sign: priority fee ${priorityFeeLamports} lamports (${formatUnits(priorityFeeLamports, 9)} SOL) exceeds the ${JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS}-lamport cap. `
        + "Nothing signed or spent. Lower computeUnitPricePercentile or re-quote — priority fees swing by the minute. "
        + `Basis: ${effectiveComputeUnitLimit.units} CU ${effectiveComputeUnitLimit.origin} x ${computeUnitPriceMicroLamports} microLamports/CU.`,
    );
  }
  return { computeUnitLimit, computeUnitPriceMicroLamports, priorityFeeLamports, priorityFeeIsUpperBound };
}

/** The compute-unit count the priority fee is actually charged on, plus the phrase that says WHERE it came from (never "declares" about a number we inferred — the agent acts on this text). */
function resolveEffectiveComputeUnitLimit(
  declaredComputeUnitLimit: number | null,
  sawDeprecatedRequestUnits: boolean,
  signedInstructionProgramIds: readonly string[],
): { readonly units: number; readonly origin: string } {
  if (declaredComputeUnitLimit !== null) {
    return { units: declaredComputeUnitLimit, origin: "declared by the response" };
  }
  if (sawDeprecatedRequestUnits) {
    // `RequestUnits` sets a limit too. Inferring the DEFAULT budget while the
    // response declared one another way would UNDER-state the fee, which is
    // exactly what a hostile response would want, so fall back to the
    // conservative maximum rather than guess. Jupiter has never been observed
    // emitting this deprecated variant.
    return { units: SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION, origin: "assumed (response used a deprecated RequestUnits directive)" };
  }
  return {
    units: inferDefaultComputeUnitBudget(signedInstructionProgramIds),
    origin: "granted by default (response declared no compute-unit limit)",
  };
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
  /**
   * Program ids of the caller's OWN pre-swap instructions, which
   * `assembleFeeBearingSwapTransaction` will splice into the same signed
   * transaction (today: the idempotent treasury fee-ATA create, present only
   * when that ATA does not exist yet). Required rather than optional: the
   * priority fee is charged on the whole transaction's granted compute budget,
   * and an instruction nobody declared is budget the estimate cannot see.
   */
  readonly splicedInstructionProgramIds: readonly string[];
}): BuildResponseSafetyVerdict {
  assertBuildResponseMatchesRequest(params.raw, params.request);
  assertFeeAccountPresentInSwapInstruction(params.raw.swapInstruction, params.feeAccount);
  const submitTipProof = assertTipInstructionWithinPolicy(params.raw.tipInstruction, params.approvedTipLamports);
  const priorityFee = assertComputeBudgetWithinPolicy(
    params.raw.computeBudgetInstructions,
    signedTransactionProgramIds(params.raw, params.splicedInstructionProgramIds),
  );
  return { ...priorityFee, submitTipProof };
}
