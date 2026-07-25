/**
 * Solana settlement decoding — turns a raw `getTransaction` (jsonParsed,
 * `maxSupportedTransactionVersion:0`) RPC response into owner+mint token
 * balance deltas for one `agent_activity` row (design `w5-design.md` §4/R3).
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
 * SPL + TOKEN-2022, UNIFORMLY: `preTokenBalances`/`postTokenBalances`
 * entries report `owner`/`mint`/`uiTokenAmount.amount` identically
 * regardless of which token program manages the mint — no program-id
 * branching is needed anywhere below.
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
 * ACCOUNT-INDEX RESOLUTION (versioned tx + address lookup tables): the
 * combined account-key list that `pre/postBalances` are indexed against is
 * the transaction's STATIC keys followed by `meta.loadedAddresses.writable`
 * then `meta.loadedAddresses.readonly`, in that order (the documented
 * `getTransaction` jsonParsed shape) — `resolveAccountKeys` reproduces this
 * ordering exactly; an unexpected/missing shape declines rather than guesses
 * an index.
 */

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";

// ── Parsed transaction (narrow, validated view of the raw RPC response) ─────

export interface ParsedSolanaTokenBalance {
  readonly owner: string;
  readonly mint: string;
  readonly amountRaw: string;
}

/** One `system` `transfer`/`transferWithSeed` effect. The DESTINATION is retained because a protocol-aware decoder classifies a transfer by who received it (design D3) — a landing tip and a SOL-wrap funding transfer are structurally identical otherwise. */
export interface SolanaNativeTransfer {
  readonly source: string;
  readonly destination: string;
  readonly lamports: number;
}

/** One `system` `createAccount`/`createAccountWithSeed` effect. The created ACCOUNT ADDRESS is retained so rent can be attributed only to accounts that survived the transaction (design D3/D5). */
export interface SolanaCreatedAccount {
  readonly source: string;
  readonly address: string;
  readonly lamports: number;
}

/**
 * System-program lamport-moving instruction effects collected from a tx
 * (top-level + inner instructions): the facts a native-SOL decode needs to
 * separate swap economics from fees, tips and rent. `null` (at the
 * `ParsedSolanaTransaction` field, not here) means "could not be reliably
 * read" — see the module doc.
 */
export interface SolanaNativeInstructionEvidence {
  readonly transfers: readonly SolanaNativeTransfer[];
  readonly accountCreations: readonly SolanaCreatedAccount[];
}

export interface ParsedSolanaTransaction {
  readonly err: unknown;
  readonly feeLamports: number;
  readonly accountKeys: readonly string[];
  readonly preBalancesLamports: readonly number[];
  readonly postBalancesLamports: readonly number[];
  readonly preTokenBalances: readonly ParsedSolanaTokenBalance[];
  readonly postTokenBalances: readonly ParsedSolanaTokenBalance[];
  /** `null` when top-level/inner instructions could not be reliably read — `decodeNativeSolDelta` must decline rather than assume no ambiguous transfer occurred. */
  readonly nativeInstructionEvidence: SolanaNativeInstructionEvidence | null;
}

/**
 * Validate + narrow a raw `getTransaction` (jsonParsed) RPC result. `null`
 * on ANY missing/malformed field this module depends on — the caller must
 * treat that identically to "cannot decode" (never guess a default).
 */
export function parseSolanaTransactionResult(raw: unknown): ParsedSolanaTransaction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as Record<string, unknown>;
  const meta = root.meta;
  if (typeof meta !== "object" || meta === null) return null;
  const metaRec = meta as Record<string, unknown>;

  const fee = metaRec.fee;
  if (typeof fee !== "number" || !Number.isFinite(fee)) return null;

  const preBalances = readNumberArray(metaRec.preBalances);
  const postBalances = readNumberArray(metaRec.postBalances);
  if (!preBalances || !postBalances) return null;

  const preTokenBalances = readTokenBalances(metaRec.preTokenBalances);
  const postTokenBalances = readTokenBalances(metaRec.postTokenBalances);
  if (!preTokenBalances || !postTokenBalances) return null;

  const accountKeys = resolveAccountKeys(root.transaction, metaRec.loadedAddresses);
  if (!accountKeys) return null;

  const nativeInstructionEvidence = collectNativeInstructionEvidence(root.transaction, metaRec.innerInstructions);

  return {
    err: metaRec.err ?? null,
    feeLamports: fee,
    accountKeys,
    preBalancesLamports: preBalances,
    postBalancesLamports: postBalances,
    preTokenBalances,
    postTokenBalances,
    nativeInstructionEvidence,
  };
}

function readNumberArray(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    out.push(entry);
  }
  return out;
}

function readTokenBalances(value: unknown): readonly ParsedSolanaTokenBalance[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: ParsedSolanaTokenBalance[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const rec = entry as Record<string, unknown>;
    const owner = rec.owner;
    const mint = rec.mint;
    const uiTokenAmount = rec.uiTokenAmount;
    if (typeof owner !== "string" || typeof mint !== "string") return null;
    if (typeof uiTokenAmount !== "object" || uiTokenAmount === null) return null;
    const amountRaw = (uiTokenAmount as Record<string, unknown>).amount;
    if (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)) return null;
    out.push({ owner, mint, amountRaw });
  }
  return out;
}

