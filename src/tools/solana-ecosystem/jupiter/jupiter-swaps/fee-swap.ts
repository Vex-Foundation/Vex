/**
 * Fee-bearing Jupiter `/build` swap engine (W5 design `w5-design.md`
 * §6/R4/R4b — the atomic quote/execute `/build` flip).
 *
 * `prepareFeeBearingJupiterSwap` is the ONE place that constructs a real
 * `/build` request: `platformFeeBps`/`feeAccount` are ALWAYS the hardcoded
 * constant + the derived treasury ATA — never taken from caller params, so
 * neither is model-controllable (R4 test requirement). The quote handler and
 * the execute handler both call this same function so the bound economics
 * (fee, tip, CU strategy, DEX filters, `maxAccounts`, wrap behavior) are
 * identical by construction, never independently re-derived.
 *
 * The `/build` RESPONSE is untrusted (Codex batch-4 closure blocker C2): this
 * function validates it via `assertBuildResponseSafeToSign` (request-identity
 * echo, tip/fee-ATA/compute-budget policy) BEFORE assembling any signable
 * transaction bytes — for BOTH the quote and the execute call, since a
 * tampered response must never even reach a disclosed quote.
 */

import { Connection, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { ACCOUNT_SIZE, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { z } from "zod";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { VEX_TREASURY_SOLANA } from "../../../../lib/vex-treasury.js";
import { atomicToExactDecimalString } from "../../shared/solana-validation.js";
import { deriveAssociatedTokenAccount, resolveMintTokenProgramId } from "../../shared/solana-token-program.js";
import { jupiterSwapBuild } from "./client.js";
import { assembleFeeBearingSwapTransaction } from "./build-assembly.js";
import { assertBuildResponseSafeToSign } from "./build-response-guard.js";
import type { JupiterSubmitTipProof } from "./submit-tip-proof.js";
import {
  JUPITER_SWAP_DEFAULT_CU_PERCENTILE,
  JUPITER_SWAP_FEE_BPS,
  JUPITER_SWAP_LANDING_MODE,
  JUPITER_SWAP_TIP_DEFAULT_LAMPORTS,
  JUPITER_SWAP_TIP_MAX_LAMPORTS,
} from "./constants.js";
import type { JupiterSwapBuildParams, JupiterSwapBuildResponse, JupiterSwapComputeUnitPricePercentile } from "./types.js";

// ── Agent-controlled knobs (bounded, canonicalized) ─────────────────────

export interface JupiterFeeSwapKnobs {
  readonly slippageBps: number | undefined;
  readonly tipLamports: number;
  readonly computeUnitPricePercentile: JupiterSwapComputeUnitPricePercentile;
  readonly dexes: string | undefined;
  readonly excludeDexes: string | undefined;
  readonly maxAccounts: number | undefined;
  readonly wrapAndUnwrapSol: boolean;
  readonly forJitoBundle: boolean;
}

/**
 * Parse + validate the agent-controlled (non-fee) knobs from raw tool params.
 * `tipLamports` is the ONE Vex-specific bound beyond what the SDK layer
 * (`validateJupiterSwapBuildParams`) already range-checks — never silently
 * clamped, rejected outright above the owner cap.
 */
export function resolveJupiterFeeSwapKnobs(params: Record<string, unknown>): JupiterFeeSwapKnobs {
  const tipLamports =
    typeof params.tipLamports === "number" ? params.tipLamports : JUPITER_SWAP_TIP_DEFAULT_LAMPORTS;
  if (!Number.isInteger(tipLamports) || tipLamports < 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid tipLamports: ${tipLamports}`,
      "tipLamports must be a non-negative integer (lamports).",
    );
  }
  if (tipLamports > JUPITER_SWAP_TIP_MAX_LAMPORTS) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `tipLamports ${tipLamports} exceeds the maximum of ${JUPITER_SWAP_TIP_MAX_LAMPORTS} lamports (0.01 SOL).`,
    );
  }

  const cu = params.computeUnitPricePercentile;
  const computeUnitPricePercentile: JupiterSwapComputeUnitPricePercentile =
    typeof cu === "number" || typeof cu === "string"
      ? (cu as JupiterSwapComputeUnitPricePercentile)
      : JUPITER_SWAP_DEFAULT_CU_PERCENTILE;

  const dexes = typeof params.dexes === "string" && params.dexes.trim() ? params.dexes.trim() : undefined;
  const excludeDexes =
    typeof params.excludeDexes === "string" && params.excludeDexes.trim() ? params.excludeDexes.trim() : undefined;
  const maxAccounts = typeof params.maxAccounts === "number" ? params.maxAccounts : undefined;
  const wrapAndUnwrapSol = params.wrapAndUnwrapSol !== false;
  const forJitoBundle = params.forJitoBundle === true;
  const slippageBps = typeof params.slippageBps === "number" ? params.slippageBps : undefined;

  return { slippageBps, tipLamports, computeUnitPricePercentile, dexes, excludeDexes, maxAccounts, wrapAndUnwrapSol, forJitoBundle };
}

/**
 * The prequote-identity tail (design R4: "prequote identity hash extended
 * with: feeBps, feeMint, tip, CU strategy, dexes, maxAccounts, wrap"). Bundles
 * dexes/excludeDexes/maxAccounts/wrap/forJitoBundle into one canonical
 * `routeKnobs` string so a divergence in ANY of them still changes the digest,
 * without growing `hash.ts`'s material list by five separate fields. Called
 * identically at quote-record time and execute-gate time so the SAME bound
 * economics produce the SAME hash tail.
 */
export function canonicalizeJupiterFeeTail(
  knobs: JupiterFeeSwapKnobs,
  feeMint: string,
): { feeBps: string; feeMint: string; tipLamports: string; cuStrategy: string; routeKnobs: string } {
  return {
    feeBps: String(JUPITER_SWAP_FEE_BPS),
    feeMint,
    tipLamports: String(knobs.tipLamports),
    cuStrategy: String(knobs.computeUnitPricePercentile),
    routeKnobs: [
      knobs.dexes ?? "",
      knobs.excludeDexes ?? "",
      knobs.maxAccounts ?? "",
      knobs.wrapAndUnwrapSol ? "1" : "0",
      knobs.forJitoBundle ? "1" : "0",
    ].join("|"),
  };
}

// ── Fee-bearing /build preparation ──────────────────────────────────────

export interface PreparedFeeBearingSwap {
  readonly raw: JupiterSwapBuildResponse;
  readonly unsignedTx: VersionedTransaction;
  readonly feeMint: string;
  readonly feeAccount: string;
  readonly feeAccountExists: boolean;
  readonly ataRentLamports: number | null;
  readonly knobs: JupiterFeeSwapKnobs;
  /**
   * The SAME blockhash evidence baked into `unsignedTx` (`raw.
   * blockhashWithMetadata`, re-exposed here as VERIFY-mode-ready evidence for
   * `prepareVersionedTx` — base58 blockhash string, not the raw byte array).
   * Guaranteed non-null: `assembleFeeBearingSwapTransaction` already throws if
   * `raw.blockhashWithMetadata` were absent, so reaching this return means it
   * was present.
   */
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  /** 25bps of `raw.inAmount`, exact bigint floor division — atomic-unit string. */
  readonly feeAmountRaw: string;
  /** Same value as `feeAmountRaw`, formatted as an exact decimal string (input mint's own decimals) for human disclosure. */
  readonly feeAmountDecimal: string;
  /** Decoded straight off the RESPONSE's own ComputeBudget instructions (`build-response-guard.ts`) — an honest, response-derived number, not a guess; 0 when the response carries no compute-unit-price instruction. When the response declared no compute-unit limit the denominator is the budget SIMD-0170 grants this exact transaction — see `priorityFeeIsUpperBound`. */
  readonly priorityFeeLamportsEstimate: number;
  /** True when the `/build` response declared NO compute-unit limit (the documented normal shape), so the denominator was INFERRED from SIMD-0170 rather than read out of an instruction. Not a worst case: Solana charges the priority fee on the granted budget, so the number is what the transaction costs. The field name predates the fix and is kept because `jupiterFeePreviewSchema` persists it — see `build-response-guard.ts`. */
  readonly priorityFeeIsUpperBound: boolean;
  /**
   * Landing-lane evidence minted by `assertBuildResponseSafeToSign` (design
   * D1). Non-null only when the assembled transaction carries a tip meeting
   * Jupiter's `/tx/v1/submit` contract; `null` (e.g. an agent-approved zero
   * tip) means the caller MUST land it over RPC instead, or the transaction
   * would be dropped without ever reaching the network.
   */
  readonly submitTipProof: JupiterSubmitTipProof | null;
}

/**
 * Build the fee-bearing `/build` request + assemble the unsigned transaction.
 * `platformFeeBps`/`feeAccount` are ALWAYS the hardcoded constant + the
 * derived treasury ATA (fee charged on the INPUT mint — a VEX PRODUCT POLICY
 * choice for Kyber-parity accounting, NOT a Jupiter provider requirement:
 * `/docs/swap/build` documents `feeAccount` as ANY SPL token account the
 * caller controls, with no mint-direction mandate — see `constants.ts` and
 * `deltas/C2.md` DOCS-GAP #1) — never read from `knobs`/params, so neither is
 * model-controllable regardless of what a caller passes in. When the
 * treasury's fee ATA does not yet exist, an idempotent create instruction is
 * spliced in BEFORE the swap instruction (Jupiter docs
 * `/docs/swap/build/common-instructions`: "you are responsible for creating
 * and managing this account").
 */
export async function prepareFeeBearingJupiterSwap(params: {
  readonly connection: Connection;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountRaw: string;
  readonly taker: string;
  readonly knobs: JupiterFeeSwapKnobs;
  /** The input mint's decimals — needed ONLY to format `feeAmountDecimal`'s exact-decimal disclosure string; never used for amount math (that stays atomic-unit bigint). */
  readonly inputDecimals: number;
}): Promise<PreparedFeeBearingSwap> {
  const { connection, inputMint, outputMint, amountRaw, taker, knobs, inputDecimals } = params;

  // Fee is charged on the INPUT mint — a VEX PRODUCT POLICY choice (Kyber
  // parity), NOT a Jupiter requirement (docs allow ANY controlled SPL
  // account; unconfirmed pending the live treasury-delta test, design §6 /
  // C2 DOCS-GAP #1) — `inputMint` is already the wSOL mint address for a
  // native-SOL leg (Jupiter's own token resolution convention), so no
  // separate native-sentinel branch is needed.
  const feeMint = inputMint;
  const feeMintPubkey = new PublicKey(feeMint);
  const treasury = new PublicKey(VEX_TREASURY_SOLANA);
  const tokenProgramId = await resolveMintTokenProgramId(connection, feeMint);
  const feeAccount = deriveAssociatedTokenAccount(treasury, feeMintPubkey, tokenProgramId);
  const feeAccountInfo = await connection.getAccountInfo(feeAccount);
  const feeAccountExists = feeAccountInfo !== null;
  const ataRentLamports = feeAccountExists
    ? null
    : await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

  const buildParams: JupiterSwapBuildParams = {
    inputMint,
    outputMint,
    amount: amountRaw,
    taker,
    // Hardcoded, product-owner-reviewed — see constants.ts. NEVER from knobs.
    platformFeeBps: JUPITER_SWAP_FEE_BPS,
    feeAccount: feeAccount.toBase58(),
    ...(knobs.slippageBps !== undefined ? { slippageBps: knobs.slippageBps } : {}),
    ...(knobs.dexes !== undefined ? { dexes: knobs.dexes } : {}),
    ...(knobs.excludeDexes !== undefined ? { excludeDexes: knobs.excludeDexes } : {}),
    ...(knobs.maxAccounts !== undefined ? { maxAccounts: knobs.maxAccounts } : {}),
    wrapAndUnwrapSol: knobs.wrapAndUnwrapSol,
    tipAmount: knobs.tipLamports,
    computeUnitPricePercentile: knobs.computeUnitPricePercentile,
    forJitoBundle: knobs.forJitoBundle,
  };
  const raw = await jupiterSwapBuild(buildParams);

  // Built BEFORE the guard runs because the guard needs them: the priority fee
  // is charged on the granted compute budget of the WHOLE signed transaction,
  // and this instruction is part of it. Nothing is assembled or signed yet.
  const preSwapInstructions: TransactionInstruction[] = feeAccountExists
    ? []
    : [
        createAssociatedTokenAccountIdempotentInstruction(
          new PublicKey(taker),
          feeAccount,
          treasury,
          feeMintPubkey,
          tokenProgramId,
        ),
      ];

  // Hostile-response validation (Codex batch-4 closure blocker C2) — BEFORE
  // any instruction from `raw` is assembled into signable bytes. Any
  // violation throws; the priority-fee estimate it decodes feeds the
  // disclosure below (honest, response-derived — not a guess), and the tip
  // proof it mints selects the landing lane (design D1).
  const verdict = assertBuildResponseSafeToSign({
    raw,
    request: { inputMint, outputMint, amountRaw },
    feeAccount: feeAccount.toBase58(),
    approvedTipLamports: knobs.tipLamports,
    splicedInstructionProgramIds: preSwapInstructions.map((ix) => ix.programId.toBase58()),
  });

  const unsignedTx = assembleFeeBearingSwapTransaction(raw, preSwapInstructions, new PublicKey(taker));

  // ESTIMATED fee amount — 25bps of the RESPONSE's own inAmount (already
  // proven equal to the request by the guard above), exact bigint floor
  // division. "Estimated": the swap instruction's actual internal fee cut is
  // opaque aggregator instruction data this wave does not decode/simulate.
  const feeAmountRaw = (BigInt(raw.inAmount) * BigInt(JUPITER_SWAP_FEE_BPS)) / 10_000n;

  return {
    raw,
    unsignedTx,
    feeMint,
    feeAccount: feeAccount.toBase58(),
    feeAccountExists,
    ataRentLamports,
    knobs,
    recentBlockhash: unsignedTx.message.recentBlockhash,
    lastValidBlockHeight: raw.blockhashWithMetadata!.lastValidBlockHeight,
    feeAmountRaw: feeAmountRaw.toString(),
    feeAmountDecimal: atomicToExactDecimalString(feeAmountRaw, inputDecimals),
    priorityFeeLamportsEstimate: Number(verdict.priorityFeeLamports),
    priorityFeeIsUpperBound: verdict.priorityFeeIsUpperBound,
    submitTipProof: verdict.submitTipProof,
  };
}

// ── Fee preview (persisted at QUOTE, disclosed at approval) ─────────────

/**
 * Bounded, Zod-validated disclosure persisted at QUOTE time (design R4:
 * "quoted amounts, otherAmountThreshold, fee amount/mint/treasury-ATA, ATA
 * rent if missing, priority-fee estimate, tip, landing mode"). No raw
 * provider text — every field is a scalar the recorder/gate can round-trip
 * through `safetyDetail` JSONB and the approval preview can render directly.
 * `feeAmountRaw`/`feeAmountDecimal` (Codex batch-4 closure blocker C2: "the
 * ESTIMATED FEE AMOUNT, exact-decimal") are the actual 25bps token amount, not
 * just the bps rate. `priorityFeeStrategy` is the DISCLOSED knob
 * (`computeUnitPricePercentile`); `priorityFeeLamportsEstimate` is decoded
 * straight off the RESPONSE's own ComputeBudget instructions — an honest,
 * response-derived number (0 when the response carries no compute-unit-price
 * instruction), not a fabricated guess. `priorityFeeIsUpperBound` (C6) flags
 * when its compute-unit denominator was INFERRED from SIMD-0170's default-
 * budget rule because the response declared no limit (the documented normal
 * `/build` shape) rather than read out of a limit instruction.
 */
export const jupiterFeePreviewSchema = z.object({
  inAmountRaw: z.string(),
  outAmountRaw: z.string(),
  otherAmountThresholdRaw: z.string(),
  feeBps: z.number(),
  feeAmountRaw: z.string(),
  feeAmountDecimal: z.string(),
  feeMint: z.string(),
  feeAccount: z.string(),
  feeAccountExists: z.boolean(),
  ataRentLamports: z.number().nullable(),
  tipLamports: z.number(),
  priorityFeeStrategy: z.string(),
  priorityFeeLamportsEstimate: z.number(),
  priorityFeeIsUpperBound: z.boolean(),
  landingMode: z.literal(JUPITER_SWAP_LANDING_MODE),
});

export type JupiterFeePreview = z.infer<typeof jupiterFeePreviewSchema>;

export function buildJupiterFeePreview(prepared: PreparedFeeBearingSwap): JupiterFeePreview {
  return {
    inAmountRaw: prepared.raw.inAmount,
    outAmountRaw: prepared.raw.outAmount,
    otherAmountThresholdRaw: prepared.raw.otherAmountThreshold,
    feeBps: JUPITER_SWAP_FEE_BPS,
    feeAmountRaw: prepared.feeAmountRaw,
    feeAmountDecimal: prepared.feeAmountDecimal,
    feeMint: prepared.feeMint,
    feeAccount: prepared.feeAccount,
    feeAccountExists: prepared.feeAccountExists,
    ataRentLamports: prepared.ataRentLamports,
    tipLamports: prepared.knobs.tipLamports,
    priorityFeeStrategy: String(prepared.knobs.computeUnitPricePercentile),
    priorityFeeLamportsEstimate: prepared.priorityFeeLamportsEstimate,
    priorityFeeIsUpperBound: prepared.priorityFeeIsUpperBound,
    landingMode: JUPITER_SWAP_LANDING_MODE,
  };
}
