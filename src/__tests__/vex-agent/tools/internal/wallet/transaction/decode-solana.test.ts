/**
 * Solana decode GOLDENS, including the REFUSAL set.
 *
 * The messages are built with the real `@solana/web3.js` compiler, so the byte
 * layouts under test are the ones the runtime produces, not a hand-rolled
 * approximation. The only seam is the address-lookup-table reader, which is one
 * method and is answered from a literal here; nothing reaches a network.
 */

import { describe, it, expect } from "vitest";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";

import {
  decodeSolanaTransaction,
  assertProgramIdsAreValid,
  V1_SOLANA_PROGRAM_IDS,
  type AddressLookupTableReader,
} from "@vex-agent/tools/internal/wallet/transaction/decode-solana.js";

const PAYER = Keypair.generate().publicKey;
const OTHER = Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";

const TOKEN_PROGRAM = new PublicKey(V1_SOLANA_PROGRAM_IDS.classicToken);
const TOKEN_2022 = new PublicKey(V1_SOLANA_PROGRAM_IDS.token2022);
const COMPUTE_BUDGET = new PublicKey(V1_SOLANA_PROGRAM_IDS.computeBudget);
const MEMO = new PublicKey(V1_SOLANA_PROGRAM_IDS.memoV2);

const NO_LOOKUPS: AddressLookupTableReader = {
  getLookupTableAddresses: async () => null,
};

function compile(
  instructions: readonly TransactionInstruction[],
  lookupTables: readonly AddressLookupTableAccount[] = [],
) {
  return new TransactionMessage({
    payerKey: PAYER,
    recentBlockhash: BLOCKHASH,
    instructions: [...instructions],
  }).compileToV0Message([...lookupTables]);
}

function splInstruction(programId: PublicKey, data: Uint8Array, keys: readonly PublicKey[]) {
  return new TransactionInstruction({
    programId,
    keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.from(data),
  });
}

function u64le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

// ── Accepts ──────────────────────────────────────────────────────────

describe("Solana decode goldens - the closed v1 set", () => {
  it("the program id constants are real base58 keys", () => {
    expect(() => assertProgramIdsAreValid()).not.toThrow();
  });

  it("System.transfer binds sender, recipient and lamports", async () => {
    const message = compile([
      SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: OTHER, lamports: 1_500_000 }),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe("native_transfer");
    expect(result.value.instructions).toHaveLength(1);
    expect(result.value.instructions[0]).toMatchObject({
      program: "system",
      variant: "transfer",
      criticalArgs: { from: PAYER.toBase58(), recipient: OTHER.toBase58(), lamports: "1500000" },
    });
  });

  it("classic SPL transferChecked carries the mint and the decimals", async () => {
    const mint = Keypair.generate().publicKey;
    const source = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const data = new Uint8Array([12, ...u64le(2_500_000n), 6]);
    const message = compile([
      splInstruction(TOKEN_PROGRAM, data, [source, mint, destination, PAYER]),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instructions[0]).toMatchObject({
      program: "spl_token",
      variant: "transferChecked",
      criticalArgs: { mint: mint.toBase58(), amountRaw: "2500000", decimals: "6" },
    });
  });

  it("an UNCHECKED SPL transfer says it carries no mint, rather than implying one", async () => {
    const data = new Uint8Array([3, ...u64le(9n)]);
    const message = compile([
      splInstruction(TOKEN_PROGRAM, data, [OTHER, OTHER, PAYER]),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The raw amount cannot be rendered as a human figure from these bytes, and
    // the decode says so instead of guessing 9 decimals.
    expect(result.value.instructions[0]?.criticalArgs.decimals).toContain("transferChecked");
  });

  it("an SPL approve makes the whole set an `approve` role", async () => {
    const delegate = Keypair.generate().publicKey;
    const message = compile([
      splInstruction(TOKEN_PROGRAM, new Uint8Array([4, ...u64le(42n)]), [OTHER, delegate, PAYER]),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe("approve");
    expect(result.value.instructions[0]?.criticalArgs.delegate).toBe(delegate.toBase58());
  });

  it("SPL revoke decodes with no amount", async () => {
    const message = compile([
      splInstruction(TOKEN_PROGRAM, new Uint8Array([5]), [OTHER, PAYER]),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instructions[0]?.variant).toBe("revoke");
  });

  it("ComputeBudget limit and price decode, and do not decide the role", async () => {
    const limit = new Uint8Array(5);
    limit[0] = 2;
    new DataView(limit.buffer).setUint32(1, 300_000, true);
    const price = new Uint8Array([3, ...u64le(1_000n)]);
    const message = compile([
      splInstruction(COMPUTE_BUDGET, limit, []),
      splInstruction(COMPUTE_BUDGET, price, []),
      SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: OTHER, lamports: 1 }),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instructions[0]?.criticalArgs.computeUnitLimit).toBe("300000");
    expect(result.value.instructions[1]?.criticalArgs.computeUnitPriceMicroLamports).toBe("1000");
    // Budget instructions carry no effect, so the transfer still names the role.
    expect(result.value.role).toBe("native_transfer");
  });

  it("a memo is carried WHOLE, never cut", async () => {
    const text = "settlement note ".repeat(40);
    const message = compile([
      splInstruction(MEMO, new TextEncoder().encode(text), []),
      SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: OTHER, lamports: 1 }),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memo = result.value.instructions.find((one) => one.program === "memo");
    expect(memo?.criticalArgs.memo).toBe(text);
    expect(memo?.criticalArgs.memoEncoding).toBe("utf-8");
    expect(memo?.criticalArgs.memoBytes).toBe(String(text.length));
  });

  it("an INVALID-UTF-8 memo is rendered as tagged hex, never lossily replaced (non-blocking #4)", async () => {
    // 0xff 0xfe is not valid UTF-8; a non-fatal decoder would rewrite both bytes
    // to U+FFFD and hide what was actually signed.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const message = compile([
      splInstruction(MEMO, bytes, []),
      SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: OTHER, lamports: 1 }),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memo = result.value.instructions.find((one) => one.program === "memo");
    expect(memo?.criticalArgs.memoEncoding).toBe("hex");
    expect(memo?.criticalArgs.memo).toBe("hex:fffe0041");
    // No U+FFFD replacement character leaked into the shown value.
    expect(memo?.criticalArgs.memo).not.toContain("�");
    expect(memo?.criticalArgs.memoBytes).toBe("4");
  });

  it("address lookup tables are RESOLVED, and their keys reach the account list", async () => {
    const looked = Keypair.generate().publicKey;
    const tableKey = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [looked],
      },
    });
    const message = compile(
      [SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: looked, lamports: 1 })],
      [table],
    );
    expect(message.addressTableLookups.length).toBeGreaterThan(0);

    const result = await decodeSolanaTransaction(message, {
      getLookupTableAddresses: async (key) =>
        key === tableKey.toBase58() ? [looked.toBase58()] : null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.addressTableLookupsResolved).toBe(true);
    expect(result.value.accountKeys).toContain(looked.toBase58());
    expect(result.value.instructions[0]?.criticalArgs.recipient).toBe(looked.toBase58());
  });
});

