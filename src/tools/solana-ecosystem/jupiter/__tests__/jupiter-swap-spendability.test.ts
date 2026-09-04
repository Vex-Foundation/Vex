/**
 * What a Jupiter swap actually costs the wallet, and what the wallet can
 * actually spend.
 *
 * THE DEFECTS THESE PIN, all three measured against the live provider on
 * 2026-08-31 (one `/build`, SOL to USDC, 0.01 SOL, tip 1,000,000):
 *
 *  1. the wallet pays rent for accounts nobody was counting. The response
 *     carried TWO Associated-Token-Account creations with the taker as payer,
 *     on top of the treasury fee ATA `fee-swap.ts` splices in itself, so a
 *     guard that summed only `ataRentLamports` would have understated the
 *     debit by two account rents;
 *  2. the principal and the tip are already IN the message, as System
 *     transfers of exactly `inAmount` and exactly the approved tip, so adding
 *     either on top of the decoded instructions counts it twice;
 *  3. `getFeeForMessage` on that exact message answered 7,321 lamports where
 *     the base fee for its one signature is 5,000, so it already carries the
 *     priority fee and `priorityFeeLamportsEstimate` must never be added to it.
 *
 * The messages below are real compiled v0 messages, not stubs: the attribution
 * decodes what `@solana/web3.js` itself encodes.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  measureJupiterNativeDebit,
  readNativeLamports,
  readSplSpendability,
} from "../jupiter-swaps/spendability.js";

const SIGNER = Keypair.generate().publicKey;
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const BLOCKHASH = "11111111111111111111111111111111";

/** Live figures, reused so a test that drifts from the provider is visible. */
const LIVE_MESSAGE_FEE = 7_321;
const LIVE_RESERVE_FEE = 5_000;
const LIVE_RENT_165 = 2_039_280;
const PRINCIPAL = 10_000_000;
const TIP = 1_000_000;

function compile(instructions: TransactionInstruction[], payer = SIGNER): VersionedMessage {
  return new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
}

/** The shape of the live `/build` message: wrap, ATA creations, tip, priority fee. */
function liveShapedSwapMessage(): VersionedMessage {
  const wsolAta = getAssociatedTokenAddressSync(WSOL, SIGNER);
  const outAta = getAssociatedTokenAddressSync(MINT, SIGNER);
  return compile([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(SIGNER, wsolAta, SIGNER, WSOL),
    SystemProgram.transfer({ fromPubkey: SIGNER, toPubkey: wsolAta, lamports: PRINCIPAL }),
    createAssociatedTokenAccountIdempotentInstruction(SIGNER, outAta, SIGNER, MINT),
    SystemProgram.transfer({ fromPubkey: SIGNER, toPubkey: Keypair.generate().publicKey, lamports: TIP }),
  ]);
}

interface ConnectionScript {
  /** Accounts the chain already has, so an idempotent creation costs nothing. */
  readonly existingAccounts?: readonly string[];
  readonly fees?: readonly (number | null)[];
}

function scriptedConnection(script: ConnectionScript = {}) {
  const fees = [...(script.fees ?? [LIVE_MESSAGE_FEE, LIVE_RESERVE_FEE])];
  const existing = new Set(script.existingAccounts ?? []);
  const calls = { rentExemption: 0, accountInfo: 0, feeForMessage: 0 };
  const connection = {
    getFeeForMessage: vi.fn(async () => {
      calls.feeForMessage += 1;
      return { context: { slot: 1 }, value: fees.shift() ?? null };
    }),
    getAccountInfo: vi.fn(async (key: PublicKey) => {
      calls.accountInfo += 1;
      return existing.has(key.toBase58())
        ? { data: new Uint8Array(), owner: SystemProgram.programId }
        : null;
    }),
    // No fixture uses address lookup tables, so a call here is a defect.
    getAddressLookupTable: vi.fn(async () => {
      throw new Error("no lookup table was expected");
    }),
    getMinimumBalanceForRentExemption: vi.fn(async () => {
      calls.rentExemption += 1;
      return LIVE_RENT_165;
    }),
  };
  return { connection, calls };
}

function tokenAccount(info: Record<string, unknown>) {
  return {
    pubkey: Keypair.generate().publicKey,
    account: { data: { parsed: { type: "account", info } } },
  };
}

function splAccount(params: {
  amount: string;
  state: string;
  decimals?: number;
  mint?: string;
  owner?: string;
}) {
  return tokenAccount({
    mint: params.mint ?? MINT.toBase58(),
    owner: params.owner ?? SIGNER.toBase58(),
    state: params.state,
    tokenAmount: { amount: params.amount, decimals: params.decimals ?? 6 },
  });
}

function splRpc(accounts: ReturnType<typeof splAccount>[], lamports = 0) {
  return {
    getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: accounts })),
    getBalance: vi.fn(async () => lamports),
  };
}

