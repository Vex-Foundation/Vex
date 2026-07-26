/**
 * Solana settlement decoding — turns a parsed `getTransaction` response into
 * the token/lamport deltas that prove one `agent_activity` row's executed
 * amounts (design `w5-design.md` §4/R3).
 *
 * REGISTERED-DECODER DOCTRINE (mirrors the EVM `settlement-decoders.ts`
 * pattern this repo already established): a "success" on-chain result is
 * NEVER enough on its own — this module NEVER GUESSES. A mint the caller asks
 * about that this transaction never touched, a malformed/unexpected RPC
 * shape, or (for `event_role='swap'`) a leg that cannot be proven all
 * decline the WHOLE decode (`null`) rather than return a partial/guessed
 * result — the caller (`solana-activity-repair.ts`) leaves the row `pending`
 * + escalates exactly like "no registered decoder" does in the EVM sweep.
 * `decodeSolanaBalanceSettlement` is deliberately PROTOCOL-AGNOSTIC (unlike
 * the EVM registry, keyed by `protocol` because each DEX's log layout
 * differs): it decodes a plain owner+mint balance delta for whichever mint(s)
 * the row itself names, so the SAME function is correct for every Solana
 * `chain_family` row this sweep's candidate set includes — Jupiter
 * lend/prediction rows (`protocol='jupiter'`) AND Solana `bridge_deposit`
 * legs (`protocol='khalani'`/`'relay'`, R3's "INCLUDING Solana bridge deposit
 * legs" correction) alike. It is the FALLBACK arm of
 * `solana-settlement-dispatch.ts`: a row carrying a validated settlement
 * profile is decoded by its own protocol-aware decoder instead (design
 * `solana-settlement-profile-design.md` D2), because no generic rule can tell
 * a landing tip or a SOL-wrap funding transfer apart from an unrelated
 * payment. Everything else still lands here, unchanged.
 *
 * SUMMED, NOT FIRST-MATCH: `preTokenBalances`/`postTokenBalances` can carry
 * MULTIPLE entries for the same owner+mint (a wallet holding more than one
 * token account for a mint, or a temporary WSOL account created/closed
 * in-instruction alongside a pre-existing one) — `decodeTokenBalanceDelta`
 * SUMS every matching entry per side rather than matching the first one, or
 * a real balance movement on a second/third account for the same owner+mint
 * would silently vanish from the computed delta.
 *
 * NATIVE SOL / WSOL: a Solana instruction may move value either as a genuine
 * WSOL SPL token-account balance (present in `pre/postTokenBalances` with
 * `mint===SOL_MINT`) or as native lamports at the wallet's OWN system
 * account (`pre/postBalances`) when SOL is wrapped/unwrapped in-instruction
 * — `decodeMintDelta` tries the token-balance path first and falls back to
 * the native-lamports path only for `SOL_MINT`. The native path nets out the
 * network fee (`meta.fee` — always known, always attributed to the
 * fee-payer, always index 0 of the combined account-key list per the Solana
 * transaction-message convention) AND rent lamports the wallet paid to fund
 * any account it created in this same transaction AND THAT SURVIVED it
 * (`system` program `createAccount`/`createAccountWithSeed` instructions,
 * top-level or inner — ATA-creation rent is never swap economics; see
 * `sumPersistentCreationRentLamports` for why survival is what matters). A
 * `system` `transfer`/
 * `transferWithSeed` instruction sourced from the wallet is DIFFERENT: it is
 * indistinguishable, by structure alone, from a landing-service tip, a
 * SOL-wrap funding transfer, or genuine swap proceeds — this module has no
 * protocol-specific fee contract to disambiguate it (K4 has not landed a
 * tested intent_params/routeProvenance contract for tip amounts as of this
 * card) — so its presence makes the WHOLE native-SOL delta decline (`null`)
 * rather than risk folding an unrelated payment into a reported executed
 * amount. Same "never guess" rule for a `system` instruction whose shape
 * cannot be read at all (unparseable jsonParsed entry): decline rather than
 * assume it carried no value.
 *
 * PARSING LIVES NEXT DOOR: validating a raw RPC response into
 * `ParsedSolanaTransaction` — including the combined account-key list every
 * `accountIndex` is resolved against — is `./solana-parsed-transaction.js`'s
 * job, re-exported below so this module stays the one import site callers
 * already use.
 */

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";

