/**
 * Mint owner-program detection + fee/treasury ATA derivation for the shared
 * Solana shelf (W5 design `w5-design.md` §6/R4: "Mint-owner-program
 * detection: decode the mint's owner program to derive the correct ATA (SPL
 * vs Token-2022); native SOL → WSOL path").
 *
 * A token account's address (and program) depends on which SPL token program
 * owns the MINT — the classic SPL Token program or Token-2022. Guessing wrong
 * derives an address nobody can ever create/see funds land in, so this module
 * reads the mint account's real on-chain owner instead of assuming.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { VexError, ErrorCodes } from "../../../errors.js";
import { SOL_MINT } from "./solana-constants.js";

/**
 * Resolve which SPL token program owns a mint. Native SOL (`SOL_MINT`, i.e.
 * the wSOL mint) is always the classic SPL Token program — short-circuited
 * without a network round-trip. Any other mint requires reading the account:
 * a missing account or an owner that is neither known token program is a
 * clear, fail-closed error (never a silent guess).
 */
export async function resolveMintTokenProgramId(
  connection: Connection,
  mint: string,
): Promise<PublicKey> {
  if (mint === SOL_MINT) return TOKEN_PROGRAM_ID;

  const mintPubkey = new PublicKey(mint);
  const info = await connection.getAccountInfo(mintPubkey);
  if (!info) {
    throw new VexError(
      ErrorCodes.SOLANA_TOKEN_NOT_FOUND,
      `Mint account not found on-chain: ${mint}`,
    );
  }
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;

  throw new VexError(
    ErrorCodes.SOLANA_TOKEN_NOT_FOUND,
    `Mint ${mint} is not owned by a known SPL token program.`,
  );
}

/**
 * Derive the associated token account for `owner` (a normal, on-curve wallet
 * — never a PDA, so `allowOwnerOffCurve` stays false) + `mint`, under the
 * given token program. Pure/sync — the caller already resolved the program.
 */
export function deriveAssociatedTokenAccount(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);
}
