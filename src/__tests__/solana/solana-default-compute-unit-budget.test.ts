/**
 * `shared/solana-transaction/default-compute-unit-budget.ts` — the SIMD-0170
 * default-budget rule.
 *
 * The rule decides the DENOMINATOR of every priority-fee estimate Vex computes
 * for a transaction that declares no `SetComputeUnitLimit`, and a wrong
 * denominator refused a real, legitimate swap on 2026-07-25. So the arithmetic
 * is pinned here directly, per instruction class, rather than only through the
 * venue guard that consumes it.
 *
 * Every builtin program id is constructed through `new PublicKey` so a
 * mistyped literal in the module's hard-coded set fails HERE (wrong-length
 * base58 throws) instead of silently misclassifying a program at runtime and
 * under-crediting it 3,000 CU where the chain grants 200,000.
 */

import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  SOLANA_BUILTIN_PROGRAM_IDS,
  SOLANA_DEFAULT_COMPUTE_UNITS_PER_BUILTIN_INSTRUCTION,
  SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION,
  inferDefaultComputeUnitBudget,
} from "@tools/solana-ecosystem/shared/solana-transaction/default-compute-unit-budget.js";
import { SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION } from "@tools/solana-ecosystem/shared/solana-transaction/constants.js";

// Real mainnet program ids, so the classification is exercised against what a
// Jupiter `/build` response actually contains (probed live 2026-07-25 — see
// the module doc's instruction-shape table).
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const SYSTEM = SystemProgram.programId.toBase58();

describe("SOLANA_BUILTIN_PROGRAM_IDS", () => {
  it("every entry is a real, well-formed base58 program id", () => {
    for (const id of SOLANA_BUILTIN_PROGRAM_IDS) {
      expect(() => new PublicKey(id)).not.toThrow();
      expect(new PublicKey(id).toBase58()).toBe(id);
    }
  });

  it("contains ComputeBudget — a price-only instruction costs 3,000, not 200,000", () => {
    expect(SOLANA_BUILTIN_PROGRAM_IDS.has(COMPUTE_BUDGET)).toBe(true);
    expect(inferDefaultComputeUnitBudget([COMPUTE_BUDGET])).toBe(
      SOLANA_DEFAULT_COMPUTE_UNITS_PER_BUILTIN_INSTRUCTION,
    );
  });

  it("does NOT contain the programs the stale 2024 SIMD-0170 list names — they left the builtin set or were never in it", () => {
    // Vote left via SIMD-0387; Stake, Config and Address Lookup Table
    // completed core-BPF migration; SPL Token / Associated Token were never
    // builtin. Restoring any of them would credit 3,000 where the runtime
    // grants 200,000 — an UNDER-estimate of the fee, which is the unsafe
    // direction for this consumer.
    for (const id of [
      "Vote111111111111111111111111111111111111111",
      "Stake11111111111111111111111111111111111111",
      "Config1111111111111111111111111111111111111",
      "AddressLookupTab1e1111111111111111111111111",
      SPL_TOKEN,
      SPL_ASSOCIATED_TOKEN,
    ]) {
      expect(SOLANA_BUILTIN_PROGRAM_IDS.has(id)).toBe(false);
      expect(inferDefaultComputeUnitBudget([id])).toBe(SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION);
    }
  });
});

describe("inferDefaultComputeUnitBudget", () => {
  it("grants nothing to an empty instruction list", () => {
    expect(inferDefaultComputeUnitBudget([])).toBe(0);
  });

  it("sums builtin x 3,000 + everything else x 200,000", () => {
    // The REAL JupUSD->USDC `/build` shape probed live 2026-07-25: one
    // ComputeBudget price instruction, one associated-token-account setup,
    // the Jupiter swap, and the System-program tip transfer.
    expect(
      inferDefaultComputeUnitBudget([COMPUTE_BUDGET, SPL_ASSOCIATED_TOKEN, JUPITER_V6, SYSTEM]),
    ).toBe(3_000 + 200_000 + 200_000 + 3_000);
    expect(inferDefaultComputeUnitBudget([COMPUTE_BUDGET, SPL_ASSOCIATED_TOKEN, JUPITER_V6, SYSTEM])).toBe(406_000);
  });

  it("matches the real 5-instruction USDC->SOL /build shape (probed live 2026-07-25)", () => {
    expect(
      inferDefaultComputeUnitBudget([COMPUTE_BUDGET, SPL_ASSOCIATED_TOKEN, JUPITER_V6, SYSTEM, SPL_TOKEN]),
    ).toBe(606_000);
  });

  it("clamps at Solana's transaction-wide maximum", () => {
    const sevenNonBuiltins = Array.from({ length: 7 }, () => JUPITER_V6);
    // 7 x 200,000 = 1,400,000 exactly.
    expect(inferDefaultComputeUnitBudget(sevenNonBuiltins)).toBe(SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION);
    // 8 x 200,000 = 1,600,000 — clamped, never returned raw.
    expect(inferDefaultComputeUnitBudget([...sevenNonBuiltins, JUPITER_V6])).toBe(
      SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION,
    );
  });

  it("credits a program id it cannot classify at the NON-builtin rate", () => {
    // Deliberate, and the opposite of what the sufficiency gate this rule was
    // recovered from wanted: this consumer bounds COST, so a LARGER inferred
    // budget yields a LARGER estimated fee and therefore an EARLIER refusal.
    // "not a base58 key at all" is the same branch as "a program we have
    // never heard of" — neither is in the builtin set.
    expect(inferDefaultComputeUnitBudget(["not-a-real-program-id"])).toBe(
      SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION,
    );
    expect(inferDefaultComputeUnitBudget([""])).toBe(SOLANA_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION);
  });

  it("never exceeds the 1,400,000 substitution it replaces, for ANY input", () => {
    // The safety property that makes this change incapable of refusing
    // something the shipped guard admitted: the new denominator is <= the old
    // one everywhere, so the bound can only get tighter.
    for (const count of [0, 1, 3, 5, 12, 40]) {
      const ids = Array.from({ length: count }, (_v, i) => (i % 2 === 0 ? JUPITER_V6 : SYSTEM));
      expect(inferDefaultComputeUnitBudget(ids)).toBeLessThanOrEqual(SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION);
    }
  });
});