// ── Parsed transaction ────────────────────────────────────────────────────

// The raw-response parsing half (`ParsedSolanaTransaction` + every reader that
// validates one) moved MOVE-ONLY to the sibling `./solana-parsed-transaction.js`
// — a different reason to change (the RPC's response shape) from this file's
// money-reading rules, and the headroom the escrow-account binding needed under
// the 500-line cap. RE-EXPORTED here so every existing import site is unaffected.
export type {
  ParsedSolanaTokenBalance,
  ParsedSolanaTransaction,
  SolanaCreatedAccount,
  SolanaNativeInstructionEvidence,
  SolanaNativeTransfer,
} from "./solana-parsed-transaction.js";
export { parseSolanaTransactionResult } from "./solana-parsed-transaction.js";

import type { ParsedSolanaTokenBalance, ParsedSolanaTransaction } from "./solana-parsed-transaction.js";

// ── Mint-delta decode primitives ─────────────────────────────────────────

/**
 * Owner+mint token-balance delta (post − pre, raw smallest-unit integer),
 * SUMMED over every matching entry per side (a wallet can hold more than one
 * token account for the same mint). Account create/close within the tx is
 * handled by treating a missing side as zero. `null` when NEITHER side has
 * any entry for this owner+mint — the mint was never touched, so there is
 * nothing to prove.
 */
export function decodeTokenBalanceDelta(
  tx: ParsedSolanaTransaction,
  wallet: string,
  mint: string,
): bigint | null {
  const preMatches = tx.preTokenBalances.filter((b) => b.owner === wallet && b.mint === mint);
  const postMatches = tx.postTokenBalances.filter((b) => b.owner === wallet && b.mint === mint);
  if (preMatches.length === 0 && postMatches.length === 0) return null;
  const preAmount = preMatches.reduce((sum, b) => sum + BigInt(b.amountRaw), 0n);
  const postAmount = postMatches.reduce((sum, b) => sum + BigInt(b.amountRaw), 0n);
  return postAmount - preAmount;
}

/** One token ACCOUNT, identified by all three of its address, mint and owner. */
export interface SolanaTokenAccountRef {
  /** The account's own address — an ATA a caller DERIVED, not a value read out of the transaction. */
  readonly address: string;
  readonly mint: string;
  /** The account's expected owner. Checked as well as the address, so a caller cannot be handed a lookalike account. */
  readonly owner: string;
}

/**
 * Delta (post − pre) of ONE NAMED TOKEN ACCOUNT, resolved by `accountIndex`
 * against the transaction's combined account-key list. `null` when this
 * transaction has no balance entry for that account at all.
 *
 * WHY THIS EXISTS NEXT TO `decodeTokenBalanceDelta`. That function sums every
 * account an OWNER holds for a mint, which is right when the question is "how
 * much did this wallet's holding change" and WRONG when the question is "did
 * THIS account pay". A program-derived owner can hold more than one token
 * account for a mint, and anyone may create another one with that owner — so
 * an owner+mint match can be satisfied by an account the caller never derived
 * and never intended to accept. Where a proof depends on a specific derived
 * address, it must use this.
 *
 * FAILS CLOSED ON AN UNATTRIBUTABLE ENTRY: a balance entry matching the owner
 * and mint whose `accountIndex` is absent or does not resolve to a key makes
 * the WHOLE lookup decline, rather than being skipped — a skipped pre-balance
 * would turn a drain into an apparent credit.
 */
