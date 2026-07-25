/**
 * Jupiter `/build` response → an assembled, UNSIGNED `VersionedTransaction`
 * (W5 design `w5-design.md` §6, Jupiter docs `/docs/swap/build/common-
 * instructions`: instruction ordering is "(1) compute budget ixs, (2) setup
 * ixs, (3) your pre-swap ixs, (4) swap ix, (5) your post-swap ixs, (6)
 * cleanup ix (if present)").
 *
 * `/build` returns raw WIRE instructions (`SolanaInstructionWire` —
 * `{programId, accounts, data}`, base64 data) plus an optional
 * `addressesByLookupTableAddress` map. This module is the ONE place that
 * turns that wire shape into real `@solana/web3.js` objects and compiles a
 * v0 message — every fee-bearing swap consumer (`fee-swap.ts`) goes through
 * it so the instruction ordering + ALT handling is defined exactly once.
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import type { JupiterSwapBuildResponse } from "./types.js";
import type { SolanaInstructionWire } from "../../shared/types.js";

/** Sentinel meaning "this lookup table account is active" (never deactivated) — the ONLY shape needed to satisfy `TransactionMessage.compileToV0Message`, no RPC fetch required (the addresses are already given verbatim by `/build`). */
const U64_MAX = BigInt("0xffffffffffffffff");

/**
 * Exported (Codex batch-4 closure blocker C2) so `build-response-guard.ts`
 * can decode a raw wire instruction (tip / compute-budget) into a real
 * `TransactionInstruction` and hand it to `@solana/web3.js`'s own
 * `SystemInstruction`/`ComputeBudgetInstruction` decoders — reusing this
 * conversion instead of a second hand-rolled wire→instruction path.
 */
export function toTransactionInstruction(wire: SolanaInstructionWire): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(wire.programId),
    keys: wire.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isWritable: a.isWritable,
      isSigner: a.isSigner,
    })),
    data: Buffer.from(wire.data, "base64"),
  });
}

/**
 * Reconstruct the address lookup table accounts `/build` referenced, from
 * the addresses it already gave us — no on-chain fetch needed (the standard
 * Jupiter-ecosystem recipe for a response that already carries the resolved
 * address lists).
 */
function assembleLookupTables(
  addressesByLookupTableAddress: Record<string, string[]> | null | undefined,
): AddressLookupTableAccount[] {
  if (!addressesByLookupTableAddress) return [];
  return Object.entries(addressesByLookupTableAddress).map(
    ([altAddress, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(altAddress),
        state: {
          deactivationSlot: U64_MAX,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: addresses.map((a) => new PublicKey(a)),
        },
      }),
  );
}

/**
 * Assemble the UNSIGNED v0 transaction for a `/build` response, splicing
 * `preSwapInstructions` between `setupInstructions` and the swap instruction
 * (the fee-ATA idempotent-create belongs here — see `fee-swap.ts`). Returns
 * bytes ready for `prepareVersionedTx`'s VERIFY mode (the response's
 * `blockhashWithMetadata` is the known-blockhash evidence).
 */
export function assembleFeeBearingSwapTransaction(
  build: JupiterSwapBuildResponse,
  preSwapInstructions: readonly TransactionInstruction[],
  payer: PublicKey,
): VersionedTransaction {
  const instructions: TransactionInstruction[] = [
    ...build.computeBudgetInstructions.map(toTransactionInstruction),
    ...build.setupInstructions.map(toTransactionInstruction),
    ...preSwapInstructions,
    toTransactionInstruction(build.swapInstruction),
    ...build.otherInstructions.map(toTransactionInstruction),
  ];
  if (build.tipInstruction) instructions.push(toTransactionInstruction(build.tipInstruction));
  if (build.cleanupInstruction) instructions.push(toTransactionInstruction(build.cleanupInstruction));

  if (!build.blockhashWithMetadata) {
    throw new Error("jupiter /build response is missing blockhashWithMetadata — cannot assemble a signable transaction.");
  }
  const recentBlockhash = bytesToBase58Blockhash(build.blockhashWithMetadata.blockhash);

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions,
  }).compileToV0Message(assembleLookupTables(build.addressesByLookupTableAddress));

  return new VersionedTransaction(message);
}

/** `blockhashWithMetadata.blockhash` is a raw 32-byte array; web3.js's `message.recentBlockhash` is that same hash, base58-encoded. */
function bytesToBase58Blockhash(blockhash: readonly number[]): string {
  return bs58.encode(Uint8Array.from(blockhash));
}
