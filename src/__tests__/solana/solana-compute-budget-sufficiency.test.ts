/**
 * `assertComputeBudgetSufficientToSign` — the pre-sign compute-budget gate.
 *
 * WHY IT EXISTS (live, 2026-07-25). `solana.swap.execute` JupUSD→USDC signed a
 * Jupiter `/build` transaction declaring 606,000 CU. On-chain it consumed all
 * 606,000 and died `{"InstructionError":[3,"ProgramFailedToComplete"]}`,
 * burning 15,023 lamports of network fee for nothing. Nothing checked
 * sufficiency before signing, and the provider's declared limit was taken as
 * fact. PROBE A then re-simulated a Jupiter swap with its `SetComputeUnitLimit`
 * rewritten down, using `sigVerify:false, replaceRecentBlockhash:true`, and
 * reproduced that failure's exact shape — so the gate would have refused the
 * live transaction, and the evidence was free all along.
 *
 * This is an ADMISSION GATE, not a guarantee. Simulation runs against a node's
 * current bank with the blockhash replaced on its copy; execution happens at a
 * later slot against different account state. Nothing here — and nothing in the
 * refusal text — may imply that an admitted transaction is certain to land.
 *
 * Everything here runs against a fake `Connection` and locally built
 * `VersionedTransaction`s. No network, no signing, no funds.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BPF_LOADER_DEPRECATED_PROGRAM_ID,
  BPF_LOADER_PROGRAM_ID,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  Secp256k1Program,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, SimulatedTransactionResponse } from "@solana/web3.js";

import {
  assertComputeBudgetSufficientToSign,
  SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT,
  SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION,
} from "@tools/solana-ecosystem/shared/solana-transaction/compute-budget-sufficiency.js";
import { ErrorCodes } from "../../errors.js";

const PAYER = Keypair.generate();
const DESTINATION = new PublicKey("11111111111111111111111111111112");
const BLOCKHASH = PublicKey.default.toBase58();
/** A real NON-builtin (BPF) program, so the builtin-vs-not split is exercised against something realistic. */
const JUPITER_AGGREGATOR = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/** `transfers` controls the NON-ComputeBudget instruction count, which is what any default-allocation rule keys off. */
function buildTx(
  options: {
    readonly computeUnitLimits?: readonly number[];
    readonly computeUnitPrices?: readonly number[];
    readonly transfers?: number;
    readonly bpfInstructions?: number;
  } = {},
) {
  const instructions = [];
  for (const units of options.computeUnitLimits ?? []) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  }
  for (const microLamports of options.computeUnitPrices ?? []) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  for (let i = 0; i < (options.transfers ?? 1); i += 1) {
    instructions.push(SystemProgram.transfer({ fromPubkey: PAYER.publicKey, toPubkey: DESTINATION, lamports: 1 + i }));
  }
  for (let i = 0; i < (options.bpfInstructions ?? 0); i += 1) {
    // A NON-builtin (BPF) program — 200,000 CU under SIMD-0170, against 3,000 for a builtin.
    instructions.push(new TransactionInstruction({ programId: JUPITER_AGGREGATOR, keys: [], data: Buffer.alloc(0) }));
  }
  const message = new TransactionMessage({
    payerKey: PAYER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function simulatingConnection(value: Partial<SimulatedTransactionResponse>) {
  const simulateTransaction = vi.fn(async () => ({
    context: { slot: 1 },
    value: { err: null, logs: [], ...value } as SimulatedTransactionResponse,
  }));
  return { connection: { simulateTransaction } as unknown as Connection, simulateTransaction };
}

function throwingConnection(err: unknown) {
  const simulateTransaction = vi.fn(async () => {
    throw err;
  });
  return { connection: { simulateTransaction } as unknown as Connection, simulateTransaction };
}

/** The LIVE failure's own logs (execution 209), trimmed to the four program lines. */
const LIVE_STARVATION_LOGS = [
  "Program riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j consumed 500158 of 500158 compute units",
  "Program riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j failed: exceeded CUs meter at BPF instruction",
  "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 consumed 581994 of 581994 compute units",
  "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: Program failed to complete",
];

describe("SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT", () => {
  /**
   * PINNED. 110 is CALIBRATED against 65 mainnet simulations (13 quotes, 4
   * pairs, 2026-07-25): worst same-bytes drift across slots 1.0656x, tightest
   * Jupiter slack 1.1651x. Any change to this number is a money-path decision
   * that must be re-measured, never a tidy-up.
   */
  it("is 110 — the calibrated value, not a round guess", () => {
    expect(SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT).toBe(110);
  });

});

describe("assertComputeBudgetSufficientToSign — simulation contract", () => {
  it("simulates WITHOUT signature verification and with a node-side blockhash replacement (PROBE B / stale-blockhash safety)", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000] });
    const { connection, simulateTransaction } = simulatingConnection({ unitsConsumed: 100_000 });

    await assertComputeBudgetSufficientToSign(tx, connection);

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(simulateTransaction).toHaveBeenCalledWith(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
  });

  it("leaves the caller's transaction untouched — the blockhash replacement is the node's copy only", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 1_000 });

    await assertComputeBudgetSufficientToSign(tx, connection);

    expect(tx.message.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.signatures.every((sig) => sig.every((byte) => byte === 0))).toBe(true);
  });
});

