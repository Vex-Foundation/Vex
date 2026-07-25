/**
 * Compute-budget sufficiency policy for every Solana transaction Vex signs.
 *
 * This is a RISK POLICY, not a venue detail — the Solana counterpart of
 * `evm-chains/gas-limit-headroom.ts`. It lives in its own module because
 * `./prepare.ts` owns the signer and blockhash contracts, and compute-budget
 * risk is a different reason to change; a per-venue copy of the margin is
 * precisely how venues drift apart.
 *
 * WHY IT EXISTS (live, 2026-07-25). `solana.swap.execute` JupUSD→USDC signed a
 * Jupiter `/build` transaction declaring 606,000 compute units. On-chain it
 * consumed all 606,000 and died `{"InstructionError":[3,"ProgramFailedToComplete"]}`,
 * burning 15,023 lamports for nothing:
 *
 *     Program ript…BS7j consumed 500158 of 500158 compute units
 *     Program ript…BS7j failed: exceeded CUs meter at BPF instruction
 *     Program JUP6…TaV4 consumed 581994 of 581994 compute units
 *     Program JUP6…TaV4 failed: Program failed to complete
 *
 * The limit came from the provider and nothing checked it before signing. A
 * PROVIDER'S NUMBER IS A HINT, NEVER A FLOOR — and unlike EVM we cannot rewrite
 * it, because it is baked into bytes whose signature we must not invalidate.
 * What we CAN do is refuse. `simulateTransaction` is free and honours the
 * declared limit: PROBE A rewrote a healthy swap's `SetComputeUnitLimit` down
 * from 55,773 to 36,532 and the simulation reproduced the live failure's exact
 * shape, so this gate would have refused the transaction that burned the fee.
 *
 * AN ADMISSION GATE, NOT A GUARANTEE. This is the single most important thing
 * to understand before changing anything here. Simulation runs against a node's
 * CURRENT bank, with the blockhash replaced on the node's own copy; the
 * transaction later executes at a DIFFERENT slot against DIFFERENT account
 * state. A transaction this gate admits can still starve. What the gate does is
 * refuse the ones that measurably cannot fit, with margin for the drift we
 * measured. Never write "proves", "guarantees", or "will succeed" here or in a
 * refusal string — the agent acts on that text.
 *
 * WHY THE MARGIN IS 110% AND NOT EVM'S 200%. Different lever. On EVM we CHOOSE
 * the gas limit and the sender pays for gas USED, so generosity is nearly free
 * and a large multiplier only buys safety. Here the limit is fixed inside
 * provider bytes; our margin is only a REFUSAL THRESHOLD. An over-generous
 * margin buys no headroom at all — it just refuses healthy trades.
 *
 * CALIBRATION. 110 is measured, not guessed: 65 simulations over 13 fresh
 * quotes on 4 pairs, mainnet, 2026-07-25. The per-quote table, the two derived
 * bounds, the admissible window [1.066, 1.165], and the command that
 * regenerates all of it are in `./compute-budget-margin-measurement.md` next to
 * this file. Read that before changing the number; a comment is not evidence.
 *
 * THE TWO COMPUTE-BUDGET GUARDS PULL IN OPPOSITE DIRECTIONS, ON PURPOSE.
 * `jupiter-swaps/build-response-guard.ts`'s `assertComputeBudgetWithinPolicy`
 * bounds the fee CEILING (`limit × price ≤ exposure cap`) and therefore REWARDS
 * a LOW compute-unit limit — which is exactly what makes the starvation this
 * module prevents more likely. A future reader must not "optimize" one against
 * the other: one caps what a transaction may COST, this one refuses a
 * transaction that cannot AFFORD to finish.
 *
 * SIGNING SAFETY. This runs strictly BEFORE `signVersionedTx`, so it never
 * sees, logs, or emits signed bytes or key material. Refusing pre-signature
 * costs nothing: no signature exists, no row is staged, no fee is paid.
 */

