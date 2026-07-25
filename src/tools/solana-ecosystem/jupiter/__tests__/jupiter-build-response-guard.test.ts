/**
 * `build-response-guard.ts` unit tests (Codex batch-4 closure blocker C2:
 * "we validate request identity but sign whatever Jupiter returned"). Each
 * check is exercised directly against hand-crafted wire instructions —
 * `jupiter-fee-swap.test.ts` additionally covers the same hostile scenarios
 * end to end through `prepareFeeBearingJupiterSwap`.
 */

import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

const {
  assertBuildResponseMatchesRequest,
  assertComputeBudgetWithinPolicy,
  assertFeeAccountPresentInSwapInstruction,
  assertTipInstructionWithinPolicy,
  signedTransactionProgramIds,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/build-response-guard.js");
const { assembleFeeBearingSwapTransaction } = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/build-assembly.js");
const { JUPITER_TIP_RECEIVER_ADDRESSES } = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js");
const { summarizeProtocolError } = await import("@vex-agent/tools/protocols/runtime/errors.js");
const { VexError } = await import("../../../../errors.js");

const PAYER = Keypair.generate().publicKey;
// A REAL published Jupiter tip-receiver address (see constants.ts) — the
// happy-path recipient for every pre-existing tip test. `assertTip
// InstructionWithinPolicy` now checks the recipient, not just the amount.
const TIP_RECIPIENT = new PublicKey(JUPITER_TIP_RECEIVER_ADDRESSES[0]);
const FEE_ACCOUNT = Keypair.generate().publicKey.toBase58();

function wireIx(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isWritable: k.isWritable, isSigner: k.isSigner })),
    data: ix.data.toString("base64"),
  };
}

function tipIx(lamports: number, recipient: PublicKey = TIP_RECIPIENT) {
  return wireIx(SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: recipient, lamports }));
}

describe("assertBuildResponseMatchesRequest — request-identity echo", () => {
  const request = { inputMint: "MintIn", outputMint: "MintOut", amountRaw: "1000000" };

  it("passes when the response echoes the request exactly", () => {
    expect(() =>
      assertBuildResponseMatchesRequest({ inputMint: "MintIn", outputMint: "MintOut", inAmount: "1000000" }, request),
    ).not.toThrow();
  });

  it("refuses an altered inputMint", () => {
    expect(() =>
      assertBuildResponseMatchesRequest({ inputMint: "AttackerMint", outputMint: "MintOut", inAmount: "1000000" }, request),
    ).toThrow(VexError);
  });

  it("refuses an altered outputMint", () => {
    expect(() =>
      assertBuildResponseMatchesRequest({ inputMint: "MintIn", outputMint: "AttackerMint", inAmount: "1000000" }, request),
    ).toThrow(VexError);
  });

  it("refuses an altered inAmount (atomic-unit bigint compare, not string/lexicographic)", () => {
    expect(() =>
      assertBuildResponseMatchesRequest({ inputMint: "MintIn", outputMint: "MintOut", inAmount: "999999" }, request),
    ).toThrow(VexError);
    // A leading-zero-padded but numerically-equal string must NOT be flagged
    // (bigint compare, never lexicographic).
    expect(() =>
      assertBuildResponseMatchesRequest({ inputMint: "MintIn", outputMint: "MintOut", inAmount: "01000000" }, request),
    ).not.toThrow();
  });

  it("refuses a non-numeric inAmount", () => {
    expect(() =>
      assertBuildResponseMatchesRequest({ inputMint: "MintIn", outputMint: "MintOut", inAmount: "1e6" }, request),
    ).toThrow(VexError);
  });
});