describe("assertComputeBudgetSufficientToSign — refusals", () => {
  it("refuses when the simulation itself failed, quoting BOTH the error and the failing program log line", async () => {
    const tx = buildTx({ computeUnitLimits: [606_000] });
    const { connection } = simulatingConnection({
      err: { InstructionError: [3, "ProgramFailedToComplete"] },
      logs: LIVE_STARVATION_LOGS,
      unitsConsumed: 606_000,
    });

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(
      /\{"InstructionError":\[3,"ProgramFailedToComplete"\]\}/,
    );
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(
      /Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: Program failed to complete/,
    );
  });

  it("prefers a program-authored `Error Message:` line over the runtime's generic failure line", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000] });
    const { connection } = simulatingConnection({
      err: { InstructionError: [0, { Custom: 6003 }] },
      logs: [
        "Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6003. Error Message: Slippage tolerance exceeded.",
        "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1773",
      ],
      unitsConsumed: 50_000,
    });

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(
      /Slippage tolerance exceeded/,
    );
  });

  it("refuses when the simulation could not be performed at all (transport), and says a retry may help", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000] });
    const { connection } = throwingConnection(new Error("fetch failed: ECONNRESET"));

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(/retry/i);
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(/transport/i);
  });

  it("refuses a SUCCESSFUL simulation that reports no unitsConsumed — an RPC that cannot measure cannot admit anything", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000] });
    const { connection } = simulatingConnection({ err: null, logs: [] });

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(/unitsConsumed/);
  });

  it("refuses when consumption plus the margin exceeds the declared limit, naming consumed, limit, required and the margin", async () => {
    const tx = buildTx({ computeUnitLimits: [606_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 600_000 });

    // 600,000 x 110% = 660,000 > 606,000 declared.
    const rejection = assertComputeBudgetSufficientToSign(tx, connection);
    await expect(rejection).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT });
    const message = await assertComputeBudgetSufficientToSign(tx, connection).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(message).toContain("600000");
    expect(message).toContain("660000");
    expect(message).toContain("606000");
    expect(message).toContain("110%");
    // Jupiter re-routes between quotes, so this is retry-with-a-fresh-quote, not terminal.
    expect(message).toMatch(/fresh quote/i);
  });
});