export function decodeTokenAccountDelta(
  tx: ParsedSolanaTransaction,
  account: SolanaTokenAccountRef,
): bigint | null {
  const sideTotal = (entries: readonly ParsedSolanaTokenBalance[]): { total: bigint; matched: boolean } | null => {
    let total = 0n;
    let matched = false;
    for (const entry of entries) {
      if (entry.mint !== account.mint || entry.owner !== account.owner) continue;
      if (entry.accountIndex === null) return null;
      const address = tx.accountKeys[entry.accountIndex];
      if (address === undefined) return null;
      if (address !== account.address) continue;
      total += BigInt(entry.amountRaw);
      matched = true;
    }
    return { total, matched };
  };

  const pre = sideTotal(tx.preTokenBalances);
  const post = sideTotal(tx.postTokenBalances);
  if (pre === null || post === null) return null;
  if (!pre.matched && !post.matched) return null;
  return post.total - pre.total;
}

/**
 * Native-lamport delta at the wallet's OWN account index, with the network
 * fee netted out (added back) when the wallet is the fee payer (always
 * combined-index 0 — the Solana transaction-message convention) AND rent the
 * wallet paid to fund any account it created in this same tx netted out too
 * (`system` `createAccount`/`createAccountWithSeed`, top-level or inner).
 * `null` when the wallet's pubkey is not present in the combined
 * account-key list, OR when instruction evidence could not be reliably
 * read, OR when the wallet sourced a `system` `transfer`/`transferWithSeed`
 * — that shape is indistinguishable from a landing-service tip / wrap
 * funding / genuine swap proceeds without a protocol-specific fee contract
 * this module does not have (see the module doc); declining here is the
 * "never confirm with inaccurate executed_* fields" rule in practice.
 */
export function decodeNativeSolDelta(tx: ParsedSolanaTransaction, wallet: string): bigint | null {
  const evidence = tx.nativeInstructionEvidence;
  if (evidence === null) return null;
  if (evidence.transfers.some((transfer) => transfer.source === wallet)) return null;

  const deltaNetOfFee = decodeWalletLamportDeltaNetOfFee(tx, wallet);
  if (deltaNetOfFee === null) return null;
  const rentAdjustment = sumPersistentCreationRentLamports(tx, wallet);
  if (rentAdjustment === null) return null;
  return deltaNetOfFee + rentAdjustment;
}

/**
 * The wallet's own lamport movement with the network fee added back when the
 * wallet is the fee payer (always combined-index 0 — the Solana
 * transaction-message convention). `null` when the wallet is not in the
 * combined account-key list, or its balances are not readable at that index.
 * NOT swap economics on its own: tips, wrap funding and rent are still inside
 * this number and every caller must account for them.
 */
export function decodeWalletLamportDeltaNetOfFee(tx: ParsedSolanaTransaction, wallet: string): bigint | null {
  const index = tx.accountKeys.indexOf(wallet);
  if (index < 0) return null;
  const pre = tx.preBalancesLamports[index];
  const post = tx.postBalancesLamports[index];
  if (pre === undefined || post === undefined) return null;
  const feeAdjustment = index === 0 ? BigInt(tx.feeLamports) : 0n;
  return BigInt(post) - BigInt(pre) + feeAdjustment;
}

/**
 * Rent the wallet funded in THIS transaction for accounts that SURVIVED it
 * (design D5). Rent for an account created and closed inside the same
 * transaction — exactly what wrapping native SOL into a temporary WSOL account
 * does — has ALREADY returned to the wallet by the time `postBalances` is
 * taken, so adding it back a second time would silently overstate the
 * economics by one rent-exempt minimum per wrap.
 *
 * Survival is read PROGRAM-AGNOSTICALLY from the transaction's own
 * post-balances: a created account whose post-balance is 0 did not survive (a
 * rent-exempt account can never legitimately end at zero lamports while it
 * exists). No token-program instruction parsing is needed, so this stays
 * correct for SPL, Token-2022 and any other program that closes an account.
 *
 * `null` when a created account cannot be located in the combined account-key
 * list — its survival is then unprovable, and an unprovable rent adjustment
 * makes the whole native decode a guess.
 */