// ── THE REFUSAL SET ──────────────────────────────────────────────────

describe("Solana decode goldens - the REFUSAL set", () => {
  it("TOKEN-2022 is refused BY NAME, with the extensions reason stated", async () => {
    const data = new Uint8Array([3, ...u64le(1n)]);
    const message = compile([splInstruction(TOKEN_2022, data, [OTHER, OTHER, PAYER])]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("token_2022_unsupported");
    expect(result.refusal.message).toContain("Token-2022");
    expect(result.refusal.message).toContain("transfer-fee");
    expect(result.refusal.message).toContain("transfer-hook");
    expect(result.refusal.details?.programId).toBe(V1_SOLANA_PROGRAM_IDS.token2022);
  });

  it("an unknown PROGRAM refuses and names it", async () => {
    const stranger = Keypair.generate().publicKey;
    const message = compile([splInstruction(stranger, new Uint8Array([1]), [OTHER])]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_instruction");
    expect(result.refusal.message).toContain(stranger.toBase58());
  });

  it("a KNOWN program with an unallowed VARIANT refuses - the allowlist is variants", async () => {
    // SPL `burn` is discriminant 8. Same program id as the allowed transfer.
    const message = compile([
      splInstruction(TOKEN_PROGRAM, new Uint8Array([8, ...u64le(1n)]), [OTHER, OTHER, PAYER]),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_instruction");
    expect(result.refusal.message).toContain("instruction variants rather than as a trusted program");
  });

  it("a System instruction that is not `transfer` refuses", async () => {
    const message = compile([
      SystemProgram.createAccount({
        fromPubkey: PAYER,
        newAccountPubkey: OTHER,
        lamports: 1,
        space: 0,
        programId: SystemProgram.programId,
      }),
    ]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toContain("only System Program instruction in the v1 decode set");
  });

  it("an UNRESOLVABLE address lookup table refuses before any verification", async () => {
    const looked = Keypair.generate().publicKey;
    const tableKey = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [looked],
      },
    });
    const message = compile(
      [SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: looked, lamports: 1 })],
      [table],
    );
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unresolvable_address_lookup_table");
    expect(result.refusal.details?.tableKey).toBe(tableKey.toBase58());
  });

  it("a lookup table that is too SHORT for the referenced index refuses", async () => {
    const looked = Keypair.generate().publicKey;
    const tableKey = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [looked],
      },
    });
    const message = compile(
      [SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: looked, lamports: 1 })],
      [table],
    );
    const result = await decodeSolanaTransaction(message, {
      // The table exists but no longer holds the entry the message indexes.
      getLookupTableAddresses: async () => [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unresolvable_address_lookup_table");
  });

  it("a message with NO instructions refuses rather than signing an empty authorization", async () => {
    const message = compile([]);
    const result = await decodeSolanaTransaction(message, NO_LOOKUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_instruction");
  });
});