describe("assertComputeBudgetSufficientToSign — the margin boundary", () => {
  it("passes EXACTLY at the margin", async () => {
    const tx = buildTx({ computeUnitLimits: [110_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 100_000 });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).resolves.toBeUndefined();
  });

  it("refuses ONE compute unit over the margin", async () => {
    const tx = buildTx({ computeUnitLimits: [110_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 100_001 });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
  });

  it("resolves for a comfortably-provisioned transaction", async () => {
    const tx = buildTx({ computeUnitLimits: [606_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 45_665 });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).resolves.toBeUndefined();
  });
});

describe("assertComputeBudgetSufficientToSign — conflicting compute-budget directives", () => {
  /**
   * Solana's `process_compute_budget_instructions` returns
   * `TransactionError::DuplicateInstruction` when a SECOND
   * `SetComputeUnitLimit` appears — such a transaction is rejected outright, so
   * refusing is not merely the conservative reading, it matches the runtime.
   * Silently taking the first or the last would also make "the transaction's
   * declared limit" — this gate's core input — ambiguous.
   */
  it("REFUSES a transaction carrying two SetComputeUnitLimit directives", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000, 400_000] });
    const { connection, simulateTransaction } = simulatingConnection({ unitsConsumed: 1_000 });

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(/duplicate/i);
    // Decided from the bytes alone — no point spending an RPC round-trip on a
    // transaction the runtime will reject.
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("REFUSES a transaction carrying two SetComputeUnitPrice directives (the runtime rejects it identically)", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000], computeUnitPrices: [1_000, 2_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 1_000 });

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toThrow(/duplicate/i);
  });

  it("accepts the NORMAL shape: one limit, one price", async () => {
    const tx = buildTx({ computeUnitLimits: [200_000], computeUnitPrices: [1_000] });
    const { connection } = simulatingConnection({ unitsConsumed: 100_000 });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).resolves.toBeUndefined();
  });
});

describe("assertComputeBudgetSufficientToSign — the declared limit is read from the bytes", () => {
  it("reads the transaction's OWN declared limit, never a provider field", async () => {
    const tx = buildTx({ computeUnitLimits: [120_000], transfers: 1 });
    expect(tx.message.compiledInstructions).toHaveLength(2);

    const { connection } = simulatingConnection({ unitsConsumed: 150_000 });
    const message = await assertComputeBudgetSufficientToSign(tx, connection).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(message).toContain("120000");
    expect(message).toContain("165000"); // 150,000 x 110%
  });
});

/**
 * DEFAULT BUDGET when the transaction declares no `SetComputeUnitLimit`.
 *
 * SIMD-0170 is ACTIVE on mainnet (activated epoch 758; mainnet-beta is at epoch
 * 1007 on solana-core 4.1.0), so the rule is
 * `min(builtin × 3_000 + nonBuiltin × 200_000, 1_400_000)` — NOT the legacy
 * `instructionCount × 200_000`. These tests discriminate the correct
 * arithmetic from both wrong ones rather than restating the formula.
 */
