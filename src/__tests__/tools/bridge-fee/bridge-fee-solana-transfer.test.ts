/**
 * Vex bridge fee — the Solana transfer leg.
 *
 * The properties that carry real money:
 *   - the treasury ATA is derived under the MINT'S OWN token program, read
 *     on-chain (classic SPL vs Token-2022). Guessing wrong derives an address
 *     nobody can ever see funds land in — the fee would be irrecoverable.
 *   - a missing treasury ATA is created IDEMPOTENTLY, before the transfer.
 *   - the transaction is sole-signer/fee-payer shaped so `prepareVersionedTx`'s
 *     STRICT `soleSigner` contract accepts it (and so a fresh blockhash is
 *     baked in before signing).
 *   - a Token-2022 mint carrying a TRANSFER FEE is REFUSED: the treasury would
 *     be credited less than we transfer, and booking the sent amount as
 *     received would be a lie.
 */

import { describe, expect, it } from "vitest";
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getAssociatedTokenAddressSync,
  MintLayout,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TransferFeeConfigLayout,
} from "@solana/spl-token";

import { VEX_TREASURY_SOLANA } from "../../../lib/vex-treasury.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { buildSolanaBridgeFeeTransfer } from "@tools/bridge-fee/solana-fee-transfer.js";

const OWNER = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A real Token-2022 mint (PayPal USD) — used only as a well-formed base58 mint id. */
const TOKEN_2022_MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const FEE = 37_500n;
const DECIMALS = 6;

/**
 * Real mint-account bytes, so `getMint` and `getTransferFeeConfig` run for
 * real rather than against a hand-shaped object. `transferFee` appends a
 * Token-2022 TLV extension in the layout `unpackMint` expects: the base mint
 * padded to `ACCOUNT_SIZE`, an `AccountType.Mint` discriminator byte, then
 * `[u16 type][u16 length][data]`.
 */
function mintAccountData(options: { transferFee?: boolean } = {}): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000n,
      decimals: DECIMALS,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  if (!options.transferFee) return base;

  const tlv = Buffer.alloc(4 + TransferFeeConfigLayout.span);
  tlv.writeUInt16LE(ExtensionType.TransferFeeConfig, 0);
  tlv.writeUInt16LE(TransferFeeConfigLayout.span, 2);
  const padded = Buffer.alloc(ACCOUNT_SIZE);
  base.copy(padded);
  return Buffer.concat([padded, Buffer.from([1 /* AccountType.Mint */]), tlv]);
}

function fakeConnection(options: {
  mint: string;
  mintOwner: PublicKey;
  treasuryAtaExists: boolean;
  transferFee?: boolean;
}): Connection {
  const data = mintAccountData({ transferFee: options.transferFee === true });
  return {
    getAccountInfo: async (pubkey: PublicKey) => {
      if (pubkey.toBase58() === options.mint) {
        return { owner: options.mintOwner, data, lamports: 1, executable: false, rentEpoch: 0 };
      }
      return options.treasuryAtaExists
        ? { owner: options.mintOwner, data: Buffer.alloc(ACCOUNT_SIZE), lamports: 1, executable: false, rentEpoch: 0 }
        : null;
    },
    // Narrow stub: the builder uses only `getAccountInfo` (directly and via
    // `getMint`), so the rest of the Connection surface is deliberately absent.
  } as unknown as Connection;
}

function decode(base64Tx: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
}

function programOf(tx: VersionedTransaction, instructionIndex: number): string {
  const ix = tx.message.compiledInstructions[instructionIndex]!;
  return tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58();
}

describe("buildSolanaBridgeFeeTransfer — token-program-correct treasury ATA", () => {
  it("derives the treasury ATA under the CLASSIC SPL program for a classic mint", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      connection: fakeConnection({ mint: USDC_MINT, mintOwner: TOKEN_PROGRAM_ID, treasuryAtaExists: true }),
      mint: USDC_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });

    const expected = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT), new PublicKey(VEX_TREASURY_SOLANA), false, TOKEN_PROGRAM_ID,
    );
    expect(built.destination).toBe(expected.toBase58());
    expect(built.createsDestinationAccount).toBe(false);
  });

  it("TOKEN-2022 mint: derives the ATA under Token-2022, NOT the classic program", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      connection: fakeConnection({ mint: TOKEN_2022_MINT, mintOwner: TOKEN_2022_PROGRAM_ID, treasuryAtaExists: true }),
      mint: TOKEN_2022_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });

    const mint = new PublicKey(TOKEN_2022_MINT);
    const treasury = new PublicKey(VEX_TREASURY_SOLANA);
    const token2022Ata = getAssociatedTokenAddressSync(mint, treasury, false, TOKEN_2022_PROGRAM_ID);
    const classicAta = getAssociatedTokenAddressSync(mint, treasury, false, TOKEN_PROGRAM_ID);

    expect(built.destination).toBe(token2022Ata.toBase58());
    // The whole point: the two derivations differ, and picking the classic one
    // would send the fee to an address nobody can ever open.
    expect(token2022Ata.toBase58()).not.toBe(classicAta.toBase58());
    expect(built.destination).not.toBe(classicAta.toBase58());

    // …and the transfer executes under Token-2022, not the classic program.
    const tx = decode(built.base64Tx);
    expect(programOf(tx, 0)).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });
});