describe("assertTipInstructionWithinPolicy", () => {
  it("passes when the tip instruction transfers exactly the approved amount", () => {
    expect(() => assertTipInstructionWithinPolicy(tipIx(1_000_000), 1_000_000)).not.toThrow();
  });

  it("refuses an oversized tip instruction (lamports above the approved amount)", () => {
    expect(() => assertTipInstructionWithinPolicy(tipIx(50_000_000), 1_000_000)).toThrow(VexError);
  });

  it("refuses an undersized tip instruction (lamports below the approved amount, not just above)", () => {
    expect(() => assertTipInstructionWithinPolicy(tipIx(1), 1_000_000)).toThrow(VexError);
  });

  it("refuses a MISSING tip instruction when a nonzero tip was approved", () => {
    expect(() => assertTipInstructionWithinPolicy(null, 1_000_000)).toThrow(VexError);
    expect(() => assertTipInstructionWithinPolicy(undefined, 1_000_000)).toThrow(VexError);
  });

  it("accepts a missing tip instruction when no tip was approved (tipLamports: 0)", () => {
    expect(() => assertTipInstructionWithinPolicy(null, 0)).not.toThrow();
  });

  it("refuses a tip instruction that is not a real System Program transfer (wrong program)", () => {
    const fakeTip = wireIx(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
    );
    expect(() => assertTipInstructionWithinPolicy(fakeTip, 1)).toThrow(VexError);
  });

  it("belt-and-suspenders: refuses a tip above the owner cap even if it happened to equal a (hypothetical) larger approved value", () => {
    // The public knob API cannot itself produce an approvedTipLamports above
    // the 0.01 SOL cap (resolveJupiterFeeSwapKnobs rejects it outright), so
    // this exercises the cap check as an independent defense-in-depth layer.
    expect(() => assertTipInstructionWithinPolicy(tipIx(20_000_000), 20_000_000)).toThrow(VexError);
  });

  // (C6) Recipient allowlist — a hostile response could keep the amount
  // correct while redirecting the tip to an attacker-controlled address.
  it("refuses a tip instruction paid to an address that is not a published Jupiter tip receiver", () => {
    const attacker = Keypair.generate().publicKey;
    expect(() => assertTipInstructionWithinPolicy(tipIx(1_000_000, attacker), 1_000_000)).toThrow(VexError);
  });

  it("passes when the tip recipient is any of Jupiter's published tip-receiver accounts", () => {
    for (const address of JUPITER_TIP_RECEIVER_ADDRESSES) {
      expect(() => assertTipInstructionWithinPolicy(tipIx(1_000_000, new PublicKey(address)), 1_000_000)).not.toThrow();
    }
  });
});

describe("assertFeeAccountPresentInSwapInstruction", () => {
  it("passes when the fee account is present, writable, and not a signer", () => {
    const swapInstruction = { accounts: [{ pubkey: FEE_ACCOUNT, isWritable: true, isSigner: false }] };
    expect(() => assertFeeAccountPresentInSwapInstruction(swapInstruction, FEE_ACCOUNT)).not.toThrow();
  });

  it("refuses when the fee account is missing entirely", () => {
    const swapInstruction = { accounts: [{ pubkey: Keypair.generate().publicKey.toBase58(), isWritable: true, isSigner: false }] };
    expect(() => assertFeeAccountPresentInSwapInstruction(swapInstruction, FEE_ACCOUNT)).toThrow(VexError);
  });

  it("refuses when a DIFFERENT (decoy) account replaces the real fee account", () => {
    const decoy = Keypair.generate().publicKey.toBase58();
    const swapInstruction = { accounts: [{ pubkey: decoy, isWritable: true, isSigner: false }] };
    expect(() => assertFeeAccountPresentInSwapInstruction(swapInstruction, FEE_ACCOUNT)).toThrow(VexError);
  });

  it("refuses when the fee account is present but not writable", () => {
    const swapInstruction = { accounts: [{ pubkey: FEE_ACCOUNT, isWritable: false, isSigner: false }] };
    expect(() => assertFeeAccountPresentInSwapInstruction(swapInstruction, FEE_ACCOUNT)).toThrow(VexError);
  });

  it("refuses when the fee account is present but marked as a signer", () => {
    const swapInstruction = { accounts: [{ pubkey: FEE_ACCOUNT, isWritable: true, isSigner: true }] };
    expect(() => assertFeeAccountPresentInSwapInstruction(swapInstruction, FEE_ACCOUNT)).toThrow(VexError);
  });
});