describe("assertComputeBudgetSufficientToSign — the default budget (SIMD-0170)", () => {
  /**
   * ONE transaction that separates all three candidate arithmetics:
   *   SetComputeUnitPrice (ComputeBudget, builtin) + System transfer (builtin)
   *   + one BPF instruction (non-builtin).
   *
   *   all-instructions x 200k ................ 600,000  (original spec, wrong)
   *   non-ComputeBudget x 200k ............... 400,000  (legacy fix, wrong)
   *   2 x 3,000 + 1 x 200,000 ................ 206,000  (SIMD-0170, correct)
   *
   * 200,000 consumed needs 220,000 with the margin: it must REFUSE, and it
   * would have been ADMITTED under either wrong rule.
   */
  it("REFUSES a transaction the legacy arithmetic would have admitted (builtins are 3,000 CU, not 200,000)", async () => {
    const tx = buildTx({ computeUnitPrices: [1_000], transfers: 1, bpfInstructions: 1 });
    expect(tx.message.compiledInstructions).toHaveLength(3);

    const { connection } = simulatingConnection({ unitsConsumed: 200_000 });
    const message = await assertComputeBudgetSufficientToSign(tx, connection).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(message).toContain("206000"); // 2 builtins x 3,000 + 1 BPF x 200,000
    expect(message).toContain("220000"); // 200,000 x 110%
  });

  it("admits the same transaction when consumption fits the real 206,000 budget", async () => {
    const tx = buildTx({ computeUnitPrices: [1_000], transfers: 1, bpfInstructions: 1 });
    // 187,272 x 110% = 205,999.2 -> 206,000 required, exactly the budget.
    const { connection } = simulatingConnection({ unitsConsumed: 187_272 });
    await expect(assertComputeBudgetSufficientToSign(tx, connection)).resolves.toBeUndefined();
  });

  it("counts EVERY non-builtin instruction at 200,000", async () => {
    const tx = buildTx({ transfers: 0, bpfInstructions: 2 }); // 2 x 200,000 = 400,000
    const { connection } = simulatingConnection({ unitsConsumed: 363_637 }); // x110% = 400,001
    const message = await assertComputeBudgetSufficientToSign(tx, connection).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(message).toContain("400000");

    const under = simulatingConnection({ unitsConsumed: 363_636 }); // x110% = 400,000
    await expect(assertComputeBudgetSufficientToSign(buildTx({ transfers: 0, bpfInstructions: 2 }), under.connection))
      .resolves.toBeUndefined();
  });

  it("caps the inferred default at Solana's 1,400,000 transaction-wide maximum", async () => {
    const tx = buildTx({ transfers: 0, bpfInstructions: 8 }); // 8 x 200,000 = 1,600,000, above the cap
    const { connection } = simulatingConnection({ unitsConsumed: 1_272_728 }); // x110% = 1,400,001
    const message = await assertComputeBudgetSufficientToSign(tx, connection).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(message).toContain("1400000");
    expect(message).not.toContain("1600000");
  });

  /**
   * The builtin set is feature-gate dependent and moved during 2026 (Vote left
   * via SIMD-0387; Stake/Config/ALT completed core-BPF migration). These must
   * be treated as ORDINARY 200,000-CU programs.
   */
  it("treats core-BPF-migrated programs (Stake, ALT, SPL Token, Vote) as NON-builtin", async () => {
    for (const programId of [
      new PublicKey("Stake11111111111111111111111111111111111111"),
      new PublicKey("AddressLookupTab1e1111111111111111111111111"),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      new PublicKey("Vote111111111111111111111111111111111111111"),
    ]) {
      const message = new TransactionMessage({
        payerKey: PAYER.publicKey,
        recentBlockhash: BLOCKHASH,
        instructions: [new TransactionInstruction({ programId, keys: [], data: Buffer.alloc(0) })],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);

      // A single non-builtin instruction => 200,000. 181,818 x 110% = 200,000.
      const { connection } = simulatingConnection({ unitsConsumed: 181_818 });
      await expect(assertComputeBudgetSufficientToSign(tx, connection)).resolves.toBeUndefined();
    }
  });

  /**
   * Guards the two program ids web3.js does NOT export, which therefore have to
   * be string literals in the module. `new PublicKey` throws on a wrong-length
   * key, so a typo fails HERE rather than silently misclassifying a program at
   * runtime.
   */
  it("every builtin program id is a well-formed 32-byte key", () => {
    const builtins = [
      SystemProgram.programId,
      ComputeBudgetProgram.programId,
      BPF_LOADER_PROGRAM_ID,
      BPF_LOADER_DEPRECATED_PROGRAM_ID,
      Ed25519Program.programId,
      Secp256k1Program.programId,
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
      new PublicKey("LoaderV411111111111111111111111111111111111"),
    ];
    expect(builtins).toHaveLength(8);
    for (const programId of builtins) {
      expect(programId.toBytes()).toHaveLength(32);
    }
    expect(new Set(builtins.map((key) => key.toBase58())).size).toBe(8);
  });
});

/**
 * The runtime clamps the REQUESTED limit to `MAX_COMPUTE_UNIT_LIMIT` too, not
 * just the default: `requested.min(MAX_COMPUTE_UNIT_LIMIT)`. Confirmed live — a
 * transaction declaring 2,000,000 was granted 1,400,000. Comparing against a
 * ceiling the runtime will not honour is the unsafe direction.
 */
describe("assertComputeBudgetSufficientToSign — a declared limit above the cap is clamped", () => {
  it("REFUSES against 1,400,000 even though the transaction declares 2,000,000", async () => {
    const tx = buildTx({ computeUnitLimits: [2_000_000] });
    // 1,300,000 x 110% = 1,430,000: fits the declared 2,000,000, exceeds the real 1,400,000.
    const { connection } = simulatingConnection({ unitsConsumed: 1_300_000 });

    await expect(assertComputeBudgetSufficientToSign(tx, connection)).rejects.toMatchObject({
      code: ErrorCodes.SOLANA_TX_COMPUTE_BUDGET_INSUFFICIENT,
    });
    const message = await assertComputeBudgetSufficientToSign(tx, connection).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(message).toContain("1400000");
    expect(message).not.toContain("2000000");
  });

  it("still exposes Solana's transaction-wide maximum, which the /build fee-ceiling guard re-exports", () => {
    expect(SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION).toBe(1_400_000);
  });
});