describe("buildSolanaBridgeFeeTransfer — idempotent ATA creation", () => {
  it("prepends an IDEMPOTENT create when the treasury ATA does not exist, before the transfer", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      connection: fakeConnection({ mint: TOKEN_2022_MINT, mintOwner: TOKEN_2022_PROGRAM_ID, treasuryAtaExists: false }),
      mint: TOKEN_2022_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });
    expect(built.createsDestinationAccount).toBe(true);

    const tx = decode(built.base64Tx);
    expect(tx.message.compiledInstructions).toHaveLength(2);
    // Ordering matters: the account must exist before it is credited.
    expect(programOf(tx, 0)).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(programOf(tx, 1)).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    // `1` is CreateIdempotent (a plain `Create` would revert on a race).
    expect(tx.message.compiledInstructions[0]!.data[0]).toBe(1);
  });

  it("adds NO create instruction when the treasury ATA already exists", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      connection: fakeConnection({ mint: USDC_MINT, mintOwner: TOKEN_PROGRAM_ID, treasuryAtaExists: true }),
      mint: USDC_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });
    const tx = decode(built.base64Tx);
    expect(tx.message.compiledInstructions).toHaveLength(1);
    expect(programOf(tx, 0)).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe("buildSolanaBridgeFeeTransfer — transaction shape", () => {
  it("transfers EXACTLY feeRaw with the mint's own decimals (transferChecked)", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      connection: fakeConnection({ mint: USDC_MINT, mintOwner: TOKEN_PROGRAM_ID, treasuryAtaExists: true }),
      mint: USDC_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });
    const data = Buffer.from(decode(built.base64Tx).message.compiledInstructions[0]!.data);
    expect(data[0]).toBe(12); // TokenInstruction.TransferChecked
    expect(data.readBigUInt64LE(1)).toBe(FEE);
    expect(data[9]).toBe(DECIMALS);
  });

  it("is sole-signer + fee-payer shaped, so prepareVersionedTx's soleSigner contract accepts it", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      connection: fakeConnection({ mint: USDC_MINT, mintOwner: TOKEN_PROGRAM_ID, treasuryAtaExists: true }),
      mint: USDC_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });
    const tx = decode(built.base64Tx);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(OWNER);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it("NATIVE SOL moves lamports through the System Program to the treasury wallet", async () => {
    const built = await buildSolanaBridgeFeeTransfer({
      // No mint read happens on this path — SOL_MINT short-circuits.
      connection: fakeConnection({ mint: SOL_MINT, mintOwner: TOKEN_PROGRAM_ID, treasuryAtaExists: true }),
      mint: SOL_MINT,
      feeRaw: FEE,
      owner: OWNER,
    });
    expect(built.destination).toBe(VEX_TREASURY_SOLANA);
    expect(built.createsDestinationAccount).toBe(false);

    const tx = decode(built.base64Tx);
    expect(programOf(tx, 0)).toBe(SystemProgram.programId.toBase58());
    // An SPL transfer out of a wSOL ATA would fail against an unwrapped balance.
    expect(programOf(tx, 0)).not.toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe("buildSolanaBridgeFeeTransfer — refusals", () => {
  it("REFUSES a Token-2022 mint carrying a transfer fee (the treasury would receive less)", async () => {
    await expect(
      buildSolanaBridgeFeeTransfer({
        connection: fakeConnection({
          mint: TOKEN_2022_MINT, mintOwner: TOKEN_2022_PROGRAM_ID, treasuryAtaExists: true, transferFee: true,
        }),
        mint: TOKEN_2022_MINT,
        feeRaw: FEE,
        owner: OWNER,
      }),
    ).rejects.toThrow(/transfer fee/i);
  });

  it("REFUSES a non-positive fee (the caller must skip the leg, not send zero)", async () => {
    await expect(
      buildSolanaBridgeFeeTransfer({
        connection: fakeConnection({ mint: USDC_MINT, mintOwner: TOKEN_PROGRAM_ID, treasuryAtaExists: true }),
        mint: USDC_MINT,
        feeRaw: 0n,
        owner: OWNER,
      }),
    ).rejects.toThrow();
  });
});
