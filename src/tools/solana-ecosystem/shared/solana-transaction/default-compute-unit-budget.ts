/**
 * SIMD-0170 — the compute-unit budget Solana's runtime GRANTS a transaction
 * that declares no `SetComputeUnitLimit` of its own:
 *
 *     min(builtinInstructions x 3_000 + otherInstructions x 200_000, 1_400_000)
 *
 * SOURCE: `anza-xyz/agave` v4.1.0,
 * `compute-budget-instruction/src/compute_budget_instruction_details.rs`
 * `calculate_default_compute_unit_limit`, with the two constants from
 * `program-runtime/src/execution_budget.rs`. SIMD-0170 activated at epoch 758;
 * mainnet-beta is well past it, so the LEGACY rule
 * (`instructionCount x 200_000`) is dead — do not restore it, it over-states
 * the granted budget by up to 66x for builtin-heavy transactions.
 *
 * WHY IT LIVES HERE, IN THE SHARED TRANSACTION LAYER. It is a fact about the
 * chain, not about a venue — the same reasoning that already put
 * `SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION` in `./constants.ts`. Two copies of
 * a chain rule is exactly how venues drift apart. Its first consumer is
 * `jupiter-swaps/build-response-guard.ts`; the phase-3 item 6b priority-fee
 * ceiling for the four opaque-blob lanes is meant to consume the SAME function
 * (see `./priority-fee-exposure-measurement.md`), which is why the input is a
 * plain list of program ids rather than a `/build`-shaped response.
 *
 * WHY IT EXISTS (live, 2026-07-25). `build-response-guard.ts` substituted
 * Solana's 1,400,000-CU transaction MAXIMUM whenever a `/build` response
 * carried a compute-unit PRICE but no explicit LIMIT — which is the documented
 * NORMAL response shape, so the substitution was the common path, not the edge
 * case. The chain grants nothing of the sort: a real 4-instruction Jupiter
 * build is granted ~406,000 CU. A legitimate JupUSD->USDC swap was refused
 * that day for an "estimated priority fee (13766234 lamports, upper bound)"
 * that, at the budget actually granted, was 3,992,208 lamports — comfortably
 * inside the owner's 10,000,000-lamport cap.
 *
 * INSTRUCTION SHAPES, PROBED LIVE 2026-07-25 against `api.jup.ag/swap/v2/build`
 * (free, read-only; taker was a publicly documented exchange hot wallet, no
 * signature produced). All four returned exactly ONE ComputeBudget instruction,
 * `SetComputeUnitPrice`, and no limit:
 *
 *   | pair                | instructions                              | granted   |
 *   |---------------------|-------------------------------------------|-----------|
 *   | JupUSD->USDC        | cbPrice, ataCreate, jupSwap, tip          |   406,000 |
 *   | USDC->SOL 1 USDC    | + tokenClose cleanup                      |   606,000 |
 *   | SOL->USDC 0.01 SOL  | 8 ix (wrap setup: ata/system/token/ata)   | 1,009,000 |
 *
 * DIRECTION OF ERROR, AND WHY IT IS THE OPPOSITE OF THE MODULE THIS WAS
 * RECOVERED FROM. This rule previously lived inside the pre-sign compute-budget
 * SUFFICIENCY gate (deleted by owner decision 2026-07-25; recoverable at commit
 * `a68afc32`). That gate asked "is the budget big enough to finish?", so
 * UNDER-estimating the budget made it stricter. This consumer asks "does
 * `budget x price` cost more than the owner allows?", so under-estimating makes
 * it LOOSER. Any future edit here must be re-argued against the consumer at
 * hand; do not copy a safety claim across from the old module's comments.
 */

import {
  BPF_LOADER_DEPRECATED_PROGRAM_ID,
  BPF_LOADER_PROGRAM_ID,
  ComputeBudgetProgram,
  Ed25519Program,
  Secp256k1Program,
  SystemProgram,
} from "@solana/web3.js";

import { SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION } from "./constants.js";

/** SIMD-0170 `MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT` — what a builtin instruction is granted by default. */
export const SOLANA_DEFAULT_COMPUTE_UNITS_PER_BUILTIN_INSTRUCTION = 3_000;

