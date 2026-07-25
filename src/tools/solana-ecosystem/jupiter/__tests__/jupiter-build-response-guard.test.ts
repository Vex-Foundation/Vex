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
} = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/build-response-guard.js");
const { JUPITER_TIP_RECEIVER_ADDRESSES } = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js");
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

  it("computes an honest priority-fee estimate within the cap and returns it", () => {
    const result = assertComputeBudgetWithinPolicy([cuLimitIx(200_000), cuPriceIx(1_000)]);
    expect(result.computeUnitLimit).toBe(200_000);
    expect(result.computeUnitPriceMicroLamports).toBe(1_000n);
    expect(result.priorityFeeLamports).toBe(200n); // 200_000 * 1_000 / 1e6 = 200 exactly
    expect(result.priorityFeeIsUpperBound).toBe(false);
  });

  it("returns a zero estimate when no compute-budget instructions are present", () => {
    const result = assertComputeBudgetWithinPolicy([]);
    expect(result.priorityFeeLamports).toBe(0n);
    expect(result.priorityFeeIsUpperBound).toBe(false);
  });

  it("refuses an excessive compute budget (limit × price exceeds the exposure cap)", () => {
    // 1_400_000 units (protocol max) × 10_000_000 microLamports/CU is a wildly
    // inflated price that would exceed the 10_000_000-lamport cap.
    expect(() => assertComputeBudgetWithinPolicy([cuLimitIx(1_400_000), cuPriceIx(10_000_000)])).toThrow(VexError);
  });

  it("refuses a non-ComputeBudget-program instruction disguised as a compute-budget directive", () => {
    const disguised = wireIx(SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: TIP_RECIPIENT, lamports: 1 }));
    expect(() => assertComputeBudgetWithinPolicy([disguised])).toThrow(VexError);
  });

  // (C6) A price instruction with NO limit instruction is the DOCUMENTED
  // NORMAL `/build` response shape ("does not include compute unit limit").
  // The prior guard treated the missing limit as computeUnitLimit===null and
  // silently computed ZERO exposure — this regression pins the fix.
  describe("price-only compute-budget instructions (the documented normal /build shape — no explicit limit)", () => {
    it("computes a conservative UPPER-BOUND estimate against Solana's 1,400,000-CU transaction max", () => {
      const result = assertComputeBudgetWithinPolicy([cuPriceIx(1_000)]);
      expect(result.computeUnitLimit).toBeNull();
      expect(result.computeUnitPriceMicroLamports).toBe(1_000n);
      // 1,400,000 CU (Solana tx max) x 1,000 microLamports / 1e6 = 1,400 lamports.
      expect(result.priorityFeeLamports).toBe(1_400n);
      expect(result.priorityFeeIsUpperBound).toBe(true);
    });

    it("refuses a price-only response whose upper-bound exposure exceeds the cap (previously silently ZERO)", () => {
      // 1,400,000 CU x 8,000,000 microLamports / 1e6 = 11,200,000 lamports,
      // which exceeds the 10,000,000-lamport cap. The pre-fix guard computed
      // 0n here (computeUnitLimit was null) and would have let this through.
      expect(() => assertComputeBudgetWithinPolicy([cuPriceIx(8_000_000)])).toThrow(VexError);
    });
  });
});