describe("SPL source spendability", () => {
  it("counts only initialized, non-frozen atoms and reports frozen ones separately", async () => {
    const result = await readSplSpendability(
      splRpc([
        splAccount({ amount: "1000", state: "initialized" }),
        splAccount({ amount: "250", state: "initialized" }),
        splAccount({ amount: "9999", state: "frozen" }),
      ]),
      SIGNER.toBase58(),
      MINT.toBase58(),
    );

    expect(result.spendableAmountRaw).toBe("1250");
    expect(result.frozenAmountRaw).toBe("9999");
    expect(result.malformedOrUnknownAccounts).toBe(0);
    expect(result.accountCount).toBe(3);
    expect(result.decimals).toBe(6);
  });

  it("treats an unknown account state as unreadable, never as zero", async () => {
    const result = await readSplSpendability(
      splRpc([
        splAccount({ amount: "1000", state: "initialized" }),
        splAccount({ amount: "500", state: "uninitialized" }),
        splAccount({ amount: "700", state: "somethingNewOnChain" }),
      ]),
      SIGNER.toBase58(),
      MINT.toBase58(),
    );

    expect(result.spendableAmountRaw).toBe("1000");
    expect(result.frozenAmountRaw).toBe("0");
    expect(result.malformedOrUnknownAccounts).toBe(2);
  });

  it("refuses an account whose shape, mint, owner or decimals do not match the question", async () => {
    const result = await readSplSpendability(
      splRpc([
        splAccount({ amount: "1000", state: "initialized" }),
        splAccount({ amount: "1", state: "initialized", mint: WSOL.toBase58() }),
        splAccount({ amount: "2", state: "initialized", owner: Keypair.generate().publicKey.toBase58() }),
        splAccount({ amount: "3", state: "initialized", decimals: 9 }),
        tokenAccount({ mint: MINT.toBase58() }),
      ]),
      SIGNER.toBase58(),
      MINT.toBase58(),
    );

    expect(result.spendableAmountRaw).toBe("1000");
    expect(result.malformedOrUnknownAccounts).toBe(4);
  });

  it("reads native lamports as an exact integer string", async () => {
    await expect(readNativeLamports(splRpc([], 1_234_567), SIGNER.toBase58())).resolves.toBe("1234567");
  });

  it("refuses a lamport balance the node did not state as a whole number", async () => {
    await expect(readNativeLamports(splRpc([], 1.5), SIGNER.toBase58()))
      .rejects.toThrow(/cannot state exactly/);
  });

  it("reads the largest exactly representable balance, and refuses the first one past it", async () => {
    // THE BOUNDARY. `getBalance` is typed `number` but lamports are a u64, so
    // a balance past 2^53 - 1 has already been rounded by the JSON parse.
    // `Number.isInteger` says yes to the rounded value; only
    // `Number.isSafeInteger` catches it. One lamport on either side:
    await expect(readNativeLamports(splRpc([], Number.MAX_SAFE_INTEGER), SIGNER.toBase58()))
      .resolves.toBe("9007199254740991");
    await expect(readNativeLamports(splRpc([], Number.MAX_SAFE_INTEGER + 1), SIGNER.toBase58()))
      .rejects.toThrow(/cannot state exactly/);
  });

  it("refuses a lamport balance that is not a number at all", async () => {
    await expect(readNativeLamports(splRpc([], Number.NaN), SIGNER.toBase58()))
      .rejects.toThrow(/cannot state exactly/);
    await expect(readNativeLamports(splRpc([], Number.POSITIVE_INFINITY), SIGNER.toBase58()))
      .rejects.toThrow(/cannot state exactly/);
    await expect(readNativeLamports(splRpc([], -1), SIGNER.toBase58()))
      .rejects.toThrow(/cannot state exactly/);
  });
});