/** `DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT` — what every non-builtin instruction is granted by default. */
export const SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;

/**
 * The programs Agave still treats as BUILTIN for default-budget purposes, as of
 * `solana-core` 4.1.0. Everything else costs `200_000`.
 *
 * Six come from `@solana/web3.js` so they cannot be mistyped. The two loaders
 * it does not export are string literals, guarded by a test that constructs
 * every entry through `new PublicKey` — a wrong-length key throws there rather
 * than silently misclassifying a program at runtime.
 *
 * DELIBERATELY NOT HERE (they cost 200,000 each): Vote — evicted by SIMD-0387 —
 * plus Stake, Config and Address Lookup Table, which completed their core-BPF
 * migration, and SPL Token, SPL Associated Token Account and Secp256r1, which
 * were never builtin. The widely-cited "12 builtin programs" list from the 2024
 * SIMD-0170 document is STALE; do not restore it.
 *
 * SURPRISE WORTH KEEPING: ComputeBudget instructions COUNT here, as builtins
 * (+3,000 each). SIMD-0170's PROSE says "excluding compute budget instructions"
 * — that sentence describes a different counter, and the shipped code plus its
 * own unit test are authoritative. A future reader will want to "fix" this
 * back; do not.
 *
 * WHY A HARD-CODED LIST IS ACCEPTABLE. Solana's core-BPF migration runs ONE
 * WAY: programs leave the builtin table, they do not join it (Vote, Stake,
 * Config and ALT all left). So the only drift this list can suffer is a stale
 * entry, which credits 3,000 where the runtime grants 200,000 — an
 * UNDER-estimate of the granted budget and therefore of the fee.
 *
 * State the consequence plainly rather than inheriting the old module's
 * "conservative" label: for a COST bound an under-estimate is the LESS
 * protective direction. It is bounded at 197,000 CU per stale entry, and the
 * only entries reachable from a Jupiter `/build` transaction are System and
 * ComputeBudget, both runtime-native rather than migration candidates. If this
 * is ever revisited, re-verify against `builtins-default-costs/src/lib.rs` at
 * whatever Agave version mainnet is running.
 */
export const SOLANA_BUILTIN_PROGRAM_IDS: ReadonlySet<string> = new Set([
  SystemProgram.programId.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  BPF_LOADER_PROGRAM_ID.toBase58(),
  BPF_LOADER_DEPRECATED_PROGRAM_ID.toBase58(),
  Ed25519Program.programId.toBase58(),
  Secp256k1Program.programId.toBase58(),
  "BPFLoaderUpgradeab1e11111111111111111111111", // BPF Loader Upgradeable — not exported by web3.js.
  "LoaderV411111111111111111111111111111111111", // Loader v4 — not exported by web3.js.
]);

/**
 * The compute-unit budget the runtime grants a transaction made of these
 * instructions, when the transaction declares no limit of its own.
 *
 * `instructionProgramIds` must be EVERY instruction of the transaction that
 * will actually be signed, in any order — including the ComputeBudget
 * instructions themselves and anything the caller splices in. An instruction
 * omitted here is 3,000–200,000 CU of budget the caller will not see, and for a
 * cost bound that is money the estimate does not account for.
 *
 * A program id that is not in the builtin set is credited the NON-builtin
 * 200,000. That single branch deliberately covers both "a program we know is
 * not builtin" and "an id we cannot classify at all" (a caller that could not
 * resolve a v0 message's program index, or a malformed key): for a cost bound,
 * crediting more CU yields a larger estimated fee and therefore an EARLIER
 * refusal, which is the fund-protective direction. The sufficiency gate this
 * rule was recovered from wanted the opposite and its comment said so while its
 * code did this; the code was right for a cost consumer, the comment was not.
 */
export function inferDefaultComputeUnitBudget(instructionProgramIds: readonly string[]): number {
  let budget = 0;
  for (const programId of instructionProgramIds) {
    budget += SOLANA_BUILTIN_PROGRAM_IDS.has(programId)
      ? SOLANA_DEFAULT_COMPUTE_UNITS_PER_BUILTIN_INSTRUCTION
      : SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION;
  }
  // The runtime clamps the default the same way it clamps a requested limit.
  return Math.min(budget, SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION);
}
