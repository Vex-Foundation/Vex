/**
 * Solana bridge fee leg — Vex's own transfer of the integrator fee to the
 * treasury, as a SEPARATE transaction that runs AFTER the provider-built
 * bridge deposit.
 *
 * It is deliberately not spliced into the provider's deposit transaction:
 * that transaction is provider-built and passes a STRICT sole-signer check
 * (`prepareVersionedTx`), and rewriting it would put Vex's fee at risk of
 * inheriting a provider failure — or, worse, of altering bytes we do not own.
 *
 * The transaction is compiled with a PLACEHOLDER blockhash. Every caller signs
 * it through `prepareVersionedTx` in REPLACE / MANDATORY-HEIGHT mode (no
 * `knownBlockhash`), which fetches a fresh `{blockhash,
 * lastValidBlockHeight}` pair and bakes it in BEFORE signing — the same
 * discipline the Khalani Solana deposit leg already uses. A path that somehow
 * skipped that replacement would produce a transaction the cluster rejects,
 * i.e. it fails closed.
 *
 * Token-program awareness is NOT hand-rolled: `resolveMintTokenProgramId`
 * reads the mint's real on-chain owner (classic SPL vs Token-2022) and
 * `deriveAssociatedTokenAccount` derives the ATA under it — the same proven
 * pair `jupiter-swaps/fee-swap.ts` uses, whose treasury ATA has received a
 * real on-chain fee.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getMint,
  getTransferFeeConfig,
} from "@solana/spl-token";

import { VexError, ErrorCodes } from "../../errors.js";
import { SOL_MINT } from "../solana-ecosystem/shared/solana-constants.js";
import {
  deriveAssociatedTokenAccount,
  resolveMintTokenProgramId,
} from "../solana-ecosystem/shared/solana-token-program.js";
import { BRIDGE_FEE_RECEIVER_SOLANA } from "./constants.js";

/**
 * Placeholder recent blockhash. Replaced with a fresh one by
 * `prepareVersionedTx`'s REPLACE mode before signing — see the module doc.
 */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

export interface SolanaBridgeFeeTransfer {
  /** Unsigned v0 transaction, base64 — the shape the Solana staging path consumes. */
  readonly base64Tx: string;
  /** The treasury account credited: its ATA for an SPL mint, the treasury wallet for native SOL. */
  readonly destination: string;
  /** True when an idempotent ATA-create instruction was prepended (the treasury ATA did not exist yet). */
  readonly createsDestinationAccount: boolean;
}

/**
 * Build the unsigned fee transfer for `feeRaw` smallest units of `mint`,
 * payable and signable by `owner` alone.
 *
 * Native SOL (`SOL_MINT`) moves as lamports through the System Program: that
 * is what the wallet actually holds, and an SPL transfer out of a wSOL ATA
 * would fail against an unwrapped balance. Every other mint moves as a
 * `transferChecked` (decimals read from the mint, so a decimals mismatch
 * aborts on-chain instead of moving the wrong amount) into the treasury's ATA,
 * created idempotently when absent.
 */
export async function buildSolanaBridgeFeeTransfer(params: {
  readonly connection: Connection;
  readonly mint: string;
  readonly feeRaw: bigint;
  readonly owner: string;
}): Promise<SolanaBridgeFeeTransfer> {
  const { connection, mint, feeRaw, owner } = params;
  if (feeRaw <= 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "Refusing to build a bridge fee transfer for a non-positive amount.",
    );
  }
  const ownerPubkey = new PublicKey(owner);
  const treasury = new PublicKey(BRIDGE_FEE_RECEIVER_SOLANA);

  const built = mint === SOL_MINT
    ? buildNativeFeeInstructions(ownerPubkey, treasury, feeRaw)
    : await buildSplFeeInstructions(connection, new PublicKey(mint), ownerPubkey, treasury, feeRaw);

  const message = new TransactionMessage({
    payerKey: ownerPubkey,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    instructions: built.instructions,
  }).compileToV0Message();

  return {
    base64Tx: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"),
    destination: built.destination.toBase58(),
    createsDestinationAccount: built.createsDestinationAccount,
  };
}

interface BuiltFeeInstructions {
  readonly instructions: TransactionInstruction[];
  readonly destination: PublicKey;
  readonly createsDestinationAccount: boolean;
}

function buildNativeFeeInstructions(
  owner: PublicKey,
  treasury: PublicKey,
  feeRaw: bigint,
): BuiltFeeInstructions {
  return {
    instructions: [
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury, lamports: feeRaw }),
    ],
    destination: treasury,
    createsDestinationAccount: false,
  };
}

async function buildSplFeeInstructions(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  treasury: PublicKey,
  feeRaw: bigint,
): Promise<BuiltFeeInstructions> {
  const tokenProgramId = await resolveMintTokenProgramId(connection, mint.toBase58());
  const source = deriveAssociatedTokenAccount(owner, mint, tokenProgramId);
  const destination = deriveAssociatedTokenAccount(treasury, mint, tokenProgramId);

  const destinationInfo = await connection.getAccountInfo(destination);
  const createsDestinationAccount = destinationInfo === null;

  const mintInfo = await getMint(connection, mint, undefined, tokenProgramId);

  // Solana's fee-on-transfer: a Token-2022 `TransferFeeConfig` means the
  // treasury would be credited LESS than we transfer, so booking `feeRaw` as
  // received would be false. Refuse rather than record a number that did not
  // happen — the caller treats a refused fee leg as missed revenue, never as a
  // bridge failure. Detected off the mint account we already fetched, so it
  // costs nothing extra.
  const transferFee = getTransferFeeConfig(mintInfo);
  if (transferFee !== null) {
    throw new VexError(
      ErrorCodes.SOLANA_TOKEN_NOT_FOUND,
      `Vex does not take a bridge fee from ${mint.toBase58()}: the mint carries a Token-2022 transfer fee, `
        + "so a treasury transfer would not deliver the stated amount.",
    );
  }

  const instructions: TransactionInstruction[] = [];
  if (createsDestinationAccount) {
    // Idempotent (same primitive as `jupiter-swaps/fee-swap.ts`): a concurrent
    // create between our read and our broadcast is a no-op, not a revert.
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, destination, treasury, mint, tokenProgramId),
    );
  }
  instructions.push(
    createTransferCheckedInstruction(
      source,
      mint,
      destination,
      owner,
      feeRaw,
      mintInfo.decimals,
      [],
      tokenProgramId,
    ),
  );

  return { instructions, destination, createsDestinationAccount };
}