describe("assertComputeBudgetWithinPolicy", () => {
  function cuLimitIx(units: number) {
    return wireIx(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  }
  function cuPriceIx(microLamports: number) {
    return wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }

  // Program ids of the instructions that end up in the SIGNED transaction.
  // Real mainnet ids, matching the `/build` shapes probed live 2026-07-25.
  const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
  const SYSTEM_ID = SystemProgram.programId.toBase58();
  const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const SPL_ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  /** The REAL JupUSD->USDC `/build` instruction set: price ix + ATA setup + swap + tip = 3,000+200,000+200,000+3,000 = 406,000 CU. */
  const JUPUSD_USDC_PROGRAM_IDS = [COMPUTE_BUDGET_ID, SPL_ASSOCIATED_TOKEN, JUPITER_V6, SYSTEM_ID];

  it("computes an honest priority-fee estimate within the cap and returns it", () => {
    const result = assertComputeBudgetWithinPolicy([cuLimitIx(200_000), cuPriceIx(1_000)], JUPUSD_USDC_PROGRAM_IDS);
    expect(result.computeUnitLimit).toBe(200_000);
    expect(result.computeUnitPriceMicroLamports).toBe(1_000n);
    // A DECLARED limit is used as-is — the default-budget rule never overrides it.
    expect(result.priorityFeeLamports).toBe(200n); // 200_000 * 1_000 / 1e6 = 200 exactly
    expect(result.priorityFeeIsUpperBound).toBe(false);
  });

  it("returns a zero estimate when no compute-budget instructions are present", () => {
    const result = assertComputeBudgetWithinPolicy([], JUPUSD_USDC_PROGRAM_IDS);
    expect(result.priorityFeeLamports).toBe(0n);
    expect(result.priorityFeeIsUpperBound).toBe(false);
  });

  it("refuses an excessive compute budget (limit × price exceeds the exposure cap)", () => {
    // 1_400_000 units (protocol max) × 10_000_000 microLamports/CU is a wildly
    // inflated price that would exceed the 10_000_000-lamport cap.
    expect(() => assertComputeBudgetWithinPolicy([cuLimitIx(1_400_000), cuPriceIx(10_000_000)], JUPUSD_USDC_PROGRAM_IDS)).toThrow(VexError);
  });

  it("refuses a non-ComputeBudget-program instruction disguised as a compute-budget directive", () => {
    const disguised = wireIx(SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: TIP_RECIPIENT, lamports: 1 }));
    expect(() => assertComputeBudgetWithinPolicy([disguised], JUPUSD_USDC_PROGRAM_IDS)).toThrow(VexError);
  });

  // A price instruction with NO limit instruction is the DOCUMENTED NORMAL
  // `/build` response shape — re-confirmed live 2026-07-25 against
  // `api.jup.ag/swap/v2/build`, which returned exactly one ComputeBudget
  // instruction (`SetComputeUnitPrice`) on all four probed pairs.
  //
  // C6 substituted Solana's 1,400,000-CU transaction maximum here. That is not
  // what the chain grants: SIMD-0170 grants `builtin x 3,000 + other x
  // 200,000` (capped at 1,400,000), which for a real Jupiter build is ~406,000
  // CU — so the estimate overstated exposure ~3.4x and refused a legitimate
  // swap on 2026-07-25.
  describe("price-only compute-budget instructions (the documented normal /build shape — no explicit limit)", () => {
    it("uses the SIMD-0170 default budget as the denominator, not Solana's 1,400,000 maximum", () => {
      const result = assertComputeBudgetWithinPolicy([cuPriceIx(1_000)], JUPUSD_USDC_PROGRAM_IDS);
      expect(result.computeUnitLimit).toBeNull();
      expect(result.computeUnitPriceMicroLamports).toBe(1_000n);
      // 406,000 CU x 1,000 microLamports / 1e6 = 406 lamports.
      // The shipped guard computed 1,400 here — 3.45x too much.
      expect(result.priorityFeeLamports).toBe(406n);
      expect(result.priorityFeeIsUpperBound).toBe(true);
    });

    it("counts every instruction of the signed transaction, not only the compute-budget ones", () => {
      // Same price, the 5-instruction USDC->SOL shape (a cleanup close on top).
      const result = assertComputeBudgetWithinPolicy(
        [cuPriceIx(1_000)],
        [...JUPUSD_USDC_PROGRAM_IDS, SPL_TOKEN],
      );
      expect(result.priorityFeeLamports).toBe(606n);
    });

    it("still refuses a price-only response whose exposure exceeds the cap (C6's regression stays fixed)", () => {
      // 406,000 CU x 24,630,542 microLamports / 1e6 = 10,000,001 lamports — one
      // lamport over the 10,000,000 cap. The pre-C6 guard computed 0n here.
      expect(() => assertComputeBudgetWithinPolicy([cuPriceIx(24_630_542)], JUPUSD_USDC_PROGRAM_IDS)).toThrow(VexError);
      // One microLamport lower lands exactly ON the cap and is admitted.
      expect(assertComputeBudgetWithinPolicy([cuPriceIx(24_630_541)], JUPUSD_USDC_PROGRAM_IDS).priorityFeeLamports).toBe(10_000_000n);
    });

    it("admits the REAL swap refused on 2026-07-25 (13,766,234 lamports at the wrong denominator)", () => {
      // Live refusal that day, verbatim: "estimated priority fee (13766234
      // lamports, upper bound — no explicit compute-unit limit in the
      // response) exceeds the approved exposure cap of 10000000 lamports."
      // 13,766,234 = ceil(1,400,000 x 9,833,024 / 1e6) — the substituted
      // denominator, not the granted one.
      const price = 9_833_024;
      expect((1_400_000n * BigInt(price) + 999_999n) / 1_000_000n).toBe(13_766_234n);
      const result = assertComputeBudgetWithinPolicy([cuPriceIx(price)], JUPUSD_USDC_PROGRAM_IDS);
      // At the budget the chain actually grants: 406,000 x 9,833,024 / 1e6.
      expect(result.priorityFeeLamports).toBe(3_992_208n);
      expect(result.priorityFeeLamports).toBeLessThan(10_000_000n);
    });

    it("falls back to the 1,400,000 substitution when a deprecated RequestUnits directive makes the granted budget unknowable", () => {
      // `RequestUnits` also sets a limit. Inferring the DEFAULT budget while
      // the response declares one another way would understate the fee, which
      // is the direction a hostile response would want. Fail conservative.
      const requestUnits = wireIx(
        new TransactionInstruction({
          programId: ComputeBudgetProgram.programId,
          keys: [],
          // Deprecated variant 0: u32 units + u32 additionalFee.
          data: Buffer.concat([Buffer.from([0]), Buffer.alloc(8)]),
        }),
      );
      const result = assertComputeBudgetWithinPolicy([requestUnits, cuPriceIx(1_000)], JUPUSD_USDC_PROGRAM_IDS);
      expect(result.priorityFeeLamports).toBe(1_400n);
      expect(result.priorityFeeIsUpperBound).toBe(true);
    });
  });

  describe("the refusal is actionable for an unattended agent", () => {
    function refusalFor(microLamports: number): string {
      try {
        assertComputeBudgetWithinPolicy([cuPriceIx(microLamports)], JUPUSD_USDC_PROGRAM_IDS);
      } catch (err) {
        return summarizeProtocolError(err).message;
      }
      throw new Error("expected a refusal");
    }

    it("names computeUnitPricePercentile — the agent-settable lever — inside the 200-char budget", () => {
      const surfaced = refusalFor(50_000_000);
      expect(surfaced.length).toBeLessThanOrEqual(201); // 200 + the truncation ellipsis
      expect(surfaced).toContain("computeUnitPricePercentile");
    });

    it("says a re-quote may succeed, because priority fees swing by the minute", () => {
      const surfaced = refusalFor(50_000_000);
      expect(surfaced).toContain("re-quote");
      expect(surfaced).toContain("swing");
    });

    it("states the fee, the cap, and that nothing was signed or spent", () => {
      const surfaced = refusalFor(50_000_000);
      // 406,000 x 50,000,000 / 1e6 = 20,300,000 lamports.
      expect(surfaced).toContain("20300000");
      expect(surfaced).toContain("10000000");
      expect(surfaced).toContain("Nothing signed or spent");
    });
  });
});

