/**
 * `assembleFeeBearingSwapTransaction` unit tests (W5 design §6, Jupiter docs
 * `/docs/swap/build/common-instructions`). Pins: instruction ordering
 * (compute, setup, OUR pre-swap ix, swap, otherInstructions, tip, cleanup),
 * ALT reconstruction without an RPC round-trip, and the compiled message's
 * embedded blockhash matching `blockhashWithMetadata`.
 */

import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const { assembleFeeBearingSwapTransaction, toTransactionInstruction } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-swaps/build-assembly.js"
);

const PAYER = Keypair.generate().publicKey;

function wireIx(label: string): { programId: string; accounts: []; data: string } {
  // Data payload is an arbitrary label, base64-encoded — assembly does not
  // interpret it; tests recover the label from the compiled instruction's
  // raw data bytes to assert ordering.
  return {
    programId: SystemProgram.programId.toBase58(),
    accounts: [],
    data: Buffer.from(label).toString("base64"),
  };
}

describe("assembleFeeBearingSwapTransaction", () => {
  const blockhashBytes = Array(32).fill(7);
  const expectedBlockhash = bs58.encode(Uint8Array.from(blockhashBytes));

  it("orders instructions: compute, setup, OUR pre-swap ix, swap, otherInstructions, tip, cleanup", () => {
    const build = {
      inputMint: "in", outputMint: "out", inAmount: "1", outAmount: "2", otherAmountThreshold: "2",
      routePlan: [],
      computeBudgetInstructions: [wireIx("compute")],
      setupInstructions: [wireIx("setup")],
      swapInstruction: wireIx("swap"),
      otherInstructions: [wireIx("other")],
      tipInstruction: wireIx("tip"),
      cleanupInstruction: wireIx("cleanup"),
      blockhashWithMetadata: { blockhash: blockhashBytes, lastValidBlockHeight: 1 },
    };
    const preSwap = [new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.from("preswap") })];

    const tx = assembleFeeBearingSwapTransaction(build, preSwap, PAYER);

    // Re-derive the instruction list from the compiled message to assert order.
    const labels = tx.message.compiledInstructions.map((ci) => Buffer.from(ci.data).toString());
    expect(labels).toEqual(["compute", "setup", "preswap", "swap", "other", "tip", "cleanup"]);
  });

  it("omits tip/cleanup when absent and injects nothing extra when preSwapInstructions is empty", () => {
    const build = {
      inputMint: "in", outputMint: "out", inAmount: "1", outAmount: "2", otherAmountThreshold: "2",
      routePlan: [],
      computeBudgetInstructions: [],
      setupInstructions: [wireIx("setup")],
      swapInstruction: wireIx("swap"),
      otherInstructions: [],
      cleanupInstruction: null,
      blockhashWithMetadata: { blockhash: blockhashBytes, lastValidBlockHeight: 1 },
    };
    const tx = assembleFeeBearingSwapTransaction(build, [], PAYER);
    const labels = tx.message.compiledInstructions.map((ci) => Buffer.from(ci.data).toString());
    expect(labels).toEqual(["setup", "swap"]);
  });

  it("compiles the message with the response's blockhash (base58 of the raw byte array)", () => {
    const build = {
      inputMint: "in", outputMint: "out", inAmount: "1", outAmount: "2", otherAmountThreshold: "2",
      routePlan: [], computeBudgetInstructions: [], setupInstructions: [],
      swapInstruction: wireIx("swap"), otherInstructions: [], cleanupInstruction: null,
      blockhashWithMetadata: { blockhash: blockhashBytes, lastValidBlockHeight: 1 },
    };
    const tx = assembleFeeBearingSwapTransaction(build, [], PAYER);
    expect(tx.message.recentBlockhash).toBe(expectedBlockhash);
  });

  it("reconstructs address lookup tables from addressesByLookupTableAddress without an RPC fetch", () => {
    const altAddress = Keypair.generate().publicKey.toBase58();
    const lookedUpAddr = Keypair.generate().publicKey.toBase58();
    const build = {
      inputMint: "in", outputMint: "out", inAmount: "1", outAmount: "2", otherAmountThreshold: "2",
      routePlan: [], computeBudgetInstructions: [], setupInstructions: [],
      swapInstruction: {
        programId: SystemProgram.programId.toBase58(),
        accounts: [{ pubkey: lookedUpAddr, isWritable: true, isSigner: false }],
        data: Buffer.from("swap").toString("base64"),
      },
      otherInstructions: [], cleanupInstruction: null,
      addressesByLookupTableAddress: { [altAddress]: [lookedUpAddr] },
      blockhashWithMetadata: { blockhash: blockhashBytes, lastValidBlockHeight: 1 },
    };
    // Would throw if the ALT accounts were not correctly reconstructed (the
    // swap instruction references an account ONLY resolvable via the ALT).
    const tx = assembleFeeBearingSwapTransaction(build, [], PAYER);
    expect(tx.message.addressTableLookups.length).toBe(1);
    expect(tx.message.addressTableLookups[0]!.accountKey.toBase58()).toBe(altAddress);
  });

  // Codex batch-4 closure blocker C2: `toTransactionInstruction` is now
  // exported so `build-response-guard.ts` can decode a raw wire instruction
  // (tip / compute-budget) into a real `TransactionInstruction` and hand it to
  // `@solana/web3.js`'s own decoders — pin the round-trip stays faithful.
  it("toTransactionInstruction round-trips programId/accounts/data faithfully (public export used by build-response-guard.ts)", () => {
    const target = Keypair.generate().publicKey;
    const wire = {
      programId: SystemProgram.programId.toBase58(),
      accounts: [{ pubkey: target.toBase58(), isWritable: true, isSigner: false }],
      data: Buffer.from([1, 2, 3]).toString("base64"),
    };
    const ix = toTransactionInstruction(wire);
    expect(ix.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(ix.keys).toEqual([{ pubkey: target, isWritable: true, isSigner: false }]);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("throws when the response has no blockhashWithMetadata", () => {
    const build = {
      inputMint: "in", outputMint: "out", inAmount: "1", outAmount: "2", otherAmountThreshold: "2",
      routePlan: [], computeBudgetInstructions: [], setupInstructions: [],
      swapInstruction: wireIx("swap"), otherInstructions: [], cleanupInstruction: null,
    };
    expect(() => assembleFeeBearingSwapTransaction(build, [], PAYER)).toThrow();
  });
});