/** Static account keys + loaded-address-table writable/readonly, in the documented combined order. `null` on an unrecognized shape. */
function resolveAccountKeys(transaction: unknown, loadedAddresses: unknown): readonly string[] | null {
  if (typeof transaction !== "object" || transaction === null) return null;
  const message = (transaction as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const staticKeys = readPubkeyList((message as Record<string, unknown>).accountKeys);
  if (!staticKeys) return null;

  let writable: readonly string[] = [];
  let readonly_: readonly string[] = [];
  if (typeof loadedAddresses === "object" && loadedAddresses !== null) {
    const rec = loadedAddresses as Record<string, unknown>;
    const w = readStringArray(rec.writable);
    const r = readStringArray(rec.readonly);
    if (w) writable = w;
    if (r) readonly_ = r;
  }
  return [...staticKeys, ...writable, ...readonly_];
}

/** `message.accountKeys` in jsonParsed encoding is `{pubkey, signer, writable, source?}[]`; plain string[] is accepted too (legacy encoding fallback). */
function readPubkeyList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const pubkey = (entry as Record<string, unknown>).pubkey;
      if (typeof pubkey === "string") {
        out.push(pubkey);
        continue;
      }
    }
    return null;
  }
  return out;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

type SystemInstructionEffect =
  | { readonly kind: "transfer"; readonly transfer: SolanaNativeTransfer }
  | { readonly kind: "createAccount"; readonly creation: SolanaCreatedAccount }
  | { readonly kind: "irrelevant" };

/** Lamports are integers by definition; a non-integer/unsafe value is a malformed RPC payload, and `BigInt()` would THROW on it further down. Declining is the only honest answer. */
function readLamports(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads ONE parsed instruction entry (top-level or inner, jsonParsed
 * encoding). A non-`system`-program entry is irrelevant to native-SOL
 * netting and always safe to skip. A `system`-program entry present but NOT
 * in the expected `parsed.{type,info}` shape returns `null` — the caller
 * must treat that as "cannot prove no lamports moved," never as "skip it."
 */
function readSystemInstructionEffect(entry: unknown): SystemInstructionEffect | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  if (rec.program !== "system") return { kind: "irrelevant" };

  const parsed = rec.parsed;
  if (typeof parsed !== "object" || parsed === null) return null;
  const parsedRec = parsed as Record<string, unknown>;
  const info = parsedRec.info;
  if (typeof info !== "object" || info === null) return null;
  const infoRec = info as Record<string, unknown>;
  const source = infoRec.source;
  const lamports = readLamports(infoRec.lamports);

  if (parsedRec.type === "transfer" || parsedRec.type === "transferWithSeed") {
    const destination = infoRec.destination;
    if (typeof source !== "string" || typeof destination !== "string" || lamports === null) return null;
    return { kind: "transfer", transfer: { source, destination, lamports } };
  }
  if (parsedRec.type === "createAccount" || parsedRec.type === "createAccountWithSeed") {
    const address = infoRec.newAccount;
    if (typeof source !== "string" || typeof address !== "string" || lamports === null) return null;
    return { kind: "createAccount", creation: { source, address, lamports } };
  }
  // allocate/assign/withdrawNonceAccount/advanceNonceAccount/... never move
  // lamports out of an arbitrary funder in a way relevant to this netting.
  return { kind: "irrelevant" };
}

/**
 * Collects system-program transfer/createAccount effects from the tx's
 * top-level instructions AND every `meta.innerInstructions` group. `null`
 * when the instruction shape cannot be reliably read (present but not an
 * array, or an unparseable `system` entry) — see the module doc.
 */
function collectNativeInstructionEvidence(
  transaction: unknown,
  innerInstructions: unknown,
): SolanaNativeInstructionEvidence | null {
  if (typeof transaction !== "object" || transaction === null) return null;
  const message = (transaction as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;

  const entries: unknown[] = [];
  const topLevel = (message as Record<string, unknown>).instructions;
  if (topLevel !== undefined && topLevel !== null) {
    if (!Array.isArray(topLevel)) return null;
    entries.push(...topLevel);
  }
  if (innerInstructions !== undefined && innerInstructions !== null) {
    if (!Array.isArray(innerInstructions)) return null;
    for (const group of innerInstructions) {
      if (typeof group !== "object" || group === null) return null;
      const inner = (group as Record<string, unknown>).instructions;
      if (!Array.isArray(inner)) return null;
      entries.push(...inner);
    }
  }

  const transfers: SolanaNativeTransfer[] = [];
  const accountCreations: SolanaCreatedAccount[] = [];
  for (const entry of entries) {
    const effect = readSystemInstructionEffect(entry);
    if (effect === null) return null;
    if (effect.kind === "transfer") transfers.push(effect.transfer);
    else if (effect.kind === "createAccount") accountCreations.push(effect.creation);
  }
  return { transfers, accountCreations };
}

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