export function sumPersistentCreationRentLamports(tx: ParsedSolanaTransaction, wallet: string): bigint | null {
  const evidence = tx.nativeInstructionEvidence;
  if (evidence === null) return null;

  let rent = 0n;
  for (const creation of evidence.accountCreations) {
    if (creation.source !== wallet) continue;
    const index = tx.accountKeys.indexOf(creation.address);
    if (index < 0) return null;
    const post = tx.postBalancesLamports[index];
    if (post === undefined) return null;
    if (post > 0) rent += BigInt(creation.lamports);
  }
  return rent;
}

/** `SOL_MINT` (the native-SOL sentinel Jupiter and the bridge intents both use) tries the WSOL token-balance path first, falling back to native lamports; any other mint is token-balance only. */
export function decodeMintDelta(tx: ParsedSolanaTransaction, wallet: string, mint: string): bigint | null {
  if (mint === SOL_MINT) {
    const tokenDelta = decodeTokenBalanceDelta(tx, wallet, mint);
    if (tokenDelta !== null) return tokenDelta;
    return decodeNativeSolDelta(tx, wallet);
  }
  return decodeTokenBalanceDelta(tx, wallet, mint);
}

// ── Per-role dispatch (the one generic Solana balance-delta decoder) ─────

/**
 * What a decoder PROVED about a landed transaction. Raw atomic magnitudes are
 * the proof; the `*Human` siblings are the same magnitudes rendered with the
 * row's own persisted decimals and are attached by the sweep
 * (`solana-activity-repair.ts`), not by a decoder — a decoder sees a
 * transaction, never the row's token metadata. They mirror the EVM sweep's
 * `DecodedSettlement` (`settlement-decoders.ts`), whose confirmed rows have
 * always carried both, so an agent reading a confirmed Solana row is not left
 * with a bare integer.
 */
export interface DecodedSolanaSettlement {
  readonly executedAmountInRaw?: string;
  readonly executedAmountInHuman?: string;
  readonly executedAmountOutRaw?: string;
  readonly executedAmountOutHuman?: string;
}

export interface SolanaSettlementDecodeInput {
  readonly parsedTransaction: ParsedSolanaTransaction;
  readonly eventRole: AgentActivityEventRole;
  readonly walletAddress: string;
  readonly tokenInAddress: string | null;
  readonly tokenOutAddress: string | null;
}

/**
 * `event_role='swap'` requires BOTH legs proven (044:134's confirmed-swap
 * invariant, restated by R3) — an undecodable leg declines the WHOLE result.
 * Every other role proves whichever of `tokenInAddress`/`tokenOutAddress` the
 * row actually names (at least one, matching the mint the row's own domain
 * write path recorded); a row naming neither declines (nothing to prove).
 */
export function decodeSolanaBalanceSettlement(
  input: SolanaSettlementDecodeInput,
): DecodedSolanaSettlement | null {
  const { parsedTransaction: tx, eventRole, walletAddress, tokenInAddress, tokenOutAddress } = input;

  if (eventRole === "swap") {
    if (!tokenInAddress || !tokenOutAddress) return null;
    const inDelta = decodeMintDelta(tx, walletAddress, tokenInAddress);
    const outDelta = decodeMintDelta(tx, walletAddress, tokenOutAddress);
    if (inDelta === null || outDelta === null) return null;
    return {
      executedAmountInRaw: absRaw(inDelta),
      executedAmountOutRaw: absRaw(outDelta),
    };
  }

  if (!tokenInAddress && !tokenOutAddress) return null;

  const result: { executedAmountInRaw?: string; executedAmountOutRaw?: string } = {};
  if (tokenInAddress) {
    const delta = decodeMintDelta(tx, walletAddress, tokenInAddress);
    if (delta === null) return null;
    result.executedAmountInRaw = absRaw(delta);
  }
  if (tokenOutAddress) {
    const delta = decodeMintDelta(tx, walletAddress, tokenOutAddress);
    if (delta === null) return null;
    result.executedAmountOutRaw = absRaw(delta);
  }
  return result;
}

/** Executed amounts are stored as unsigned raw magnitudes (direction is implied by `tokenInAddress` vs `tokenOutAddress`), matching the EVM sweep's convention. */
function absRaw(delta: bigint): string {
  return (delta < 0n ? -delta : delta).toString();
}