import {
  BPF_LOADER_DEPRECATED_PROGRAM_ID,
  BPF_LOADER_PROGRAM_ID,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Ed25519Program,
  Secp256k1Program,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import type {
  Connection,
  SimulatedTransactionResponse,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { extractProgramErrorMessage } from "./program-error-reason.js";
import { MAX_SOLANA_ONCHAIN_ERROR_CHARS, summarizeSolanaOnChainError } from "./onchain-error-summary.js";

/**
 * Percentage of the SIMULATED consumption a transaction's own declared limit
 * must cover before Vex will sign it. CALIBRATED — the measurement, the
 * derivation and the reproduction command are in
 * `./compute-budget-margin-measurement.md`.
 */
export const SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT = 110;

/**
 * Solana's transaction-wide maximum compute-unit limit. Also consumed by
 * `jupiter-swaps/build-response-guard.ts` (re-exported through
 * `jupiter-swaps/constants.ts`) as the CONSERVATIVE assumed limit when a
 * `/build` response carries a compute-unit-PRICE instruction but no
 * compute-unit-LIMIT instruction — the documented normal shape of a `/build`
 * response (`/docs/swap/build`: `computeBudgetInstructions` is "compute unit
 * price instruction (does not include compute unit limit)"), which the signed
 * transaction still executes under Solana's default per-instruction CU
 * allocation with no cap tighter than this maximum. Live-reverified 2026-07-24
 * (Codex batch-4 turn-2 closure, C6).
 */
export const SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION = 1_400_000;

/** The runtime's generic per-program failure line, used only when no program authored a sentence of its own. */
const PROGRAM_FAILED_LINE = /^Program \S+ failed: /;

/**
 * Refuse to sign unless a free `simulateTransaction` SHOWS the transaction's
 * declared compute budget covering the work it is about to do, with the
 * calibrated margin on top. Resolves silently when it does; throws
 * `SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT` otherwise.
 *
 * Fails CLOSED at every ambiguity — conflicting budget directives, a budget we
 * cannot bound, an unreachable RPC, an RPC that does not report consumption, a
 * simulation that errored — because the alternative is signing blind, which is
 * the defect this exists to prevent. The error code names the GATE, not one
 * finding; the message says which and whether a retry can help.
 *
 * Admission is not a promise the transaction will land: see the module doc.
 */
export async function assertComputeBudgetSufficientToSign(
  tx: VersionedTransaction,
  connection: Connection,
): Promise<void> {
  // Decided from the bytes alone, before spending an RPC round-trip.
  const declaredLimit = readDeclaredComputeUnitLimit(tx.message);
  // The runtime clamps the REQUESTED limit to the transaction-wide maximum too,
  // not just the default: `requested.min(MAX_COMPUTE_UNIT_LIMIT)`. Confirmed
  // live — a transaction declaring 2,000,000 was granted 1,400,000. Trusting a
  // provider's over-large declaration would compare against a ceiling that does
  // not exist, which is the unsafe direction.
  const effectiveLimit = declaredLimit === undefined
    ? inferDefaultComputeUnitBudget(tx.message)
    : Math.min(declaredLimit, SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION);
  // Never say "declares" about a budget we inferred — the agent acts on this text.
  const budget = declaredLimit === undefined
    ? `is granted ${effectiveLimit} CU by default (it declares no compute-unit limit)`
    : `declares ${effectiveLimit} CU`;

  let simulated: SimulatedTransactionResponse;
  try {
    // `sigVerify:false` because we simulate BEFORE signing — our slot is still
    // zero. PROBE B (2026-07-25) is why the co-signed prediction contract is
    // covered too: a 2-required-signer v0 transaction with BOTH slots zeroed
    // simulated fine under `sigVerify:false`, returning a genuine runtime
    // outcome rather than a signature rejection.
    //
    // `replaceRecentBlockhash:true` so a provider blockhash that has aged out
    // of the node's queue cannot produce a false `BlockhashNotFound` refusal.
    // It is applied to the NODE'S COPY only — our transaction object and its
    // verified blockhash are untouched, so provider co-signatures stay valid.
    const response = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    simulated = response.value;
  } catch (err) {
    throw refuse(
      "the pre-sign compute-budget simulation could not be completed "
        + `(transport failure: ${boundedChainText(err instanceof Error ? err.message : String(err))}). `
        + "Nothing was signed and nothing was spent; this says nothing about the trade itself, so a retry may succeed.",
      err,
    );
  }

  if (simulated.err !== null && simulated.err !== undefined) {
    const logLine = simulationFailureLine(simulated.logs ?? undefined);
    throw refuse(
      `the pre-sign simulation failed on-chain — ${summarizeSolanaOnChainError(simulated.err)}`
        + `${logLine ? ` (${logLine})` : ""}. Nothing was signed and nothing was spent. If this is compute `
        + "starvation, a FRESH quote genuinely may fit because the route changes between quotes; a failure "
        + "that is not compute-related will not be fixed by retrying the same request.",
    );
  }

  if (typeof simulated.unitsConsumed !== "number" || !Number.isFinite(simulated.unitsConsumed)) {
    throw refuse(
      `the pre-sign simulation succeeded but reported no unitsConsumed, so the fact that the transaction `
        + `${budget} could not be checked against anything. Nothing was signed; a retry against an RPC that `
        + "reports compute consumption may succeed.",
    );
  }

  const required = Math.ceil((simulated.unitsConsumed * SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT) / 100);
  if (required > effectiveLimit) {
    throw refuse(
      `the pre-sign simulation consumed ${simulated.unitsConsumed} compute units, which needs ${required} CU `
        + `at the ${SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT}% safety margin, but the transaction ${budget}. `
        + "Signing it would risk paying the network fee for a transaction that runs "
        + "out of compute mid-route. Nothing was signed; a fresh quote genuinely may fit, because the route "
        + "changes between quotes.",
    );
  }
}

function refuse(detail: string, cause?: unknown): VexError {
  const refusal = new VexError(ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT, `Refusing to sign: ${detail}`);
  if (cause !== undefined) refusal.cause = cause;
  return refusal;
}

/** SIMD-0170 `MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT` — what a builtin instruction is granted by default. */
const SOLANA_DEFAULT_COMPUTE_UNITS_PER_BUILTIN_INSTRUCTION = 3_000;
/** `DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT` — what everything else is granted by default. */
const SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;

/**
 * The programs Agave still treats as BUILTIN for default-budget purposes, as of
 * `solana-core` 4.1.0. Everything else costs `200_000`.
 *
 * Six come from `@solana/web3.js` so they cannot be mistyped. The two loaders
 * it does not export are string literals, guarded by a test that constructs
 * every entry through `new PublicKey` — a wrong-length key throws there rather
 * than silently misclassifying a program at runtime.
 *
 * DELIBERATELY NOT HERE (they cost 200,000 each): Vote — evicted by SIMD-0387
 * at epoch 999 — plus Stake, Config and Address Lookup Table, which completed
 * their core-BPF migration, and SPL Token, SPL Associated Token Account and
 * Secp256r1, which were never builtin. The widely-cited "12 builtin programs"
 * list from the 2024 SIMD-0170 document is STALE; do not restore it.
 *
 * WHY A HARD-CODED LIST IS ACCEPTABLE. The gate is only safe if
 * `estimatedBudget ≤ actualBudget` — underestimating merely makes it stricter.
 * Solana's core-BPF migration runs ONE WAY: programs leave the builtin table,
 * they do not join it (Vote, Stake, Config and ALT all left). A program leaving
 * while still listed here means we credit it 3,000 where the runtime grants
 * 200,000 — an UNDER-estimate, the safe direction. The unsafe direction
 * requires a program JOINING the table, which is not how the migration runs.
 * If this is ever revisited, re-verify against `builtins-default-costs/src/lib.rs`
 * at whatever Agave version mainnet is running.
 */
const SOLANA_BUILTIN_PROGRAM_IDS: ReadonlySet<string> = new Set([
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
 * The budget Solana's runtime grants a transaction that declares no
 * `SetComputeUnitLimit` of its own:
 *
 *     min(builtin × 3_000 + nonBuiltin × 200_000, 1_400_000)
 *
 * SOURCE: `anza-xyz/agave` v4.1.0,
 * `compute-budget-instruction/src/compute_budget_instruction_details.rs`
 * `calculate_default_compute_unit_limit`, with the two constants from
 * `program-runtime/src/execution_budget.rs`. SIMD-0170 activated at epoch 758;
 * mainnet-beta is at epoch 1007 on `solana-core` 4.1.0, so the LEGACY rule
 * (`instructionCount × 200_000`) is dead — do not restore it, it over-states
 * the ceiling by up to 66x for builtin-heavy transactions, which is exactly the
 * direction that admits a transaction the runtime will starve.
 *
 * SURPRISE WORTH KEEPING: ComputeBudget instructions COUNT here, as builtins
 * (+3,000 each). SIMD-0170's PROSE says "excluding compute budget instructions"
 * — that sentence describes a different counter, and the shipped code plus its
 * own unit test are authoritative. A future reader will want to "fix" this
 * back; do not.
 *
 * This is deliberately the ONLY place the default-budget rule lives, so a
 * future feature-gate change is a one-function edit. The declared-limit path
 * does not depend on it.
 */
function inferDefaultComputeUnitBudget(message: VersionedMessage): number {
  const accountKeys = message.staticAccountKeys;
  let budget = 0;
  for (const compiled of message.compiledInstructions) {
    const programId = accountKeys[compiled.programIdIndex];
    // An unresolvable program index means the instruction runs against an
    // address-table entry we did not load. Charging it the BUILTIN rate is the
    // conservative read: it yields a SMALLER budget, so the gate gets stricter.
    const isBuiltin = programId !== undefined && SOLANA_BUILTIN_PROGRAM_IDS.has(programId.toBase58());
    budget += isBuiltin
      ? SOLANA_DEFAULT_COMPUTE_UNITS_PER_BUILTIN_INSTRUCTION
      : SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION;
  }
  return Math.min(budget, SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION);
}

/**
 * The transaction's OWN declared compute-unit limit, decoded from its bytes —
 * never read off a provider field. Both `Message` (legacy) and `MessageV0`
 * expose `compiledInstructions` and `staticAccountKeys`, so the
 * `VersionedMessage` union is walked uniformly.
 *
 * REFUSES on a second `SetComputeUnitLimit` (or a second `SetComputeUnitPrice`)
 * rather than taking the first or the last. Solana's own
 * `process_compute_budget_instructions` answers a duplicate with
 * `TransactionError::DuplicateInstruction` and rejects the transaction, so
 * refusing matches the runtime instead of merely being cautious — and it keeps
 * "the transaction's declared limit", this gate's core input, unambiguous.
 *
 * An UNDECODABLE ComputeBudget instruction (a future variant, the deprecated
 * `RequestUnits` form) is skipped rather than refused. That is deliberate: the
 * simulation still runs under the transaction's REAL budget, so a mis-read
 * directive can only affect the extra margin check — it can never disable the
 * primary evidence, which is the simulation's own error. Refusing on every
 * unrecognized variant would instead break the moment Solana adds one.
 */
function readDeclaredComputeUnitLimit(message: VersionedMessage): number | undefined {
  const accountKeys = message.staticAccountKeys;
  let declaredLimit: number | undefined;
  let sawPrice = false;

  for (const compiled of message.compiledInstructions) {
    const programId = accountKeys[compiled.programIdIndex];
    if (!programId || !programId.equals(ComputeBudgetProgram.programId)) continue;
    const instruction = new TransactionInstruction({
      programId,
      keys: [], // ComputeBudget instructions take no accounts.
      data: Buffer.from(compiled.data),
    });

    let kind: ReturnType<typeof ComputeBudgetInstruction.decodeInstructionType>;
    try {
      kind = ComputeBudgetInstruction.decodeInstructionType(instruction);
    } catch {
      continue;
    }

    if (kind === "SetComputeUnitLimit") {
      if (declaredLimit !== undefined) throw refuseDuplicate("SetComputeUnitLimit");
      try {
        declaredLimit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
      } catch {
        continue;
      }
    } else if (kind === "SetComputeUnitPrice") {
      if (sawPrice) throw refuseDuplicate("SetComputeUnitPrice");
      sawPrice = true;
    }
  }
  return declaredLimit;
}

function refuseDuplicate(directive: "SetComputeUnitLimit" | "SetComputeUnitPrice"): VexError {
  return refuse(
    `the transaction carries two conflicting ${directive} directives. Solana's runtime rejects a duplicate `
      + "compute-budget instruction outright (TransactionError::DuplicateInstruction), so this transaction "
      + "could never land, and which limit applies is ambiguous. Nothing was signed and nothing was spent.",
  );
}

/**
 * The single most explanatory line of a failed simulation.
 *
 * A program-authored `Error Message:` sentence wins — that is the program
 * telling us why, and `extractProgramErrorMessage` is the module that already
 * owns reading it. Otherwise the runtime's own last `Program … failed:` line,
 * which at least names the failing program; otherwise the last line there is.
 * Private to this module: it is the only consumer.
 */
function simulationFailureLine(logs: readonly string[] | undefined): string | undefined {
  const programAuthored = extractProgramErrorMessage(logs);
  if (programAuthored) return boundedChainText(programAuthored);
  if (!logs || logs.length === 0) return undefined;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = logs[i];
    if (line && PROGRAM_FAILED_LINE.test(line)) return boundedChainText(line);
  }
  const last = logs[logs.length - 1];
  return last ? boundedChainText(last) : undefined;
}

/**
 * Program logs and RPC transport messages are chain/provider-controlled and
 * unbounded. They end up in an agent-facing error message, so they get the same
 * budget the sibling on-chain-error serializer uses.
 */
function boundedChainText(text: string): string {
  return text.length <= MAX_SOLANA_ONCHAIN_ERROR_CHARS
    ? text
    : `${text.slice(0, MAX_SOLANA_ONCHAIN_ERROR_CHARS - 1)}…`;
}