describe("signedTransactionProgramIds", () => {
  const cuPrice = wireIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  const swapIx = {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    accounts: [{ pubkey: FEE_ACCOUNT, isWritable: true, isSigner: false }],
    data: "",
  };
  const cleanupIx = wireIx(
    new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [], data: Buffer.from([9]) }),
  );
  const build = {
    inputMint: "MintIn",
    outputMint: "MintOut",
    inAmount: "1000000",
    outAmount: "2000000",
    otherAmountThreshold: "1900000",
    routePlan: [],
    computeBudgetInstructions: [cuPrice],
    setupInstructions: [],
    swapInstruction: swapIx,
    cleanupInstruction: cleanupIx,
    otherInstructions: [],
    tipInstruction: tipIx(1_000_000),
    blockhashWithMetadata: { blockhash: Array(32).fill(1) as number[], lastValidBlockHeight: 999 },
  };

  // The guard bounds the fee of the transaction `build-assembly.ts` will
  // actually sign. If the two ever enumerate different instruction sets, the
  // bound is computed against a transaction that does not exist — so the
  // parity is pinned here rather than left to a comment.
  it("enumerates exactly the instructions assembleFeeBearingSwapTransaction signs", () => {
    const spliced = SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: TIP_RECIPIENT, lamports: 5 });
    const assembled = assembleFeeBearingSwapTransaction(build, [spliced], PAYER);
    const guarded = signedTransactionProgramIds(build, [spliced.programId.toBase58()]);
    expect(guarded).toHaveLength(assembled.message.compiledInstructions.length);
    const assembledIds = assembled.message.compiledInstructions.map(
      (ix) => assembled.message.staticAccountKeys[ix.programIdIndex]!.toBase58(),
    );
    expect([...guarded].sort()).toEqual([...assembledIds].sort());
  });

  it("includes the caller-spliced pre-swap instructions (the treasury fee-ATA create)", () => {
    const withoutSplice = signedTransactionProgramIds(build, []);
    const withSplice = signedTransactionProgramIds(build, ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"]);
    expect(withSplice).toHaveLength(withoutSplice.length + 1);
    expect(withSplice).toContain("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });
});