describe("native debit measured off the exact message", () => {
  it("counts the principal, the tip and every wallet-paid account rent exactly once", async () => {
    const { connection, calls } = scriptedConnection();
    const debit = await measureJupiterNativeDebit({
      connection,
      message: liveShapedSwapMessage(),
      signer: SIGNER,
    });

    // The wrap (the principal), the tip, and rent for the two accounts the
    // wallet funds. Nothing here is `tipLamports` or `ataRentLamports` read
    // from the quote: every figure came out of the message.
    expect(debit.attributedLamports).toBe(String(PRINCIPAL + TIP + LIVE_RENT_165 * 2));
    expect(debit.messageFeeLamports).toBe(String(LIVE_MESSAGE_FEE));
    expect(debit.followUpReserveLamports).toBe(String(LIVE_RESERVE_FEE));
    expect(debit.totalLamports).toBe(
      String(PRINCIPAL + TIP + LIVE_RENT_165 * 2 + LIVE_MESSAGE_FEE + LIVE_RESERVE_FEE),
    );
    expect(calls.feeForMessage).toBe(2);
  });

  it("charges no rent for an associated account the chain already has", async () => {
    const wsolAta = getAssociatedTokenAddressSync(WSOL, SIGNER).toBase58();
    const outAta = getAssociatedTokenAddressSync(MINT, SIGNER).toBase58();
    const { connection, calls } = scriptedConnection({ existingAccounts: [wsolAta, outAta] });

    const debit = await measureJupiterNativeDebit({
      connection,
      message: liveShapedSwapMessage(),
      signer: SIGNER,
    });

    expect(debit.attributedLamports).toBe(String(PRINCIPAL + TIP));
    expect(calls.rentExemption).toBe(0);
  });

  it("does NOT add a priority-fee estimate on top of the node's own message fee", async () => {
    // The message carries a compute-unit price instruction, which is exactly
    // what `priorityFeeLamportsEstimate` is decoded from. The node's answer
    // already prices it, so the total moves by the node's number and by
    // nothing else.
    const { connection } = scriptedConnection({ fees: [LIVE_MESSAGE_FEE, LIVE_RESERVE_FEE] });
    const withPriority = await measureJupiterNativeDebit({
      connection,
      message: liveShapedSwapMessage(),
      signer: SIGNER,
    });

    const { connection: plain } = scriptedConnection({ fees: [LIVE_RESERVE_FEE, LIVE_RESERVE_FEE] });
    const withoutPriority = await measureJupiterNativeDebit({
      connection: plain,
      message: liveShapedSwapMessage(),
      signer: SIGNER,
    });

    expect(BigInt(withPriority.totalLamports) - BigInt(withoutPriority.totalLamports)).toBe(
      BigInt(LIVE_MESSAGE_FEE - LIVE_RESERVE_FEE),
    );
  });

  it("counts a native principal exactly once, and never the 25 bps fee taken out of it", async () => {
    const { connection } = scriptedConnection({ existingAccounts: [] });
    const wsolAta = getAssociatedTokenAddressSync(WSOL, SIGNER);
    const debit = await measureJupiterNativeDebit({
      connection,
      message: compile([SystemProgram.transfer({ fromPubkey: SIGNER, toPubkey: wsolAta, lamports: PRINCIPAL })]),
      signer: SIGNER,
    });

    // The swap's own 25 bps comes OUT of `inAmount`; the wallet is debited
    // `inAmount` and not a lamport more for the fee.
    expect(debit.attributedLamports).toBe(String(PRINCIPAL));
  });

  it("ignores a transfer the wallet is not paying for", async () => {
    const other = Keypair.generate();
    const { connection } = scriptedConnection();
    const message = new TransactionMessage({
      payerKey: SIGNER,
      recentBlockhash: BLOCKHASH,
      instructions: [
        SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: SIGNER, lamports: 42 }),
      ],
    }).compileToV0Message();

    const debit = await measureJupiterNativeDebit({ connection, message, signer: SIGNER });
    expect(debit.attributedLamports).toBe("0");
  });

  it("refuses a System instruction it cannot decode", async () => {
    const { connection } = scriptedConnection();
    const message = compile([
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [{ pubkey: SIGNER, isSigner: true, isWritable: true }],
        data: Buffer.from([99, 0, 0, 0]),
      }),
    ]);

    await expect(measureJupiterNativeDebit({ connection, message, signer: SIGNER })).rejects.toThrow(
      /cannot be accounted for/,
    );
  });

  it("refuses an associated-token instruction that is not a plain creation", async () => {
    const { connection } = scriptedConnection();
    const message = compile([
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: SIGNER, isSigner: true, isWritable: true },
          { pubkey: getAssociatedTokenAddressSync(MINT, SIGNER), isSigner: false, isWritable: true },
          { pubkey: SIGNER, isSigner: false, isWritable: false },
          { pubkey: MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        // `RecoverNested`.
        data: Buffer.from([2]),
      }),
    ]);

    await expect(measureJupiterNativeDebit({ connection, message, signer: SIGNER })).rejects.toThrow(
      /not a plain account creation/,
    );
  });

  it("refuses to price a message whose fee payer is not the selected wallet", async () => {
    const { connection } = scriptedConnection();
    const stranger = Keypair.generate().publicKey;
    const message = compile(
      [SystemProgram.transfer({ fromPubkey: stranger, toPubkey: SIGNER, lamports: 1 })],
      stranger,
    );

    await expect(measureJupiterNativeDebit({ connection, message, signer: SIGNER })).rejects.toThrow(
      /fee payer is not the selected wallet/,
    );
  });

  it("refuses when the node cannot price the message", async () => {
    const { connection } = scriptedConnection({ fees: [null] });
    await expect(
      measureJupiterNativeDebit({ connection, message: liveShapedSwapMessage(), signer: SIGNER }),
    ).rejects.toThrow(/could not price this transaction/);
  });
});
